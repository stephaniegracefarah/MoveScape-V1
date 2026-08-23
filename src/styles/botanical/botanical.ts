/**
 * Botanical style (spec Part 4, M4 rebuild): the experience MVP, rebuilt to
 * docs/styles/botanical.md. Tapered-stroke branches (not circle chains)
 * repeatedly fork into fine twigs, carrying dense gaussian-packed blossom
 * clusters in curated palette colors, on a warm paper background (see
 * ../../compositor/paper-ground.ts, wired in by main.ts/live-render-loop.ts).
 * One or two dominant root branches sweep left-to-right (the Scroll
 * composition, spec Part 3); pale depth echoes render the same kind of
 * growth further back in atmosphere. Marks are permanent ink (visual spec
 * section 7, decided 2026-08-22) -- nothing ever shrinks or is removed;
 * liveliness comes from a root periodically starting a new sibling branch
 * once its current one matures, not from anything disappearing. See
 * branch.ts/blossom.ts/palettes.ts
 * for the pure, independently-tested growth/wander/lifecycle/spawn/color
 * math this file wires together; this file owns the mutable state and the
 * StyleRenderer lifecycle (init/step/scene/finish).
 */
import type { MovementParams } from '../../adapters/movement-params';
import { INITIAL_SESSION_PARAMS, type SessionParams } from '../../engine/session-params';
import { clamp01 } from '../../shared/math';
import { createLabeledNoise } from '../../world/labeled-noise';
import { createLabeledStream } from '../../world/labeled-stream';
import type { World } from '../../world/world';
import type { Scene, SceneElement, SceneLayer, StyleRenderer } from '../style-renderer';
import {
  checkCrossedForks,
  computeChildBaseWidth,
  computeForkFractions,
  computeMatureDurationMs,
  computeTargetLength,
  spawnBranch,
  tickGrowing,
  type Branch,
} from './branch';
import { spawnBlossomCluster, type Blossom } from './blossom';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPalette } from './palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './tuning-config';

// --- World-knob range mappings (each documented at its own line; exact
// values are a first-pass, expected to get retuned after the static-render
// founder review -- see docs/HANDOFF.md). ---

const BRANCH_DENSITY_MIN = 15;
const BRANCH_DENSITY_SPAN = 45; // maxConcurrentBranches lands in [15, 60)

const GROWTH_RATE_MIN = 0.5;
const GROWTH_RATE_SPAN = 1.5; // baseGrowthRate lands in [0.5, 2.0)

const MATURE_DURATION_MIN = 3000;
const MATURE_DURATION_SPAN = 9000; // baseMatureDurationMs lands in [3000, 12000) ms

const ROOT_COUNT_MIN = 1;
const ROOT_COUNT_SPAN = 2; // rootCount lands in {1, 2} -- "one or two dominant structures" (visual spec section 6)

const BRANCH_SPREAD_MIN = 0.15;
const BRANCH_SPREAD_SPAN = 0.4; // branchSpreadBase lands in [0.15, 0.55) radians -- a tight cone around the rightward sweep, not a wide fan

const WANDER_AMPLITUDE_MIN = 0.02;
const WANDER_AMPLITUDE_SPAN = 0.13; // wanderAmplitudeBase lands in [0.02, 0.15) radians

// Session-level movement-mapping (new in M5): movementVariance (how much
// the session's energy has varied so far) gradually modulates wander
// amplitude on top of the world knob's own baseline -- a session that
// swings between stillness and bursts reads as more erratic/searching; a
// steady-paced session reads calmer. movementVariance's practical range is
// roughly [0, 0.25] (population variance of a 0-1-bounded signal maxes out
// at 0.25). First-pass scale factor, expected to be tuned live like every
// other Botanical constant (see docs/HANDOFF.md) -- not founder-specified.
const SESSION_VARIANCE_WANDER_SCALE = 2;

const BLOSSOMS_PER_CLUSTER_MIN = 25;
const BLOSSOMS_PER_CLUSTER_SPAN = 55; // blossomsPerCluster lands in [25, 80) -- visual spec section 3

// The Scroll composition (spec Part 3, docs/styles/botanical.md section 6):
// growth sweeps left to right, so roots originate near the left edge and
// aim rightward (0 rad = +x), not upward from a bottom band. Fixed (not a
// world knob) so "the reference sweeps horizontally" is a structural
// promise, not a per-day coin flip -- root placement (still per-seed) is
// where day-to-day variety comes from.
const COMPOSITION_SWEEP_ANGLE = 0;
const ROOT_X_MIN = 0.05;
const ROOT_X_SPAN = 0.2;

/** One independent growth system's own randomness namespace, z-offset, and opacity multiplier -- everything that makes a depth echo "the same kind of growth further back in atmosphere" rather than the main event. Fixed/not knob-configurable for this first pass (visual spec section 5). */
interface EchoConfig {
  systemId: string;
  zOffset: number;
  opacityMultiplier: number;
  rootCount: number;
  maxGenerationCap: number;
}
const ECHO_CONFIGS: EchoConfig[] = [
  { systemId: 'echo0', zOffset: 0.35, opacityMultiplier: 0.5, rootCount: 1, maxGenerationCap: 3 },
  { systemId: 'echo1', zOffset: 0.6, opacityMultiplier: 0.3, rootCount: 1, maxGenerationCap: 3 },
];

const FOREGROUND_SYSTEM_ID = 'fg';

// Pre-first-step() spawn spread default: no step() has run yet at init(),
// so root branches spawn using a neutral mid-range "current expansion".
const DEFAULT_EXPANSION_BEFORE_FIRST_STEP = 0.5;

const WORLD_KNOB_NAMES = [
  'paletteIndex',
  'branchDensity',
  'baseGrowthRate',
  'matureDurationMs',
  'windAngle',
  'rootCount',
  'branchSpreadBase',
  'wanderAmplitudeBase',
  'blossomsPerCluster',
] as const;

interface RootPoint {
  x: number;
  y: number;
  z: number;
  baseDirectionCenter: number;
}

/** A freshly-matured branch's whole blossom cluster, generated (and therefore fully decided, deterministically) all at once, but revealed into `GrowthSystemState.blossoms` a few at a time -- see revealPendingBlossoms. `blossoms` keeps its own already-generated members in their fixed generation order; `revealedCount` is how many of those are visible so far. */
interface PendingBlossomCluster {
  blossoms: Blossom[];
  revealedCount: number;
  /** Ms accumulated toward the next reveal (a leaky-bucket timer, not wall-clock -- advanced only by each tick's own dt). */
  revealTimerMs: number;
}

