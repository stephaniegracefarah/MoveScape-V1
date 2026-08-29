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
import type { MechanismSample, Scene, SceneElement, SceneLayer, StyleRenderer } from '../style-renderer';
import {
  checkCrossedForks,
  computeChildBaseWidth,
  computeForkFractions,
  computeMatureDurationMs,
  computeTargetLength,
  growthStepFor,
  spawnBranch,
  tickGrowing,
  wanderDeltaFor,
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
  /**
   * Every revealed blossom (a subset of `blossoms`, same object references)
   * that hasn't yet resolved `bakeResolved = true` -- tracked separately,
   * and PRUNED as blossoms resolve (resolveBucketBakeThreats), so per-tick
   * resolution work stays proportional to "how many revealed blossoms are
   * CURRENTLY unresolved," not "how many blossoms this session has ever
   * revealed." `blossoms` itself is permanent-ink append-only and can grow
   * into the thousands over a long session (docs/styles/botanical.md
   * section 7), so scanning all of it every tick just to find the still-
   * unresolved handful would reintroduce the exact unbounded-per-tick-cost
   * shape session 013's frame-rate-collapse fix (and session 018's own
   * first, too-naive branch-level attempt) already fought -- this list is
   * what keeps blossom bake-safety resolution (added session 021) bounded
   * the same way branch resolution already is (there, `maxConcurrentBranches`
   * keeps any ONE system's own `branches` small; blossoms have no such
   * per-system cap, so this list exists specifically to give them the same
   * shape).
   */
  unresolvedBlossoms: Blossom[];
  resproutCounters: Map<number, number>;
  pendingClusters: PendingBlossomCluster[];
}

function createEmptyGrowthSystem(systemId: string): GrowthSystemState {
  return {
    systemId,
    roots: [],
    branches: [],
    blossoms: [],
    unresolvedBlossoms: [],
    resproutCounters: new Map(),
    pendingClusters: [],
  };
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
  branches: { id: string; rootX: number; reachX: number; z: number; lifecycle: 'growing' | 'mature'; generation: number }[];
}

/**
 * The generation cap and per-fork z-jitter magnitude for ONE compositor
 * bucket -- everything computeBakeThreats needs to build a conservative
 * upper bound on how far a still-growing branch's NOT-YET-SPAWNED
 * descendants could still push z (see computeBakeThreats' own doc comment,
 * "the snapshot-timing gap," session 019/020). `maxGeneration` is
 * `state.tuning.maxGeneration` for the foreground bucket, or
 * `Math.min(state.tuning.maxGeneration, echoConfig.maxGenerationCap)` for
 * an echo bucket -- exactly the same value stepGrowthSystem's own
 * `maxGenerationForSystem` argument already uses to gate real forking
 * (`branch.generation < maxGenerationForSystem`), so this bound can never
 * be looser than what the branch could actually still do.
 * `childZJitterMax` is `state.tuning.childZJitter` -- the same constant
 * spawnChildBranch already uses as the (exclusive) bound on a single
 * fork's z offset, shared by every system (not bucket-specific).
 */