/** One independent growth system: its own roots/branches/blossoms/resprout counters. The foreground system(s) and each depth echo are each one of these, stepped identically. */
interface GrowthSystemState {
  systemId: string;
  roots: RootPoint[];
  branches: Branch[];
  blossoms: Blossom[];
  resproutCounters: Map<number, number>;
  pendingClusters: PendingBlossomCluster[];
}

function createEmptyGrowthSystem(systemId: string): GrowthSystemState {
  return { systemId, roots: [], branches: [], blossoms: [], resproutCounters: new Map(), pendingClusters: [] };
}

/**
 * The minimal shape computeBakeThreats/isSafeToBake need from a growth
 * system -- a structural subset of GrowthSystemState (which satisfies this
 * automatically, so callers pass state.foregroundSystems directly with no
 * cast, after mapping in `reachX`) kept separate so both functions stay
 * easily unit-testable with small hand-built fixtures instead of full
 * GrowthSystemState objects (resproutCounters/pendingClusters/roots/etc.
 * are irrelevant to this check). `reachX` is `branchMaxReachX(branch)` --
 * the branch's own full-path max-x, needed (see computeBakeThreats's own
 * doc comment) to resolve whether a MATURE branch is itself still blocked.
 */
export interface BakeSafetySystem {
  branches: { id: string; rootX: number; reachX: number; z: number; lifecycle: 'growing' | 'mature' }[];
}

/** One currently-live bake threat, as far as isSafeToBake needs to know about it: its own id (for the ancestor/descendant exclusion), its own z, and its own rootX (see computeBakeThreats's own doc comment for why rootX, not tipX/reachX, is the right quantity here). */
export interface BakeThreatEntry {
  id: string;
  z: number;
  rootX: number;
}

/**
 * Resolves every currently-live bake threat across every given system, into
 * one flat list -- generalized (session 018) from an earlier, too-narrow
 * version of this fix (`computeGrowingRootStartMinX`) that only tracked a
 * per-(systemId, rootIndex) lineage minimum among GROWING branches. Real
 * pixel-level evidence (a renderScene() vs live-compositor diff,
 * docs/HANDOFF.md session 018) showed the bug this guards against is NOT
 * bounded to different roots of the same system: a forked child gets its
 * own z jitter relative to its parent (spawnChildBranch's childZJitter), so
 * two SIBLING/COUSIN forked branches within the very same root's lineage
 * can end up with meaningfully different z and mature (bake) out of order
 * while physically overlapping -- the identical bug class, just one level
 * down from roots.
 *
 * A branch still GROWING is unconditionally a threat, exactly as in the
 * original root-level fix: it hasn't matured, so it can't have baked yet,
 * full stop. Each such entry's `rootX` (not a "how far has it grown"
 * frontier) is the quantity isSafeToBake actually needs: the live
 * compositor bakes a stroke whole, in one shot, only once it matures
 * (live-compositor.ts's drawStrokeElementFully bakes every segment from
 * index 0), covering its ENTIRE path from its own rootX (fixed at spawn,
 * never moves) onward -- a branch's CURRENT tipX while still growing says
 * nothing about that future bake. (An earlier version of the ORIGINAL
 * root-level fix tracked "max tipX reached by any mature branch" instead;
 * testing found it insufficient -- a fast, shallow forked child can mature
 * and report a generous tipX while its own slower, root-covering ancestor
 * is still growing and will still bake later, still covering the origin
 * region. Gating on growing branches' own rootX instead of mature
 * branches' tipX closed that gap.)
 *
 * A MATURE branch is only excluded from the threat list once it is itself
 * genuinely resolved safe -- NOT simply because `lifecycle === 'mature'`.
 * This is the critical correction session 018's own integration sweep found
 * (a third correction, alongside the two preserved from the original fix,
 * both documented above/in isSafeToBake): a mature branch can itself still
 * be BLOCKED, waiting on some farther, unrelated branch of its own -- and
 * while it waits, it hasn't baked yet either, so it remains exactly as much
 * a threat to nearer content as a still-growing branch does (once it
 * finally does bake, it'll cover its own full path from its own rootX
 * onward, same as any other branch). The ORIGINAL root-level fix's doc
 * comment claimed "a mature branch poses no threat at all... once mature it
 * either already baked or is baking THIS frame" -- true there only because
 * that fix's own scope (roots.length <= 1 skipped, only ever 2 roots tops)
 * structurally guaranteed a root's own farthest branch could never itself
 * be blocked by anything (nothing was ever farther than it within its own
 * skip-single-root-systems scope), so "mature" and "already resolved safe"
 * were always the same thing there. Branch-level generalization breaks that
 * guarantee -- z is now a continuum across arbitrarily many fork
 * generations, not a two-level hierarchy -- so "mature" alone no longer
 * implies "resolved."
 *
 * Resolving this requires knowing each mature branch's OWN safety before
 * deciding whether it belongs in the list other branches check against --
 * a mutual-dependency-shaped problem, solved here without recursion or any
 * persisted state by processing FARTHEST-FIRST: sort every branch (growing
 * and mature alike) by z descending, then walk in that order accumulating
 * `threats`. By the time any given mature branch is reached, every entry
 * already in `threats` is guaranteed to be farther than it (or, from an
 * ancestor/descendant, correctly excluded by isSafeToBake itself) and
 * already fully resolved -- so checking that branch's own safety against
 * the threats accumulated SO FAR is exactly correct, no forward references
 * needed. If it resolves safe, it's excluded (it bakes now, this pass,
 * correctly z-sorted alongside whatever else resolves safe in the same
 * pass -- live-compositor.ts's collectAndBakeBucket). If not, it's pushed
 * onto `threats` too, using its own `rootX` (not `reachX`) for the exact
 * same "will cover its full path once it finally does bake" reason growing
 * branches use `rootX` -- a mature-but-blocked branch's eventual bake is
 * just as complete as any other's.
 *
 * No branch anywhere (every system empty, a degenerate/test-fixture case)
 * simply means an empty threat list, so isSafeToBake finds nothing to gate
 * against for any candidate.
 */
export function computeBakeThreats(systems: BakeSafetySystem[], margin: number): BakeThreatEntry[] {
  const all = systems.flatMap((system) => system.branches);
  all.sort((a, b) => b.z - a.z); // farthest first, so every branch's own check sees only already-resolved farther entries

  const threats: BakeThreatEntry[] = [];
  for (const branch of all) {
    if (branch.lifecycle === 'growing') {
      threats.push({ id: branch.id, z: branch.z, rootX: branch.rootX });
      continue;
    }
    const resolvedSafe = isSafeToBake({ id: branch.id, z: branch.z, tipX: branch.reachX, threats, margin });
    if (!resolvedSafe) {
      threats.push({ id: branch.id, z: branch.z, rootX: branch.rootX });
    }
  }
  return threats;
}

const CHILD_PATH_SEPARATOR_CHAR_CODE = 47; // '/'

/**
 * True iff `a` and `b` are the same branch, or one is a direct ancestor of
 * the other in the fork lineage -- a forked child's id is always
 * `${parent.id}/child${n}` (spawnChildBranch), all the way down, so
 * ancestry is exactly the id-prefix relationship. Exported for direct unit
 * testing (this exclusion is the single most important thing this file
 * gets right or wrong -- see isSafeToBake's own doc comment for why).
 *
 * Written to avoid ever allocating a concatenated string (equivalent to,
 * but deliberately not written as, `b.startsWith(a + '/')` /
 * `a.startsWith(b + '/')`) -- computeBakeThreats calls this up to O(k^2)
 * times per tick (k = currently-unresolved branch count), and profiling a
 * long (2000-tick) session found the naive concatenating version alone
 * responsible for multi-second slowdowns purely from allocation/GC churn,
 * not the underlying comparison logic -- a real, measured perf regression
 * this fix's own long-running tests caught, not a micro-optimization taken
 * on faith.
 */
export function isAncestorOrDescendant(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.length > a.length && b.charCodeAt(a.length) === CHILD_PATH_SEPARATOR_CHAR_CODE && b.startsWith(a)) return true;
  if (a.length > b.length && a.charCodeAt(b.length) === CHILD_PATH_SEPARATOR_CHAR_CODE && a.startsWith(b)) return true;
  return false;
}

/**
 * The bake-order safety check (docs/HANDOFF.md, cross-root paint-order bug
 * and its session-018 generalization): a piece of content -- a branch going
 * `final`, or a blossom about to be revealed -- at (id, z, tipX) is safe to
 * permanently bake into the live compositor's persistent buffer only if, for
 * every entry in the given resolved `threats` list (see computeBakeThreats
 * -- every still-growing branch, PLUS every mature-but-still-blocked one)
 * that is currently FARTHER (larger z -- nearer-z content painting over
 * farther-z content is already correct, expected behavior) and NOT in a
 * direct ancestor/descendant relationship with this content, that threat's
 * own start point (`rootX`) is strictly beyond this content's own x position
 * plus `margin` -- see computeBakeThreats's own doc comment for why a
 * threat's OWN start point, not how far anything has grown, is what
 * actually determines future bake-order risk.
 *
 * This is BRANCH-level, not root-level (generalized from the original fix,
 * which only ever compared different roots of the same system): real
 * pixel-level evidence showed the same overwrite bug happens between
 * sibling/cousin forked branches within a single root's own lineage too --
 * forking gives each child its own z jitter relative to its parent
 * (spawnChildBranch's childZJitter), with no guarantee a nearer-z cousin
 * matures before a farther-z one, even when they never span more than one
 * root. So every live threat across every foreground system is a potential
 * threat to every other piece of content, full stop -- EXCEPT its own
 * ancestors/descendants, per the exclusion below.
 *
 * The ancestor/descendant exclusion is required, not optional -- without
 * it, this function would deadlock every branch that ever forks. A forked
 * child's id is always `${parent.id}/child${n}` (spawnChildBranch), and it
 * spawns at the parent's CURRENT tip (`rootX: parent.tipX`) -- meaning a
 * child's own rootX always falls somewhere along its own parent's already-
 * grown path, by construction. Left unexcluded, a branch would always see
 * its own still-growing child as a threat (the child's rootX will always
 * satisfy "rootX <= parent's own reach + margin", since it forked from a
 * point on that very path), permanently blocking that branch from ever
 * going final for as long as it keeps producing children -- likely forever
 * in practice. `isAncestorOrDescendant` (id-prefix check) is exactly what
 * excludes this: a branch's own lineage can never threaten itself, only
 * genuinely unrelated siblings/cousins/other roots can.
 *
 * (Resprouts at the same root are not a source of new risk here, and don't
 * need special-casing: spawnRootBranch always uses `z: root.z` -- the
 * root's own fixed z, never jittered per-resprout -- so two different
 * resprouts of the same root can never have different z, and thus can
 * never threaten each other. `childZJitter` at fork points is the only
 * source of z variation within one root's lineage.)
 *
 * An empty `threats` list (every branch already resolved safe, or a
 * degenerate/test-fixture system with no branches at all) simply means
 * this loop finds nothing to gate against, so the content is safe.
 */
export function isSafeToBake(args: {
  id: string;
  z: number;
  tipX: number;
  threats: BakeThreatEntry[];
  margin: number;
}): boolean {
  for (const entry of args.threats) {
    if (entry.z <= args.z) continue; // only a FARTHER threat can later paint over this content
    if (isAncestorOrDescendant(entry.id, args.id)) continue; // own lineage can never threaten itself
    if (entry.rootX <= args.tipX + args.margin) return false;
  }
  return true;
}

/**
 * Bundles everything isSafeToBake needs about the current foreground state
 * -- computed once per tick (stepState, for blossom-reveal gating) or once
 * per scene emission (buildScene/buildSceneLayers, for stroke finality
 * gating), then threaded down to each individual branch's or blossom's own
 * isSafeToBake call rather than recomputed per-element. `threats` is always
 * built from `state.foregroundSystems` via computeBakeThreats -- echoes are
 * each their own separate compositor bucket (live-compositor.ts's
 * bucketFor), so they neither need this check applied to them nor
 * participate as a threat in anyone else's check (see stepState/buildScene:
 * echo calls pass `undefined` for this instead of a BakeSafety).
 */
interface BakeSafety {
  threats: BakeThreatEntry[];
  margin: number;
}