export interface ForkZBound {
  maxGeneration: number;
  childZJitterMax: number;
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
 *
 * THE SNAPSHOT-TIMING GAP, and its fix (session 020, docs/HANDOFF.md): the
 * paragraphs above describe a resolution that is only ever correct against
 * branches that ALREADY EXIST at the moment it runs. `resolveBucketBake
 * Threats` (botanical.ts) permanently excludes a once-resolved-safe branch
 * from ever being re-examined (the perf bound the file-level doc comment on
 * that function explains, guarding against session 013's unbounded-cost
 * shape) -- which is exactly correct for THAT branch's own resolution
 * (nothing later can make an already-correctly-ordered bake wrong), but
 * says nothing about a branch that DIDN'T EXIST YET when a nearby, nearer
 * branch resolved safe. A still-GROWING branch G can still fork new
 * children for as long as `G.generation < maxGeneration` -- each fork's
 * child, per spawnChildBranch, gets a z within `childZJitter` of ITS
 * parent's z, and that child can itself fork again, and so on, up to the
 * bucket's own generation cap. So G's own CURRENT z understates the
 * farthest z any of its not-yet-spawned descendants could still reach --
 * using only G's current z as its "threat" value let a nearer, unrelated
 * branch resolve safe and bake BEFORE such a descendant existed, only for
 * that descendant to fork later, mature, and bake even farther, painting
 * over the already-permanent nearer content. Confirmed with real evidence,
 * not assumed (docs/HANDOFF.md session 019's `it.fails` echo-violation
 * test, 6 genuine violating pairs across 2 seeds, none of them ancestor/
 * descendant pairs -- see isAncestorOrDescendant's own investigation note).
 *
 * The fix: a still-GROWING branch's threat z is no longer its own current
 * z -- it's a CONSERVATIVE (worst-case) upper bound, `effectiveThreatZ`
 * below, computed as `z + (maxGeneration - generation) * childZJitterMax`
 * (clamped to 1, like every z value in this file) -- "how far z could
 * possibly drift, generation by generation, if every remaining fork this
 * branch's lineage could still produce jittered in the same, maximally
 * unhelpful direction." This can only ever OVER-estimate a real future
 * descendant's z, never under-estimate it, so it can only make the safety
 * check MORE conservative (withhold more, never less) -- it cannot
 * introduce a new false "safe." A MATURE branch's own threat z is
 * unaffected (still its literal current z, unchanged from before): mature
 * means `tickGrowing` will never run for it again (branch.ts), so it can
 * never fork again either -- there is nothing left to conservatively bound.
 * The sort below now sorts by this SAME effective value uniformly (mature
 * branches' effective value being just their real z), which is what keeps
 * the farthest-first walk's own invariant intact: a growing branch whose
 * inflated bound is farther than some mature candidate M's real z is
 * guaranteed to sort (and therefore land in `threats`) before M is
 * resolved, exactly the ordering the walk already depended on.
 */
function effectiveThreatZ(
  branch: { z: number; generation: number; lifecycle: 'growing' | 'mature' },
  forkZBound: ForkZBound,
): number {
  if (branch.lifecycle !== 'growing') return branch.z; // mature: can never fork again, no bound needed
  const remainingGenerations = Math.max(0, forkZBound.maxGeneration - branch.generation);
  return clamp01(branch.z + remainingGenerations * forkZBound.childZJitterMax);
}

export function computeBakeThreats(
  systems: BakeSafetySystem[],
  margin: number,
  forkZBound: ForkZBound,
): BakeThreatEntry[] {
  const all = systems.flatMap((system) => system.branches);
  const withThreatZ = all.map((branch) => ({ branch, threatZ: effectiveThreatZ(branch, forkZBound) }));
  // Farthest-first BY THE EFFECTIVE (possibly-inflated) value -- see this
  // function's own "snapshot-timing gap" doc comment for why sorting by
  // the uniform effective value (not raw z) is what preserves the walk's
  // farthest-first invariant once growing branches' threat values can
  // exceed their own current z.
  withThreatZ.sort((a, b) => b.threatZ - a.threatZ);

  const threats: BakeThreatEntry[] = [];
  for (const { branch, threatZ } of withThreatZ) {
    if (branch.lifecycle === 'growing') {
      threats.push({ id: branch.id, z: threatZ, rootX: branch.rootX });
      continue;
    }
    // A mature candidate's OWN z in its safety check is its real,
    // unconditionally-current z (never inflated -- it can't fork anymore,
    // per effectiveThreatZ above), unchanged from before this fix.
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
 *
 * INVESTIGATED (session 020, per the snapshot-timing-gap fix's own
 * contract): does this exclusion hide any of the real overwrites the
 * `it.fails` echo-violation test found (session 019, 6 violating pairs
 * across seeds 0 and 3)? No -- checked every one directly: all 6 are
 * sibling/cousin pairs forked from a common ancestor at DIFFERENT points
 * (e.g. `echo0:root0:0/child0/child0/child1` vs `echo0:root0:0/child2`;
 * `echo0:root0:0/child0/child0/child0` vs `echo0:root0:0/child0/child0/
 * child1`), so `isAncestorOrDescendant` correctly returns false for every
 * one of them -- none were being wrongly excluded from the threat count.
 * The violations are a genuine gap in the OTHER mechanism (the snapshot-
 * timing gap computeBakeThreats' own doc comment now describes), not this
 * exclusion. Not investigated further per the contract's own scope (a
 * separate decision if this exclusion is ever found to hide something).
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
 * root. So every live threat within the SAME compositor bucket -- every
 * foreground system together, or one echo system on its own (session 019 --
 * see BakeSafety's own doc comment) -- is a potential threat to every other
 * piece of content in that same bucket, full stop -- EXCEPT its own
 * ancestors/descendants, per the exclusion below. `threats` here is always
 * already scoped to one bucket by the caller (resolveBucketBakeThreats),
 * this function itself has no bucket concept of its own.
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
 * Bundles everything isSafeToBake needs about ONE compositor bucket's
 * current state -- computed once per tick (stepState, for blossom-reveal
 * gating) or once per scene emission (buildScene/buildSceneLayers, for
 * stroke finality gating), then threaded down to each individual branch's
 * or blossom's own isSafeToBake call rather than recomputed per-element.
 *
 * BUCKET-SCOPED (session 019 fix -- docs/HANDOFF.md): a bucket is exactly
 * live-compositor.ts's own `bucketFor` grouping -- one shared 'foreground'
 * bucket (every entry of `state.foregroundSystems` together, since they're
 * all painted into the same persistent buffer) plus one bucket PER echo
 * system (`state.echoes[i]`, each with its OWN persistent buffer, entirely
 * independent of the others and of foreground). `threats` for a given
 * BakeSafety is therefore only ever built from branches sharing that same
 * bucket -- see resolveBakeThreats, which now resolves one BakeSafety per
 * bucket instead of a single foreground-only one.
 *
 * Originally (sessions 017-018) this was foreground-only, on the theory
 * that "echoes are each their own separate compositor bucket... so they
 * neither need this check applied to them nor participate as a threat in
 * anyone else's check" -- true as far as it went (echoes indeed never
 * threaten foreground or each other), but wrong in what it concluded: being
 * a separate bucket means echo branches need their OWN, separately-scoped
 * version of this exact check applied WITHIN that bucket, not that the
 * check can be skipped for echoes entirely. Session 019's pixel-diff
 * evidence (a renderScene() vs live-compositor diff, docs/HANDOFF.md) found
 * exactly the bug this gap predicts: an echo branch could mature and bake
 * (unconditionally -- `applyBakeSafety` was hardcoded false for echoes at
 * both emitGrowthSystem call sites) while a farther, unrelated sibling/
 * cousin branch in the SAME echo system (echo branches fork via
 * spawnChildBranch/childZJitter exactly like foreground ones -- see
 * ECHO_CONFIGS' own maxGenerationCap) was still growing nearby -- the
 * identical bug class sessions 017-018 fixed for foreground, just never
 * extended to echoes.
 */
interface BakeSafety {
  threats: BakeThreatEntry[];
  margin: number;
}

/** One BakeSafety per compositor bucket that can bake independently (see BakeSafety's own doc comment) -- `foreground` covers every entry of `state.foregroundSystems` together (unchanged from the original fix), `echoes` is parallel to `state.echoes`/ECHO_CONFIGS, one independently-scoped BakeSafety per echo system. */
interface BakeSafetyByBucket {
  foreground: BakeSafety;
  echoes: BakeSafety[];
}

/**
 * Resolves bake-order safety for every currently UNRESOLVED branch (still
 * `growing`, or `mature` but not yet `bakeResolved`) within `systems`,
 * permanently marking `branch.bakeResolved = true` on each mature one that
 * newly resolves safe (see Branch.bakeResolved's own doc comment for why
 * this is safe to never revisit). `systems` is always exactly one
 * compositor bucket's worth of growth systems (see resolveBakeThreats,
 * BakeSafety's own doc comment) -- this function itself has no notion of
 * "foreground" or "echo," it just resolves whatever systems it's handed
 * against each other, which is what makes it directly reusable for both.
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
 * ticks) time out. Session 019's echo extension preserves this bound
 * per-bucket: each echo system's own unresolved-branch count is small and
 * independently bounded (maxConcurrentBranches), exactly like foreground's.
 *
 * The fix: once a branch resolves safe, it has effectively already baked,
 * permanently, correctly ordered -- nothing that happens later can ever
 * retroactively make an already-baked bake unsafe, so it can be permanently
 * excluded from every future tick's input set (the `!branch.bakeResolved`
 * filter below). This bounds each call's real work to "branches still
 * growing or still blocked right now," which -- like `maxConcurrentBranches`
 * itself -- stays roughly constant regardless of how long the session has
 * run, instead of scaling with the session's entire history.
 *
 * BLOSSOMS TOO, as of session 021 (docs/HANDOFF.md): a revealed blossom
 * (already visible, per revealPendingBlossoms' own doc comment -- reveal
 * itself is no longer gated on this) resolves its OWN `bakeResolved` flag
 * the same way, against the SAME `threats` list already computed from
 * branches -- a blossom is a fixed point (unlike a branch, it never grows
 * or forks, so it never needs a forward-looking effectiveThreatZ bound of
 * its own; it only ever needs checking against what's already threatening
 * everything else in this bucket). `blossom.branchId` is used as its own
 * "id" for the ancestor/descendant exclusion (isSafeToBake), exactly as
 * the old isNextBlossomSafe did -- a blossom is never a threat to its own
 * owning branch's lineage. Scoped as narrowly as branches, via
 * `system.unresolvedBlossoms` (see that field's own doc comment for why a
 * dedicated, pruned list is needed here specifically -- unlike branches,
 * blossoms have no per-system population cap to keep `system.blossoms`
 * itself small, so scanning THAT every tick would NOT have been bounded).
 * NOTE (reported, not fixed, per this session's own contract): a revealed-
 * but-not-yet-resolved blossom does NOT itself get
 * added to `threats` for OTHER content to check against -- only branches
 * do. A blossom's own position is fixed the instant it's revealed (no
 * growing frontier), so the specific overwrite risk this file's threat
 * mechanism guards against (a farther-z unrelated thing baking AFTER a
 * nearer one already baked) is structurally narrower for blossom-vs-
 * blossom or blossom-vs-branch than for branch-vs-branch -- but it is not
 * proven impossible here, just out of this session's scope.
 */
function resolveBucketBakeThreats(
  systems: GrowthSystemState[],
  margin: number,
  forkZBound: ForkZBound,
  dt: number,
  forcedBakeCeilingMs: number,
): BakeSafety {
  const bakeSystems: BakeSafetySystem[] = systems.map((system) => ({
    branches: system.branches
      .filter((branch) => branch.lifecycle === 'growing' || !branch.bakeResolved)
      .map((branch) => ({
        id: branch.id,
        rootX: branch.rootX,
        reachX: branchMaxReachX(branch),
        z: branch.z,
        lifecycle: branch.lifecycle,
        generation: branch.generation,
      })),
  }));
  const threats = computeBakeThreats(bakeSystems, margin, forkZBound);
  const stillBlockedIds = new Set(threats.map((t) => t.id));
  for (const system of systems) {
    for (const branch of system.branches) {
      if (branch.lifecycle !== 'mature' || branch.bakeResolved) continue;
      if (!stillBlockedIds.has(branch.id)) {
        // Resolved the normal, safe way -- nothing farther and unrelated can
        // still paint over it.
        branch.bakeResolved = true;
        continue;
      }
      // FORCED-BAKE CEILING (roadmap B, docs/HANDOFF.md). This branch is
      // mature but still blocked by isSafeToBake. Botanical's front-driven
      // resprouting spawns a fresh GROWING branch at each generation-0
      // root's fixed near-origin rootX forever, so there is effectively
      // always a low-x blocker and a mature branch behind it can otherwise
      // stay blocked -- and therefore stuck in the live compositor's
      // per-frame redraw pass -- for the entire rest of the session, the
      // unbounded-growth bug that collapses FPS over a long run. Accumulate
      // the wait in SIMULATED time (`dt` from the fixed-timestep step(),
      // never wall-clock, never render frames, so live and replay stay
      // bit-identical) and force `bakeResolved` once it crosses the
      // ceiling, regardless of what the threat model says. Only `mature`
      // branches ever reach here (guarded above) -- a still-`growing`
      // stroke is never force-resolved, since freezing its taper before its
      // final point count is visible. The founder has explicitly accepted
      // the resulting rare, small depth-ordering artifact as permanent
      // (same class as the accepted cross-bucket z-overlap deviation). This
      // forced resolution rides the exact same per-branch loop -- and feeds
      // the same same-frame z-sort the live compositor already applies to
      // every element that becomes bakeable together -- as the normal safe
      // path directly above; a batch that force-resolves on one tick bakes
      // in z-order the same way a batch that resolves safe on one tick
      // does. There is no separate, out-of-order force path.
      branch.matureBlockedMs += dt;
      if (branch.matureBlockedMs >= forcedBakeCeilingMs) {
        branch.bakeResolved = true;
      }
    }
    // Iterates `unresolvedBlossoms` (bounded: currently-unresolved revealed
    // blossoms only), NOT `system.blossoms` (permanent-ink append-only,
    // unbounded over a long session) -- see GrowthSystemState.
    // unresolvedBlossoms' own doc comment for why this distinction is load-
    // bearing, not stylistic: scanning the full blossom history every tick
    // just to skip already-resolved ones was measured to reintroduce
    // session 013's frame-rate-collapse cost shape (found via this exact
    // fix's own test suite timing out -- see docs/HANDOFF.md session 021).
    for (const blossom of system.unresolvedBlossoms) {
      if (isSafeToBake({ id: blossom.branchId, z: blossom.z, tipX: blossom.x, threats, margin })) {
        blossom.bakeResolved = true;
        continue;
      }
      // Same forced-bake ceiling as branches above -- a revealed blossom
      // can be stuck behind the same forever-near-origin growing branches.
      // Same simulated-time (`dt`) accumulation, same "force once past the
      // ceiling," same founder-accepted artifact. A blossom is a fixed
      // point (it never grows), so there is no growing-vs-mature guard to
      // make here -- every entry of `unresolvedBlossoms` is already
      // revealed and eligible.
      blossom.blockedMs += dt;
      if (blossom.blockedMs >= forcedBakeCeilingMs) {
        blossom.bakeResolved = true;
      }
    }
    if (system.unresolvedBlossoms.length > 0) {
      system.unresolvedBlossoms = system.unresolvedBlossoms.filter((b) => !b.bakeResolved);
    }
  }
  return { threats, margin };
}

/**
 * Resolves bake-order safety independently per compositor bucket (session
 * 019 -- see BakeSafety's own doc comment for why): the 'foreground' bucket
 * across all of `state.foregroundSystems` together (exactly the original
 * fix's own scope, unchanged), plus one independently-scoped bucket per
 * echo system in `state.echoes` -- echo0's branches are only ever threatened
 * by other echo0 branches, never by echo1's or foreground's, and vice
 * versa, matching live-compositor.ts's own bucketFor (each echo gets its
 * own persistent buffer, entirely separate from foreground and from each
 * other). Delegates the actual per-bucket resolution to
 * resolveBucketBakeThreats, unchanged from the original single-bucket
 * algorithm -- only the grouping/call-site is new.
 */
function resolveBakeThreats(state: BotanicalState, dt: number): BakeSafetyByBucket {
  const margin = state.tuning.crossRootBakeSafetyMargin;
  const childZJitterMax = state.tuning.childZJitter;
  const forcedBakeCeilingMs = state.tuning.forcedBakeCeilingMs;
  const foreground = resolveBucketBakeThreats(
    state.foregroundSystems,
    margin,
    {
      maxGeneration: state.tuning.maxGeneration,
      childZJitterMax,
    },
    dt,
    forcedBakeCeilingMs,
  );
  const echoes = state.echoes.map((echoSystem, i) =>
    resolveBucketBakeThreats(
      [echoSystem],
      margin,
      {
        // Same cap stepGrowthSystem's own ECHO_CONFIGS.forEach call site already
        // uses for this echo's real forking gate -- see ForkZBound's own doc
        // comment for why this has to match exactly.
        maxGeneration: Math.min(state.tuning.maxGeneration, ECHO_CONFIGS[i]!.maxGenerationCap),
        childZJitterMax,
      },
      dt,
      forcedBakeCeilingMs,
    ),
  );
  return { foreground, echoes };
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
 * PACED ONLY BY THE FOUNDER-TUNED WATERCOLOR TIMER (session 021,
 * docs/HANDOFF.md) -- no longer gated on bake-order safety at all. Sessions
 * 017-020 gated REVEAL itself on isSafeToBake, on the theory that "not safe
 * to bake" and "not safe to show" were the same question -- they are not: a
 * blocked mature STROKE was always still drawn live every frame while
 * blocked (never invisible), but a blocked blossom under the old design was
 * invisible outright until it resolved safe, and session 020's more
 * conservative (correctly so) threat-z bound made that invisibility window
 * large enough that the founder's live testing found blossoms "mostly
 * reveal only after their area scrolls out of view" -- a real, reported
 * regression, not a synthetic-stress artifact. The fix decouples the ART
 * EVENT (when a blossom becomes visible -- purely this timer, exactly PR
 * #15's original behavior) from the RENDERING OPTIMIZATION (when it's safe
 * to permanently bake it into the persistent buffer instead of redrawing it
 * live every frame -- resolveBucketBakeThreats now resolves each already-
 * REVEALED blossom's own `bakeResolved` flag the same way it already
 * resolves branches', consumed by emitGrowthSystem to compute the
 * CircleElement's own `final` flag, mirroring StrokeElement.final exactly).
 * A blossom is therefore visible the instant this function reveals it,
 * baked or not -- the live compositor's live-redraw pass (live-
 * compositor.ts) now draws non-final circles every frame, the same way it
 * already draws non-final (still-growing or still-blocked) strokes.
 */
function revealPendingBlossoms(system: GrowthSystemState, dt: number, intervalMs: number, speed: number, speedFloor: number): void {
  const effectiveDt = dt * (speedFloor + speed * (1 - speedFloor));
  let anyFullyRevealed = false;
  for (const pending of system.pendingClusters) {
    if (pending.revealedCount >= pending.blossoms.length) {
      anyFullyRevealed = true;
      continue;
    }
    pending.revealTimerMs += effectiveDt;
    while (pending.revealTimerMs >= intervalMs && pending.revealedCount < pending.blossoms.length) {
      const revealed = pending.blossoms[pending.revealedCount]!;
      system.blossoms.push(revealed);
      // Same object reference in both arrays -- resolveBucketBakeThreats
      // flips `revealed.bakeResolved` in place, and this list is pruned
      // once it does (see GrowthSystemState.unresolvedBlossoms' own doc
      // comment for why this list exists at all).
      system.unresolvedBlossoms.push(revealed);
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

/** The Nth foreground system's id: 'fg0', 'fg1', ... -- as of roadmap C1 only 'fg0' is ever used (the population lives in one system), but the helper stays so systemId strings and their labeled-stream namespaces are unchanged. */
const foregroundSystemId = (index: number): string => `${FOREGROUND_SYSTEM_ID}${index}`;

/**
 * Everything the StyleRenderer factory mutates over a session, held in one
 * place so a test-only entry point can reach in directly (see
 * createBotanicalInternal below) without widening StyleRenderer's own
 * public interface.
 */
export interface BotanicalState {
  sessionSeed: string;
  /**
   * The foreground growth systems. As of roadmap C1 (the population model,
   * docs/HANDOFF.md Roadmap C entry) this is ALWAYS exactly length 1 -- every
   * main branch lives in `foregroundSystems[0]`. The array type is kept
   * (rather than collapsed to a single system) only because bake-safety
   * code, the dev magic panel, and ~40 tests read `foregroundSystems[0]` /
   * `foregroundSystems[foregroundSystems.length - 1]`; nothing ever appends a
   * second entry now. The old `maybeSpawnNextForegroundSystem` single-frontier
   * hand-off (which grew this to 2+) is gone -- successor growth is now a
   * continuously-seeded, born-and-ending population of finite-life gen-0
   * branches within the one system (see maybeSpawnMainBranches).
   */
  foregroundSystems: GrowthSystemState[];
  echoes: GrowthSystemState[];
  latestParams: MovementParams | undefined;
  latestSessionParams: SessionParams;
  /** "Show the magic" snapshot (UX Stage 2), captured during step() from the representative branch's real growthStepFor/wanderDeltaFor calls -- see stepGrowthSystem and StyleRenderer.latestMechanismSample. null until the first tick with a growing branch in the newest foreground system; once set, only ever replaced by a newer capture, never cleared back to null mid-session (reset to null only by initState). */
  mechanismSample: MechanismSample | null;

  /** Resolved once at renderer creation -- DEFAULT_BOTANICAL_TUNING_CONFIG merged with any caller-supplied partial override, constant for the renderer's whole lifetime. */
  tuning: BotanicalTuningConfig;
  /** Resolved once at init() from the paletteIndex world knob. */
  palette: BotanicalPalette;

  maxConcurrentBranches: number;
  baseGrowthRate: number;
  baseGrowthPerTick: number;
  baseMatureDurationMs: number;
  windAngle: number;
  /**
   * Still seed-derived from the `rootCount` world knob (world-layer tests
   * assert on the knob name, so it stays), but as of roadmap C1 it NO LONGER
   * sizes the initial foreground population -- `tuning.mainBranchTarget`
   * does. Kept computed for any diagnostic/inspection use and so the knob
   * draw sequence is unchanged; not read by the growth logic anymore.
   */
  rootCount: number;
  branchSpreadBase: number;
  wanderAmplitudeBase: number;
  blossomsPerCluster: number;

  /**
   * Roadmap C1: the largest `tipX` any generation-0 branch in the foreground
   * system has ever reached -- monotonic, updated every tick. Drives ONLY
   * the main-branch birth-spacing gate (maybeSpawnMainBranches); it is not a
   * scroll/canvas-width input (render-scene.ts already tracks max x over all
   * emitted geometry independently).
   */
  frontMaxX: number;
  /** Roadmap C1: `frontMaxX` at the moment the most recent main branch was born (initialised to `frontMaxX` right after the initial population is created). A new main branch may only be born once `frontMaxX - lastMainBirthX >= tuning.mainBranchSpawnSpacing` (unless the safety floor fires). */
  lastMainBirthX: number;
}

function createEmptyState(tuning: BotanicalTuningConfig): BotanicalState {
  return {
    sessionSeed: '',
    foregroundSystems: [],
    echoes: ECHO_CONFIGS.map((cfg) => createEmptyGrowthSystem(cfg.systemId)),
    latestParams: undefined,
    latestSessionParams: INITIAL_SESSION_PARAMS,
    mechanismSample: null,
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
    frontMaxX: 0,
    lastMainBirthX: 0,
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
  /**
   * Roadmap C1: whether a mature generation-0 branch resprouts a fresh
   * sibling at its own root when its `lifecycleTimer` elapses (the legacy
   * behavior). The foreground system passes `false` -- its gen-0 branches
   * just stay mature forever, exactly like gen>0 branches, and successor
   * growth comes from maybeSpawnMainBranches' born-and-ending population
   * instead. Echo systems pass `true` and keep the legacy near-root resprout
   * byte-for-byte (C4 flips them to the population model later).
   */
  resproutRoots: boolean,
): void {
  const newBranches: Branch[] = [];
  const liveCount = () => system.branches.length + newBranches.length;

  const effectiveWanderAmplitudeBase =
    state.wanderAmplitudeBase * (1 + state.latestSessionParams.movementVariance * SESSION_VARIANCE_WANDER_SCALE);

  // "Show the magic" (UX Stage 2): only the newest foreground growth system
  // is the growth front the panel reads from. Pick its representative branch
  // now, before the loop mutates any branch state -- newest (last in append
  // order) still-growing generation-0 branch, else newest still-growing
  // branch at any generation, else none (and the previous sample is kept).
  const isGrowthFrontSystem = system === state.foregroundSystems[state.foregroundSystems.length - 1];
  let representativeBranch: Branch | null = null;
  if (isGrowthFrontSystem) {
    for (const branch of system.branches) {
      if (branch.lifecycle === 'growing' && branch.generation === 0) representativeBranch = branch;
    }
    if (!representativeBranch) {
      for (const branch of system.branches) {
        if (branch.lifecycle === 'growing') representativeBranch = branch;
      }
    }
  }

  for (const branch of system.branches) {
    if (branch.lifecycle === 'growing') {
      const previousGrownLength = branch.grownLength;
      const noise01 = createLabeledNoise(state.sessionSeed, `${branch.id}:wander`)(
        branch.grownLength * state.tuning.curvatureNoiseScale,
      );

      if (branch === representativeBranch) {
        // Rebuild the exact scalar arg objects this branch's real
        // growthStepFor / wanderDeltaFor calls get inside tickGrowing below,
        // captured BEFORE tickGrowing mutates branch.direction/grownLength.
        // branch.ts's growth/wander math is pure in its explicit args, so
        // re-invoking here with the same inputs yields the true value.
        const growthArgs = { dt, speed: params.speed, baseGrowthPerTick: state.baseGrowthPerTick };
        const wanderArgs = {
          noise01,
          wanderAmplitudeBase: effectiveWanderAmplitudeBase,
          symmetry: params.symmetry,
          expansion: params.expansion,
          dt,
          windAngle: state.windAngle,
          currentDirection: branch.direction,
          sweepTarget: branch.sweepTarget,
        };
        state.mechanismSample = {
          functions: [
            {
              tabLabel: 'speed → growth',
              sourceFunctionName: 'growthStepFor',
              sourceModule: 'branch.ts',
              args: growthArgs,
              result: growthStepFor({ ...growthArgs, tuning: state.tuning }),
            },
            {
              tabLabel: 'expansion + symmetry → wander',
              sourceFunctionName: 'wanderDeltaFor',
              sourceModule: 'branch.ts',
              args: wanderArgs,
              result: wanderDeltaFor({ ...wanderArgs, tuning: state.tuning }),
            },
          ],
        };
      }

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
      // permanent ink": no shrink, no removal, ever).
      //
      // LEGACY RESPROUT (echo systems only, `resproutRoots === true`): a
      // generation-0 branch's timer triggers front-driven new growth -- once
      // matureDurationMs elapses a fresh sibling spawns at the same root
      // (subject to the same maxConcurrentBranches cap that gates forking)
      // and the timer resets, so a root keeps producing growth for the life
      // of the session. Forked (generation > 0) branches just carry an
      // unused timer -- only roots resprout.
      //
      // POPULATION MODE (foreground, `resproutRoots === false`, roadmap C1):
      // a mature gen-0 branch does nothing on its timer -- identical terminal
      // behavior to a gen>0 branch. Successor growth is a born-and-ending
      // population of finite-life gen-0 "main" branches (maybeSpawnMainBranches,
      // called from stepState for the foreground system only).
      branch.lifecycleTimer += dt;

      if (resproutRoots && branch.lifecycleTimer >= branch.matureDurationMs) {
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

  revealPendingBlossoms(system, dt, state.tuning.blossomRevealIntervalMs, params.speed, state.tuning.blossomRevealSpeedFloor);
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
  state.mechanismSample = null;
  state.foregroundSystems = [createEmptyGrowthSystem(foregroundSystemId(0))];
  state.echoes = ECHO_CONFIGS.map((cfg) => createEmptyGrowthSystem(cfg.systemId));

  // Roadmap C1: the initial foreground population is `mainBranchTarget`
  // roots, NOT the `rootCount` knob -- same seeded draw sequence
  // (`${systemId}:roots` stream), just a different loop bound. Echoes keep
  // their own fixed per-config rootCount (C4 changes them later).
  initGrowthSystem(state, state.foregroundSystems[0]!, foregroundSystemId(0), state.tuning.mainBranchTarget);
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    initGrowthSystem(state, state.echoes[i]!, echoConfig.systemId, echoConfig.rootCount);
  });

  // Seed the birth-spacing gate from the population just created: every
  // initial main branch starts with tipX === its own rootX, so the front is
  // the rightmost initial root x. Births are then paced by how far the front
  // advances past this point.
  state.frontMaxX = 0;
  for (const branch of state.foregroundSystems[0]!.branches) {
    if (branch.generation === 0 && branch.tipX > state.frontMaxX) state.frontMaxX = branch.tipX;
  }
  state.lastMainBirthX = state.frontMaxX;
}

/** Count of currently-GROWING generation-0 branches in `system` -- the population maybeSpawnMainBranches keeps topped up to `tuning.mainBranchTarget`. Forked sub-branches (generation >= 1) never count. */
function growingMainBranchCount(system: GrowthSystemState): number {
  let n = 0;
  for (const branch of system.branches) {
    if (branch.generation === 0 && branch.lifecycle === 'growing') n++;
  }
  return n;
}

/**
 * Roadmap C1 birth: appends one fresh generation-0 "main" branch to the
 * foreground system at the current growth front. Replaces both the old
 * near-origin resprout and the single-frontier hand-off.
 *
 * Placement (C3 still adds y variety):
 *  - `x` = `state.frontMaxX + (xDraw*2-1) * tuning.mainBranchSpawnXSpread`
 *    (roadmap C2). At the default spread 0 this is exactly `state.frontMaxX`
 *    (born at the front, as the old hand-off used `frontier.tipX`); raised,
 *    births scatter behind / at / ahead of the front.
 *  - `y` = the `tipY` of the current furthest-right gen-0 branch (as the old
 *    hand-off used `frontier.tipY`); if none exists yet, a seeded mid-band y
 *    drawn the same way initGrowthSystem draws root y.
 *  - `z` = initGrowthSystem's own stratified formula with a rolling index:
 *    `frac((newIndex + zDraw) / mainBranchTarget)`. This cycles successive
 *    births through the foreground depth bands (spread is desirable) while
 *    keeping each individual birth's z bounded to one 1/target-wide stratum
 *    rather than the full [0,1] -- a narrower spread than a raw uniform draw,
 *    which keeps the live-vs-renderScene() depth-ordering divergence closer
 *    to baseline (see docs/HANDOFF.md render-divergence notes).
 *  - `baseDirectionCenter` = the sweep angle jittered by
 *    `rootBaseDirectionSpread`, same as an initial root.
 *
 * Every draw is a labeled stream off `state.sessionSeed` keyed by the new
 * root index, so births stay bit-identical live vs replay. Birth cadence is
 * driven purely by dt-advanced sim state (`state.frontMaxX`) via
 * maybeSpawnMainBranches -- no wall-clock anywhere.
 */
function spawnMainBranch(state: BotanicalState, system: GrowthSystemState): void {
  const systemId = system.systemId;
  const newIndex = system.roots.length;

  let frontier: Branch | undefined;
  for (const branch of system.branches) {
    if (branch.generation !== 0) continue;
    if (!frontier || branch.tipX > frontier.tipX) frontier = branch;
  }

  const y = frontier
    ? frontier.tipY
    : state.tuning.rootYMin +
      createLabeledStream(state.sessionSeed, `${systemId}:root${newIndex}:rootY`)() * state.tuning.rootYSpan;

  const zDraw = createLabeledStream(state.sessionSeed, `${systemId}:root${newIndex}:rootZ`)();
  const target = Math.max(1, state.tuning.mainBranchTarget);
  const zRolling = (newIndex + zDraw) / target;
  const z = clamp01(zRolling - Math.floor(zRolling));

  const dirJitterDraw = createLabeledStream(state.sessionSeed, `${systemId}:root${newIndex}:rootDir`)();
  const baseDirectionCenter =
    COMPOSITION_SWEEP_ANGLE + (dirJitterDraw * 2 - 1) * state.tuning.rootBaseDirectionSpread;

  // Roadmap C2: x-spread around the front. The `:spawnX` draw is APPENDED
  // after the existing `:rootY` / `:rootZ` / `:rootDir` draws (never
  // reordered) and is ALWAYS taken -- at the default spread of 0 it
  // multiplies out to exactly `state.frontMaxX` (C1 behavior), and because
  // it is always drawn, raising the field mid-session can't shift any later
  // birth's other labeled draws. A birth ahead of the front pushes
  // `state.frontMaxX` forward on the next tick's update (still monotonic).
  const xDraw = createLabeledStream(state.sessionSeed, `${systemId}:root${newIndex}:spawnX`)();
  const x = state.frontMaxX + (xDraw * 2 - 1) * state.tuning.mainBranchSpawnXSpread;

  system.roots.push({ x, y, z, baseDirectionCenter });
  system.resproutCounters.set(newIndex, 0);
  system.branches.push(spawnRootBranch(state, system, systemId, newIndex));
}

/**
 * Roadmap C1 (the population model): keeps the foreground system topped up to
 * `tuning.mainBranchTarget` concurrently-growing generation-0 branches.
 * Called from stepState for the foreground system ONLY (echoes keep the
 * legacy resprout until C4), right where the deleted
 * `maybeSpawnNextForegroundSystem` used to run.
 *
 * A new main branch is born whenever the growing gen-0 count is below target
 * AND the growth front has advanced at least `mainBranchSpawnSpacing` past
 * the last birth -- the spacing gate stops the whole population re-spawning
 * on one tick. Each birth sets `lastMainBirthX = frontMaxX`, so the loop
 * self-limits to (at most) one birth per qualifying tick unless spacing is 0.
 *
 * Safety floor: if the growing gen-0 count is exactly 0, one branch is born
 * immediately, ignoring the spacing gate -- growth must never fully stall
 * (e.g. after a long still stretch where the front didn't advance while the
 * whole population matured out).
 */
function maybeSpawnMainBranches(state: BotanicalState, system: GrowthSystemState): void {
  const target = state.tuning.mainBranchTarget;
  const spacing = state.tuning.mainBranchSpawnSpacing;

  if (growingMainBranchCount(system) === 0) {
    spawnMainBranch(state, system);
    state.lastMainBirthX = state.frontMaxX;
  }

  while (
    growingMainBranchCount(system) < target &&
    state.frontMaxX - state.lastMainBirthX >= spacing
  ) {
    spawnMainBranch(state, system);
    state.lastMainBirthX = state.frontMaxX;
  }
}

function stepState(state: BotanicalState, params: MovementParams, sessionParams: SessionParams, dt: number): void {
  state.latestParams = params;
  state.latestSessionParams = sessionParams;

  for (const system of state.foregroundSystems) {
    stepGrowthSystem(state, system, system.systemId, params, dt, state.tuning.maxGeneration, false);
  }

  // Roadmap C1: advance the monotonic growth front (max tipX over foreground
  // gen-0 branches), then top the main-branch population back up to target.
  // Foreground only -- echoes never drive the front and keep legacy resprout.
  const foreground = state.foregroundSystems[0]!;
  for (const branch of foreground.branches) {
    if (branch.generation === 0 && branch.tipX > state.frontMaxX) state.frontMaxX = branch.tipX;
  }
  maybeSpawnMainBranches(state, foreground);

  ECHO_CONFIGS.forEach((echoConfig, i) => {
    stepGrowthSystem(
      state,
      state.echoes[i]!,
      echoConfig.systemId,
      params,
      dt,
      Math.min(state.tuning.maxGeneration, echoConfig.maxGenerationCap),
      true,
    );
  });

  // Resolved once per tick, after every system's own growth/forking/
  // maturation/blossom-reveal -- so any branch that newly matured (or
  // newly forked) and any blossom newly revealed THIS tick gets its
  // bake-safety resolved immediately, feeding buildScene/buildSceneLayers'
  // (via emitGrowthSystem) `final` computation at the next scene emission.
  // Session 021: this is the ONLY resolveBakeThreats call needed now --
  // with blossom reveal no longer gated on bake safety (revealPendingBlossoms'
  // own doc comment), nothing mid-tick consumes a pre-growth snapshot
  // anymore, so the extra pre-growth call sessions 017-020 made here would
  // now just be redundant, wasted per-tick work (its mutations would be
  // fully superseded by this call anyway). Cheap: resolveBakeThreats only
  // ever examines currently-unresolved branches/blossoms (see its own doc
  // comment).
  //
  // Roadmap B: `dt` is threaded through so resolveBucketBakeThreats can
  // accumulate each mature-but-blocked branch's / revealed-but-blocked
  // blossom's wait in SIMULATED time and force-resolve it past
  // `tuning.forcedBakeCeilingMs`. `dt` is the fixed-timestep step()'s own
  // delta (identical live and replay), so this stays fully deterministic.
  resolveBakeThreats(state, dt);
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
    // field). `applyBakeSafety` is true for every system as of session 019
    // (foreground AND each echo -- see BakeSafety's own doc comment for why
    // echoes needed their own bucket-scoped version of this, not exemption
    // from it); every call site now passes `true`, so this parameter exists
    // for callers that construct a scene without ever having resolved
    // bake-safety at all (e.g. a hand-built test fixture), not as a real
    // foreground-vs-echo distinction.
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
    // Mirrors the branch `final` computation directly above: a revealed
    // blossom is ALWAYS emitted (visible the instant revealPendingBlossoms
    // reveals it, per that function's own doc comment -- session 021), but
    // only reported `final` (and therefore only baked by the live
    // compositor) once resolveBakeThreats has independently resolved its
    // own `bakeResolved` flag safe. Until then it's drawn live every frame
    // by the compositor, exactly like a still-growing or still-blocked
    // stroke -- no longer invisible while blocked.
    const final = !applyBakeSafety || blossom.bakeResolved;

    const element: SceneElement = {
      kind: 'circle',
      z: clamp01(blossom.z + zOffset),
      x: blossom.x,
      y: blossom.y,
      radius: blossom.radius,
      opacity: blossom.baseOpacity * opacityMultiplier,
      color: blossom.color,
      final,
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
  // `applyBakeSafety: true` for every system, foreground AND each echo
  // (session 019) -- bake-order safety is already fully resolved per tick,
  // per bucket, by resolveBakeThreats (stepState), so this just reads each
  // branch's own persisted `bakeResolved` flag (docs/HANDOFF.md bake-order
  // fix); no per-call computation happens here. Echoes are each their own
  // separate compositor bucket (live-compositor.ts's bucketFor), so an
  // echo branch's `bakeResolved` reflects safety WITHIN its own echo
  // system only -- it was never threatened by, and never threatens,
  // foreground or the other echo.
  for (const system of state.foregroundSystems) {
    emitGrowthSystem(elements, state, system, 0, 1, true);
  }
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    emitGrowthSystem(elements, state, state.echoes[i]!, echoConfig.zOffset, echoConfig.opacityMultiplier, true);
  });

  return { elements };
}

/**
 * The incremental-rendering counterpart to buildScene (src/compositor/
 * live-compositor.ts) -- same systems, same emitGrowthSystem calls, same
 * per-element depth-offset/opacity-multiplier math, just kept as one
 * SceneLayer per growth system instead of flattened into buildScene's
 * single shared array. `layerId` is each system's own `systemId`, which
 * stays stable and unique for the life of a session (as of roadmap C1 the
 * layers are exactly `fg0` + the fixed echoes -- the population model keeps
 * one foreground system). Does not affect buildScene/scene()/finish() in any
 * way -- this is purely additive.
 */
function buildSceneLayers(state: BotanicalState): SceneLayer[] {
  const layers: SceneLayer[] = [];
  // Same bakeResolved-reading contract as buildScene above (including
  // `applyBakeSafety: true` for echoes as of session 019) -- both just
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
    emitGrowthSystem(elements, state, state.echoes[i]!, echoConfig.zOffset, echoConfig.opacityMultiplier, true);
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

    latestMechanismSample(): MechanismSample | null {
      return state.mechanismSample;
    },
  };

  return { renderer, state };
}

export function createBotanicalStyle(tuning?: Partial<BotanicalTuningConfig>): StyleRenderer {
  return createBotanicalInternal(tuning).renderer;
}