/**
 * Resolves bake-order safety for every currently UNRESOLVED branch (still
 * `growing`, or `mature` but not yet `bakeResolved`) across all foreground
 * systems, permanently marking `branch.bakeResolved = true` on each mature
 * one that newly resolves safe (see Branch.bakeResolved's own doc comment
 * for why this is safe to never revisit), and returns the resulting
 * threats list (every entry still open -- growing, or mature-and-still-
 * blocked) for blossom-reveal gating this same tick.
 *
 * PERFORMANCE, not just correctness (session 018's third correction, found
 * the same way as the other two -- by testing, not assumed up front): this
 * is deliberately NOT "call computeBakeThreats over every branch, every
 * tick." `system.branches` only ever grows for the life of a session
 * (permanent ink, docs/styles/botanical.md section 7) -- feeding computeBake
 * Threats's O(n log n + n^2) resolution pass (n = branch count) the FULL
 * cumulative branch history every single tick would reintroduce exactly the
 * unbounded-per-frame-cost shape this project has explicitly guarded
 * against before (docs/HANDOFF.md session 013's frame-rate-collapse fix;
 * the "Option 1" full-bucket-rebuild false start this fix's own predecessor
 * retracted for the identical reason). The first version of this
 * generalization did exactly that and made two long-running tests
 * (unrelated to this fix -- "bounded branch/element count" and the
 * growth-plateau hand-off determinism check, both running thousands of
 * ticks) time out.
 *
 * The fix: once a branch resolves safe, it has effectively already baked,
 * permanently, correctly ordered -- nothing that happens later can ever
 * retroactively make an already-baked bake unsafe, so it can be permanently
 * excluded from every future tick's input set (the `!branch.bakeResolved`
 * filter below). This bounds each call's real work to "branches still
 * growing or still blocked right now," which -- like `maxConcurrentBranches`
 * itself -- stays roughly constant regardless of how long the session has
 * run, instead of scaling with the session's entire history.
 */
function resolveBakeThreats(state: BotanicalState): BakeSafety {
  const margin = state.tuning.crossRootBakeSafetyMargin;
  const systems: BakeSafetySystem[] = state.foregroundSystems.map((system) => ({
    branches: system.branches
      .filter((branch) => branch.lifecycle === 'growing' || !branch.bakeResolved)
      .map((branch) => ({
        id: branch.id,
        rootX: branch.rootX,
        reachX: branchMaxReachX(branch),
        z: branch.z,
        lifecycle: branch.lifecycle,
      })),
  }));
  const threats = computeBakeThreats(systems, margin);
  const stillBlockedIds = new Set(threats.map((t) => t.id));
  for (const system of state.foregroundSystems) {
    for (const branch of system.branches) {
      if (branch.lifecycle === 'mature' && !branch.bakeResolved && !stillBlockedIds.has(branch.id)) {
        branch.bakeResolved = true;
      }
    }
  }
  return { threats, margin };
}

/** True if the next not-yet-revealed blossom in `pending` (if any) is safe to reveal right now per the bake-order safety check -- `safety === undefined` (echo systems, which never need this check) always returns true. The blossom's own "id" for the ancestor/descendant exclusion is its owning branch's id (`branchId`) -- a blossom is never a threat to its own owning branch's lineage, same logic as a branch never threatening its own lineage. */
function isNextBlossomSafe(pending: PendingBlossomCluster, safety: BakeSafety | undefined): boolean {
  if (safety === undefined) return true;
  const next = pending.blossoms[pending.revealedCount]!;
  return isSafeToBake({
    id: next.branchId,
    z: next.z,
    tipX: next.x,
    threats: safety.threats,
    margin: safety.margin,
  });
}

/**
 * Advances every not-yet-fully-revealed cluster's leaky-bucket timer by an
 * effective dt (dt scaled by how fast the user is actually moving, same
 * speedFloor-scaled shape as branch growth's growthStepFor in branch.ts) and
 * moves any newly-due blossoms from `pending.blossoms` into `system.blossoms`
 * (the array buildScene/emitGrowthSystem actually reads). A pure function of
 * the tick's own dt and recorded speed -- zero wall-clock dependency, so the
 * determinism invariant still holds: same recorded speed + dt sequence,
 * same result, live or replay (invariant 4). A cluster's own blossoms were
 * already fully generated, in a fixed order, the instant its branch matured
 * (spawnBlossomsFor); this only paces when each already-decided blossom
 * starts rendering, so no new randomness is introduced here and reveal order
 * is itself deterministic.
 *
 * A blossom that is otherwise due (the timer condition holds) but not yet
 * safe to bake per isNextBlossomSafe (bake-order safety check) is left
 * pending: the timer is NOT decremented and the blossom is NOT pushed, so
 * `revealTimerMs` keeps accumulating (already incremented this tick, above
 * the while loop) and gets rechecked next tick without losing progress or
 * double-counting. `safety === undefined` (echo systems) skips this check
 * entirely, reproducing the pre-fix behavior exactly.
 */
function revealPendingBlossoms(
  system: GrowthSystemState,
  dt: number,
  intervalMs: number,
  speed: number,
  speedFloor: number,
  safety: BakeSafety | undefined,
): void {
  const effectiveDt = dt * (speedFloor + speed * (1 - speedFloor));
  let anyFullyRevealed = false;
  for (const pending of system.pendingClusters) {
    if (pending.revealedCount >= pending.blossoms.length) {
      anyFullyRevealed = true;
      continue;
    }
    pending.revealTimerMs += effectiveDt;
    while (
      pending.revealTimerMs >= intervalMs &&
      pending.revealedCount < pending.blossoms.length &&
      isNextBlossomSafe(pending, safety)
    ) {
      system.blossoms.push(pending.blossoms[pending.revealedCount]!);
      pending.revealedCount++;
      pending.revealTimerMs -= intervalMs;
    }
    if (pending.revealedCount >= pending.blossoms.length) anyFullyRevealed = true;
  }
  // Prune fully-drained entries so pendingClusters doesn't grow unboundedly
  // over a long session -- safe since a fully-revealed entry does nothing
  // further (permanent ink: its blossoms already live in system.blossoms
  // forever, same as everything else).
  if (anyFullyRevealed) {
    system.pendingClusters = system.pendingClusters.filter((p) => p.revealedCount < p.blossoms.length);
  }
}

/** The Nth foreground system's id: 'fg0', 'fg1', ... -- see maybeSpawnNextForegroundSystem. */
const foregroundSystemId = (index: number): string => `${FOREGROUND_SYSTEM_ID}${index}`;

/**
 * Everything the StyleRenderer factory mutates over a session, held in one
 * place so a test-only entry point can reach in directly (see
 * createBotanicalInternal below) without widening StyleRenderer's own
 * public interface.
 */
export interface BotanicalState {
  sessionSeed: string;
  /** Ordered list of foreground growth systems -- normally length 1, growing to 2+ when an earlier system fills its maxConcurrentBranches budget and a successor picks up the sweep (see maybeSpawnNextForegroundSystem). Rendered/stepped identically and in order, oldest first. */
  foregroundSystems: GrowthSystemState[];
  echoes: GrowthSystemState[];
  latestParams: MovementParams | undefined;
  latestSessionParams: SessionParams;

  /** Resolved once at renderer creation -- DEFAULT_BOTANICAL_TUNING_CONFIG merged with any caller-supplied partial override, constant for the renderer's whole lifetime. */
  tuning: BotanicalTuningConfig;
  /** Resolved once at init() from the paletteIndex world knob. */
  palette: BotanicalPalette;

  maxConcurrentBranches: number;
  baseGrowthRate: number;
  baseGrowthPerTick: number;
  baseMatureDurationMs: number;
  windAngle: number;
  rootCount: number;
  branchSpreadBase: number;
  wanderAmplitudeBase: number;
  blossomsPerCluster: number;
}

function createEmptyState(tuning: BotanicalTuningConfig): BotanicalState {
  return {
    sessionSeed: '',
    foregroundSystems: [],
    echoes: ECHO_CONFIGS.map((cfg) => createEmptyGrowthSystem(cfg.systemId)),
    latestParams: undefined,
    latestSessionParams: INITIAL_SESSION_PARAMS,
    tuning,
    palette: BOTANICAL_PALETTE_PRESETS[0]!,
    maxConcurrentBranches: 0,
    baseGrowthRate: 0,
    baseGrowthPerTick: 0,
    baseMatureDurationMs: 0,
    windAngle: 0,
    rootCount: 0,
    branchSpreadBase: 0,
    wanderAmplitudeBase: 0,
    blossomsPerCluster: 0,
  };
}

function currentExpansion(state: BotanicalState): number {
  return state.latestParams?.expansion ?? DEFAULT_EXPANSION_BEFORE_FIRST_STEP;
}

/** Draws forkFractions for a freshly-spawned branch: count from tuning's fork-count range, jittered spacing via computeForkFractions. */
function drawForkFractions(state: BotanicalState, id: string): number[] {
  const countDraw = createLabeledStream(state.sessionSeed, `${id}:forkCount`)();
  const count = Math.floor(state.tuning.forkCountMin + countDraw * state.tuning.forkCountSpan);
  const jitterStream = createLabeledStream(state.sessionSeed, `${id}:forkJitter`);
  const jitterDraws = Array.from({ length: count }, () => jitterStream());
  return computeForkFractions(count, jitterDraws, state.tuning);
}

/** Draws every field for a fresh generation-0 branch at `rootIndex` in `system`, and returns it (not yet pushed). `systemId` namespaces this system's labeled streams so the foreground system and each depth echo draw independent randomness even at the same rootIndex/counter. */
function spawnRootBranch(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  rootIndex: number,
): Branch {
  // rootIndex always comes from a valid range (0..rootCount-1, or a
  // resprouting branch's own already-set branch.rootIndex, which always
  // originated from one of those), so this is always defined.
  const root = system.roots[rootIndex]!;
  const counter = system.resproutCounters.get(rootIndex) ?? 0;
  system.resproutCounters.set(rootIndex, counter + 1);
  const id = `${systemId}:root${rootIndex}:${counter}`;

  const spread = state.branchSpreadBase * (0.4 + 0.6 * currentExpansion(state));
  const directionDraw = createLabeledStream(state.sessionSeed, `${id}:spawnDirection`)();
  const baseDirection = root.baseDirectionCenter + (directionDraw * 2 - 1) * spread;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${id}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, 0, state.tuning);

  const colorDraw = createLabeledStream(state.sessionSeed, `${id}:color`)();
  const color = state.palette.branchColors[Math.floor(colorDraw * state.palette.branchColors.length)]!;

  const widthDraw = createLabeledStream(state.sessionSeed, `${id}:width`)();
  const baseWidth = state.tuning.branchBaseWidthMin + widthDraw * state.tuning.branchBaseWidthSpan;

  const sweepDraw = createLabeledStream(state.sessionSeed, `${id}:sweepTarget`)();
  const sweepTarget = COMPOSITION_SWEEP_ANGLE + (sweepDraw * 2 - 1) * state.tuning.rootBaseDirectionSpread;

  return spawnBranch({
    id,
    generation: 0,
    rootIndex,
    z: root.z,
    color,
    rootX: root.x,
    rootY: root.y,
    baseDirection,
    targetLength,
    sweepTarget,
    baseWidth,
    forkFractions: drawForkFractions(state, id),
  });
}

/** Draws every field for a fresh sub-branch child forking off `parent` at its current tip, `childIndex` disambiguating multiple children forking off the same parent at different fork points. */
function spawnChildBranch(state: BotanicalState, parent: Branch, childIndex: number): Branch {
  const childId = `${parent.id}/child${childIndex}`;

  const zJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:zJitter`)();
  const z = clamp01(parent.z + (zJitterDraw * 2 - 1) * state.tuning.childZJitter);

  const colorDraw = createLabeledStream(state.sessionSeed, `${childId}:color`)();
  const color = state.palette.branchColors[Math.floor(colorDraw * state.palette.branchColors.length)]!;

  const generation = parent.generation + 1;

  // Direction inherits the parent's current direction (at the fork point) +/-
  // a jittered magnitude, per docs/styles/botanical.md section 2 -- not
  // modulated by expansion/branchSpreadBase, which are root-spawn-only knobs.
  const magnitudeDraw = createLabeledStream(state.sessionSeed, `${childId}:directionMagnitude`)();
  const signDraw = createLabeledStream(state.sessionSeed, `${childId}:directionSign`)();
  const magnitude = state.tuning.childDirectionJitterMin + magnitudeDraw * state.tuning.childDirectionJitterSpan;
  const sign = signDraw < 0.5 ? -1 : 1;
  const baseDirection = parent.direction + sign * magnitude;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${childId}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, generation, state.tuning);

  const baseWidth = computeChildBaseWidth(parent.baseWidth, state.tuning);

  // Small jitter around the parent's own sweepTarget, so a child still
  // trends toward the same overall composition sweep as its parent even
  // after forking off at a wide angle.
  const sweepJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:sweepTarget`)();
  const sweepTarget = parent.sweepTarget + (sweepJitterDraw * 2 - 1) * 0.15;

  return spawnBranch({
    id: childId,
    generation,
    rootIndex: parent.rootIndex,
    z,
    color,
    rootX: parent.tipX,
    rootY: parent.tipY,
    baseDirection,
    targetLength,
    sweepTarget,
    baseWidth,
    forkFractions: drawForkFractions(state, childId),
  });
}

/**
 * Movement mapping (visual spec section 7): "expansion maps to spread/reach
 * of new growth and cluster size." A cluster spawns at the moment its owning
 * branch matures, so the CURRENT tick's expansion (not a session-average or
 * the value at spawn-time root placement) is what should size it -- a
 * branch that matures during an expansive movement gets a bigger cluster
 * than one that matures during a contained movement, else identical.
 * expansion=0.5 (this file's own pre-first-step default) reproduces exactly
 * `state.blossomsPerCluster`, so the world knob's own mapped range stays
 * the meaningful "baseline size" even though every real cluster varies
 * around it.
 */
function expansionScaledClusterCount(state: BotanicalState): number {
  return Math.round(state.blossomsPerCluster * (0.5 + currentExpansion(state)));
}

function spawnBlossomsFor(state: BotanicalState, branch: Branch): Blossom[] {
  const draw = createLabeledStream(state.sessionSeed, `${branch.id}:blossoms`);
  return spawnBlossomCluster({
    branchId: branch.id,
    rootIndex: branch.rootIndex,
    segments: branch.segments,
    count: expansionScaledClusterCount(state),
    paletteColors: state.palette.colors,
    z: branch.z,
    draw,
    tuning: state.tuning,
  });
}

function initGrowthSystem(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  rootCount: number,
): void {
  system.resproutCounters = new Map();
  system.roots = [];
  system.branches = [];
  system.blossoms = [];
  system.pendingClusters = [];

  // Root points: drawn once, sequentially, from a single system-level
  // stream (not per-root streams) -- spec Part 4's documented init order.
  const rootsDraw = createLabeledStream(state.sessionSeed, `${systemId}:roots`);
  for (let i = 0; i < rootCount; i++) {
    const x = ROOT_X_MIN + rootsDraw() * ROOT_X_SPAN;
    const y = state.tuning.rootYMin + rootsDraw() * state.tuning.rootYSpan;
    const zJitter = rootsDraw();
    const dirJitter = rootsDraw();
    const z = clamp01((i + zJitter) / rootCount);
    const baseDirectionCenter = COMPOSITION_SWEEP_ANGLE + (dirJitter * 2 - 1) * state.tuning.rootBaseDirectionSpread;

    system.roots.push({ x, y, z, baseDirectionCenter });
    system.resproutCounters.set(i, 0);
    system.branches.push(spawnRootBranch(state, system, systemId, i));
  }
}

/** Advances one growth system one tick: growth/wander/fork-crossing/lifecycle for every branch, exactly mirroring the pre-rebuild single-system stepState, just parametrized so the foreground system and each depth echo can all run through the same logic independently. Nothing is ever removed from `system.branches`/`system.blossoms` (permanent ink, docs/styles/botanical.md section 7) -- this function only ever appends. */
function stepGrowthSystem(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  params: MovementParams,
  dt: number,
  maxGenerationForSystem: number,
  bakeSafety: BakeSafety | undefined,
): void {
  const newBranches: Branch[] = [];
  const liveCount = () => system.branches.length + newBranches.length;

  const effectiveWanderAmplitudeBase =
    state.wanderAmplitudeBase * (1 + state.latestSessionParams.movementVariance * SESSION_VARIANCE_WANDER_SCALE);

  for (const branch of system.branches) {
    if (branch.lifecycle === 'growing') {
      const previousGrownLength = branch.grownLength;
      const noise01 = createLabeledNoise(state.sessionSeed, `${branch.id}:wander`)(
        branch.grownLength * state.tuning.curvatureNoiseScale,
      );
      const becameMature = tickGrowing(branch, {
        dt,
        speed: params.speed,
        symmetry: params.symmetry,
        expansion: params.expansion,
        windAngle: state.windAngle,
        noise01,
        baseGrowthPerTick: state.baseGrowthPerTick,
        wanderAmplitudeBase: effectiveWanderAmplitudeBase,
        tuning: state.tuning,
      });

      if (branch.generation < maxGenerationForSystem) {
        const crossedForkIndices = checkCrossedForks(branch, previousGrownLength);
        for (const forkIndex of crossedForkIndices) {
          if (liveCount() < state.maxConcurrentBranches) {
            newBranches.push(spawnChildBranch(state, branch, forkIndex));
          }
        }
      }

      if (becameMature) {
        branch.lifecycle = 'mature';
        branch.lifecycleTimer = 0;
        const jitterDraw = createLabeledStream(state.sessionSeed, `${branch.id}:matureDuration`)();
        branch.matureDurationMs = computeMatureDurationMs(state.baseMatureDurationMs, jitterDraw);
        // The cluster's full membership is decided right here, deterministically,
        // in a fixed order -- only *when* each of these already-generated
        // blossoms starts rendering is staggered (revealPendingBlossoms below).
        system.pendingClusters.push({ blossoms: spawnBlossomsFor(state, branch), revealedCount: 0, revealTimerMs: 0 });
      }
    } else {
      // mature -- permanent (docs/styles/botanical.md section 7's "marks are
      // permanent ink": no shrink, no removal, ever). A generation-0 branch's
      // timer instead triggers front-driven new growth: once matureDurationMs
      // elapses, a new sibling spawns at the same root (subject to the same
      // maxConcurrentBranches cap that already gates forking) and the timer
      // resets, so a root keeps producing fresh growth for the life of the
      // session rather than going still. Forked (generation > 0) branches
      // just carry an unused timer once mature -- only roots resprout.
      branch.lifecycleTimer += dt;

      if (branch.lifecycleTimer >= branch.matureDurationMs) {
        branch.lifecycleTimer = 0;
        if (branch.generation === 0 && liveCount() < state.maxConcurrentBranches) {
          newBranches.push(spawnRootBranch(state, system, systemId, branch.rootIndex));
        }
      }
    }
  }

  if (newBranches.length > 0) {
    system.branches.push(...newBranches);
  }

  revealPendingBlossoms(
    system,
    dt,
    state.tuning.blossomRevealIntervalMs,
    params.speed,
    state.tuning.blossomRevealSpeedFloor,
    bakeSafety,
  );
}

function initState(state: BotanicalState, world: World): void {
  state.sessionSeed = world.sessionSeed;

  const paletteIndexRaw = world.knob('paletteIndex');
  const branchDensityRaw = world.knob('branchDensity');
  const baseGrowthRateRaw = world.knob('baseGrowthRate');
  const matureDurationRaw = world.knob('matureDurationMs');
  const windAngleRaw = world.knob('windAngle');
  const rootCountRaw = world.knob('rootCount');
  const branchSpreadBaseRaw = world.knob('branchSpreadBase');
  const wanderAmplitudeBaseRaw = world.knob('wanderAmplitudeBase');
  const blossomsPerClusterRaw = world.knob('blossomsPerCluster');

  const paletteIndex = Math.min(
    BOTANICAL_PALETTE_PRESETS.length - 1,
    Math.floor(paletteIndexRaw * BOTANICAL_PALETTE_PRESETS.length),
  );
  state.palette = BOTANICAL_PALETTE_PRESETS[paletteIndex]!;

  state.maxConcurrentBranches = BRANCH_DENSITY_MIN + Math.floor(branchDensityRaw * BRANCH_DENSITY_SPAN);
  state.baseGrowthRate = GROWTH_RATE_MIN + baseGrowthRateRaw * GROWTH_RATE_SPAN;
  state.baseGrowthPerTick = state.baseGrowthRate * state.tuning.baseGrowthScale;
  state.baseMatureDurationMs = MATURE_DURATION_MIN + matureDurationRaw * MATURE_DURATION_SPAN;
  state.windAngle = windAngleRaw * Math.PI * 2;
  state.rootCount = ROOT_COUNT_MIN + Math.floor(rootCountRaw * ROOT_COUNT_SPAN);
  state.branchSpreadBase = BRANCH_SPREAD_MIN + branchSpreadBaseRaw * BRANCH_SPREAD_SPAN;
  state.wanderAmplitudeBase = WANDER_AMPLITUDE_MIN + wanderAmplitudeBaseRaw * WANDER_AMPLITUDE_SPAN;
  state.blossomsPerCluster = BLOSSOMS_PER_CLUSTER_MIN + Math.floor(blossomsPerClusterRaw * BLOSSOMS_PER_CLUSTER_SPAN);

  state.latestParams = undefined;
  state.foregroundSystems = [createEmptyGrowthSystem(foregroundSystemId(0))];
  state.echoes = ECHO_CONFIGS.map((cfg) => createEmptyGrowthSystem(cfg.systemId));

  initGrowthSystem(state, state.foregroundSystems[0]!, foregroundSystemId(0), state.rootCount);
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    initGrowthSystem(state, state.echoes[i]!, echoConfig.systemId, echoConfig.rootCount);
  });
}

/**
 * Once the currently-active (last) foreground system fills its
 * maxConcurrentBranches budget, spawns a successor that continues the sweep
 * seamlessly rather than raising or sharing the cap (docs/HANDOFF.md,
 * growth-plateau fix folded into M5 Stage 3). "Seamless" is the whole
 * requirement: the new system's one starting root is placed exactly at the
 * old system's growth front -- the branch with the largest tipX, i.e. the
 * one that has traveled furthest along the rightward sweep -- not at a fresh
 * random position, so the hand-off reads as the same tree continuing rather
 * than a new wave starting elsewhere on the canvas.
 *
 * Self-limiting by construction: a freshly-appended successor starts with
 * exactly 1 branch, far under maxConcurrentBranches's minimum of 15, so it
 * becomes the new "last" system and the very next tick's check on it
 * immediately returns false. No extra "already spawned" flag is needed.
 */
function maybeSpawnNextForegroundSystem(state: BotanicalState): void {
  const last = state.foregroundSystems[state.foregroundSystems.length - 1]!;
  if (last.branches.length < state.maxConcurrentBranches) return;

  const frontier = last.branches.reduce((furthest, branch) => (branch.tipX > furthest.tipX ? branch : furthest));

  const newSystemId = foregroundSystemId(state.foregroundSystems.length);
  const dirJitter = createLabeledStream(state.sessionSeed, `${newSystemId}:handoffDirection`)();
  const baseDirectionCenter = COMPOSITION_SWEEP_ANGLE + (dirJitter * 2 - 1) * state.tuning.rootBaseDirectionSpread;

  const root: RootPoint = { x: frontier.tipX, y: frontier.tipY, z: frontier.z, baseDirectionCenter };

  const newSystem = createEmptyGrowthSystem(newSystemId);
  newSystem.roots = [root];
  newSystem.resproutCounters.set(0, 0);
  newSystem.branches = [spawnRootBranch(state, newSystem, newSystemId, 0)];

  state.foregroundSystems.push(newSystem);
}

function stepState(state: BotanicalState, params: MovementParams, sessionParams: SessionParams, dt: number): void {
  state.latestParams = params;
  state.latestSessionParams = sessionParams;

  // Resolved once per tick, before the per-system loop -- doesn't depend on
  // which system/branch/blossom is being checked, so every foreground
  // system this tick shares the same snapshot for blossom-reveal gating
  // (docs/HANDOFF.md bake-order fix). This reflects state as of the END of
  // the PREVIOUS tick (nothing has grown yet this tick). Echoes never
  // receive this (see BakeSafety's own doc comment) -- each echo is its own
  // separate compositor bucket.
  const bakeSafety = resolveBakeThreats(state);

  for (const system of state.foregroundSystems) {
    stepGrowthSystem(state, system, system.systemId, params, dt, state.tuning.maxGeneration, bakeSafety);
  }
  maybeSpawnNextForegroundSystem(state);

  ECHO_CONFIGS.forEach((echoConfig, i) => {
    stepGrowthSystem(
      state,
      state.echoes[i]!,
      echoConfig.systemId,
      params,
      dt,
      Math.min(state.tuning.maxGeneration, echoConfig.maxGenerationCap),
      undefined,
    );
  });

  // Resolved AGAIN here, after this tick's own growth/forking/maturation
  // and the growth-plateau hand-off -- so any branch that newly matured (or
  // newly forked) THIS tick gets its bake-safety resolved immediately,
  // rather than lagging one tick behind. Cheap: resolveBakeThreats only
  // ever examines currently-unresolved branches (see its own doc comment),
  // and this call's mutations are exactly what buildScene/buildSceneLayers
  // (via emitGrowthSystem) read `branch.bakeResolved` from -- no separate
  // isSafeToBake recomputation happens at scene-emission time anymore.
  resolveBakeThreats(state);
}

/** Emits one growth system's branches/blossoms as scene elements, applying its z-offset (depth-echo placement) and opacity multiplier (depth-echo paleness) on top of each element's own values. zOffset=0/opacityMultiplier=1 for the foreground system is a no-op. */
/**
 * The furthest-right x any point of `branch`'s own path has ever reached --
 * NOT necessarily its current `tipX`. Wander can occasionally curve a
 * branch's direction enough that it ends up net-negative relative to where
 * it started, or otherwise finishes to the left of an earlier point along
 * its own path (docs/HANDOFF.md bake-order fix: found via the original
 * root-level fix's own wide-seed verification sweep, still true unchanged
 * after the session-018 branch-level generalization). isSafeToBake's `tipX`
 * is meant to answer "how far right does this content's own path actually
 * reach" (the relevant question for whether a farther, unrelated
 * still-growing branch could still catch up and overlap it) -- using the
 * raw, possibly backward-drifted `tipX` there would understate that reach
 * and let content bake before it's genuinely safe. Only relevant for this
 * safety check; every other use of `tipX` in this file (front-driven
 * resprout position, growth-plateau hand-off anchoring, wherever a branch
 * actually IS right now) intentionally means the literal current tip, not
 * this.
 */
function branchMaxReachX(branch: Branch): number {
  let max = branch.rootX;
  for (const point of branch.segments) {
    if (point.x > max) max = point.x;
  }
  return max;
}

function emitGrowthSystem(
  elements: SceneElement[],
  state: BotanicalState,
  system: GrowthSystemState,
  zOffset: number,
  opacityMultiplier: number,
  applyBakeSafety = false,
): void {
  for (const branch of system.branches) {
    if (branch.segments.length < 2) continue; // a stroke needs at least 2 points

    // A mature branch is only reported final (and therefore only baked by
    // the live compositor -- docs/HANDOFF.md bake-order fix) once it's also
    // safe: no other, farther, unrelated (not its own ancestor/descendant)
    // live threat (still-growing, or itself mature-but-still-blocked -- see
    // computeBakeThreats) sharing this bucket could still arrive later and
    // permanently paint over it. Resolved once already, per tick, by
    // resolveBakeThreats (stepState) -- `branch.bakeResolved` is simply read
    // here, not recomputed, which is also what keeps scene()/sceneLayers()
    // trivially, always in agreement (both just read the same persisted
    // field). `applyBakeSafety` is false for echo systems (their own
    // separate compositor bucket -- no such risk there, and bakeResolved is
    // never set for echo branches in the first place), where this is
    // exactly the pre-fix check.
    const final = branch.lifecycle === 'mature' && (!applyBakeSafety || branch.bakeResolved);

    elements.push({
      kind: 'stroke',
      z: clamp01(branch.z + zOffset),
      points: branch.segments,
      baseWidth: branch.baseWidth,
      taperExponent: state.tuning.taperExponent,
      color: branch.color,
      opacity: state.tuning.branchBaseOpacity * opacityMultiplier,
      // The live compositor's own taper-freezing fix (docs/HANDOFF.md):
      // once mature, a branch's segments array never grows again (branch.ts
      // only appends via tickGrowing, which only runs while 'growing'), so
      // its taper is safe to bake once, in full, at its true final
      // points.length -- see StrokeElement.final's own doc comment.
      final,
    });
  }

  for (const blossom of system.blossoms) {
    const element: SceneElement = {
      kind: 'circle',
      z: clamp01(blossom.z + zOffset),
      x: blossom.x,
      y: blossom.y,
      radius: blossom.radius,
      opacity: blossom.baseOpacity * opacityMultiplier,
      color: blossom.color,
    };
    if (blossom.ringColor !== undefined) {
      element.ringColor = blossom.ringColor;
      element.ringOpacity = (blossom.ringOpacity ?? blossom.baseOpacity) * opacityMultiplier;
    }
    elements.push(element);
  }
}

function buildScene(state: BotanicalState): Scene {
  const elements: SceneElement[] = [];
  // `applyBakeSafety: true` for foreground systems only -- bake-order
  // safety is already fully resolved per tick by resolveBakeThreats
  // (stepState), so this just reads each branch's own persisted
  // `bakeResolved` flag (docs/HANDOFF.md bake-order fix); no per-call
  // computation happens here anymore. Echoes are each their own separate
  // compositor bucket, so they're emitted exactly as before (unGATED).
  for (const system of state.foregroundSystems) {
    emitGrowthSystem(elements, state, system, 0, 1, true);
  }
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    emitGrowthSystem(elements, state, state.echoes[i]!, echoConfig.zOffset, echoConfig.opacityMultiplier);
  });

  return { elements };
}

/**
 * The incremental-rendering counterpart to buildScene (src/compositor/
 * live-compositor.ts) -- same systems, same emitGrowthSystem calls, same
 * per-element depth-offset/opacity-multiplier math, just kept as one
 * SceneLayer per growth system instead of flattened into buildScene's
 * single shared array. `layerId` is each system's own `systemId`, which
 * stays stable and unique for the life of a session (foregroundSystems only
 * ever grows via maybeSpawnNextForegroundSystem; echoes are fixed). Does
 * not affect buildScene/scene()/finish() in any way -- this is purely
 * additive.
 */
function buildSceneLayers(state: BotanicalState): SceneLayer[] {
  const layers: SceneLayer[] = [];
  // Same bakeResolved-reading contract as buildScene above -- both just
  // read each branch's own persisted flag, so this stays byte-for-byte
  // consistent with buildScene's own `final` values for the same state
  // (sceneLayers' own doc comment / the "never silently out of sync with
  // scene()" test both require this) with no risk of divergence, since
  // neither call site recomputes anything.
  for (const system of state.foregroundSystems) {
    const elements: SceneElement[] = [];
    emitGrowthSystem(elements, state, system, 0, 1, true);
    layers.push({ layerId: system.systemId, elements });
  }
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    const elements: SceneElement[] = [];
    emitGrowthSystem(elements, state, state.echoes[i]!, echoConfig.zOffset, echoConfig.opacityMultiplier);
    layers.push({ layerId: echoConfig.systemId, elements });
  });

  return layers;
}

/**
 * Builds the StyleRenderer plus a direct handle onto its mutable internal
 * state. The state handle is NOT part of StyleRenderer and never used by
 * production code -- it exists purely so tests can measure exact internal
 * quantities (e.g. a branch's grownLength) instead of reverse-engineering
 * them from opaque SceneElement geometry, without widening the interface
 * every style must implement.
 */
export function createBotanicalInternal(tuning?: Partial<BotanicalTuningConfig>): {
  renderer: StyleRenderer;
  state: BotanicalState;
} {
  const resolvedTuning: BotanicalTuningConfig = { ...DEFAULT_BOTANICAL_TUNING_CONFIG, ...tuning };
  const state = createEmptyState(resolvedTuning);

  const renderer: StyleRenderer = {
    id: 'botanical',
    name: 'Botanical',
    aestheticFamily: 'organic',

    worldKnobs(): string[] {
      return [...WORLD_KNOB_NAMES];
    },

    init(world: World): void {
      initState(state, world);
    },

    step(params: MovementParams, sessionParams: SessionParams, _time: number, dt: number): void {
      stepState(state, params, sessionParams, dt);
    },

    scene(): Scene {
      return buildScene(state);
    },

    finish(): Scene {
      return buildScene(state);
    },

    sceneLayers(): SceneLayer[] {
      return buildSceneLayers(state);
    },
  };

  return { renderer, state };
}

export function createBotanicalStyle(tuning?: Partial<BotanicalTuningConfig>): StyleRenderer {
  return createBotanicalInternal(tuning).renderer;
}
