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
 * The minimal shape computeGrowingRootStartMinX/isSafeToBake need from a
 * growth system -- a structural subset of GrowthSystemState (which
 * satisfies this automatically, so callers pass state.foregroundSystems
 * directly with no cast) kept separate so both functions stay easily
 * unit-testable with small hand-built fixtures instead of full
 * GrowthSystemState objects (resproutCounters/pendingClusters/etc. are
 * irrelevant to this check).
 */
export interface RootBakeSafetySystem {
  systemId: string;
  roots: { x: number; z: number }[];
  branches: { rootIndex: number; rootX: number; lifecycle: 'growing' | 'mature' }[];
}

/**
 * For every (systemId, rootIndex) lineage, the smallest rootX among its
 * currently-STILL-GROWING branches -- keyed `${systemId}:${rootIndex}`.
 * This (not a "how far has it grown" frontier) is the quantity
 * isSafeToBake actually needs, for a subtle but important reason: the live
 * compositor bakes a stroke whole, in one shot, only once it matures
 * (live-compositor.ts's drawStrokeElementFully bakes every segment from
 * index 0), covering its ENTIRE path from its own rootX (fixed at spawn,
 * never moves) onward. A branch's CURRENT tipX while still growing says
 * nothing about that future bake -- it will still include everything back
 * to its own rootX once it finally matures, however much further it grows
 * meanwhile. So a NOT-YET-MATURE branch is a live threat to any nearby
 * content with x >= its rootX, for as long as it keeps growing; a MATURE
 * branch, by contrast, poses no threat at all regardless of its tipX --
 * once mature it either already baked (an earlier frame) or is baking
 * THIS frame, sorted correctly by z alongside whatever else bakes this
 * same frame (live-compositor.ts's collectAndBakeBucket) -- either way its
 * bake-order relative to anything checking safety now is already resolved
 * correctly. (An earlier version of this fix tracked "max tipX reached by
 * any mature branch" instead; testing found it insufficient -- a fast,
 * shallow FORKED CHILD of the farther root can mature and report a
 * generous tipX while that root's own slower, root-covering branch is
 * still growing and will still bake later, still covering the origin
 * region. Gating on growing branches' own rootX instead of mature
 * branches' tipX closes that gap directly.)
 *
 * A lineage with no currently-growing branch at all (every branch mature,
 * or --degenerate/test-fixture only, since a real root always has >=1
 * branch from init onward -- no branches yet) has no entry here;
 * isSafeToBake's own fallback distinguishes "definitely no threat right
 * now" from "never grew, worst case" (see its own doc comment).
 */
export function computeGrowingRootStartMinX(systems: RootBakeSafetySystem[]): Map<string, number> {
  const minX = new Map<string, number>();
  for (const system of systems) {
    for (const branch of system.branches) {
      if (branch.lifecycle !== 'growing') continue;
      const key = `${system.systemId}:${branch.rootIndex}`;
      const current = minX.get(key);
      if (current === undefined || branch.rootX < current) {
        minX.set(key, branch.rootX);
      }
    }
  }
  return minX;
}

/**
 * The cross-root bake-order safety check (docs/HANDOFF.md, cross-root
 * paint-order bug): a piece of content at (ownSystemId, ownRootIndex, ownZ,
 * ownTipX) is safe to permanently bake (or, for a blossom, to be revealed
 * into the scene) only if, for every OTHER root sharing the same
 * compositor bucket that is currently FARTHER (larger z -- nearer-z roots
 * painting over farther-z roots is already correct, expected behavior),
 * NO currently-growing branch of that root starts (`rootX`) at or before
 * this content's own x position plus `margin` -- see
 * computeGrowingRootStartMinX's own doc comment for why growing branches'
 * OWN start point, not how far anything has grown, is what actually
 * determines future bake-order risk.
 *
 * A root with no growing-branch entry (computeGrowingRootStartMinX) --
 * every one of its branches mature, the ordinary case whenever a root
 * happens to be between one branch maturing and its next resprout starting
 * -- has no active threat right now and is treated as infinitely safe.
 *
 * Only ever needs to consider OTHER roots -- a root can never threaten its
 * own content (same lineage always bakes in its own arrival order, which is
 * already correct within one root), so same-(systemId,rootIndex) pairs are
 * always skipped.
 *
 * Only a system with MORE THAN ONE root can ever supply a threatening
 * "other root": the confirmed bug's whole precondition is the structural
 * guarantee that within one system, a higher rootIndex is ALWAYS farther
 * (initGrowthSystem's `z = clamp01((i + zJitter) / rootCount)`), so a
 * higher-index root can genuinely still be catching up to a lower-index
 * root's own content. A system with exactly one root carries no such
 * guarantee at all -- that lone root's z is just one arbitrary draw
 * (rootCount=1 collapses the same formula to `clamp01(zJitter)`, uniform
 * over the whole depth range), unrelated by construction to any other
 * system's own root(s). This matters in practice: the growth-plateau
 * hand-off (maybeSpawnNextForegroundSystem) appends a new always-single-root
 * foreground system once an earlier one fills up, so a long session
 * ordinarily has several single-root systems live in the same 'foreground'
 * compositor bucket at once even when every individual system only ever had
 * 1 root -- treating those as mutual threats would gate on a coincidental,
 * meaningless z relationship instead of the real bug, with no way to ever
 * resolve (two single-root systems' roots don't converge the way two roots
 * racing down the same system's shared sweep do). Skipping single-root
 * systems entirely keeps the single-root case a true no-op end-to-end, at
 * any number of foreground systems, exactly matching this fix's own
 * regression requirement.
 */
export function isSafeToBake(args: {
  ownSystemId: string;
  ownRootIndex: number;
  ownZ: number;
  ownTipX: number;
  allSystems: RootBakeSafetySystem[];
  growingRootStartMinX: Map<string, number>;
  margin: number;
}): boolean {
  for (const system of args.allSystems) {
    if (system.roots.length <= 1) continue;
    for (let rootIndex = 0; rootIndex < system.roots.length; rootIndex++) {
      if (system.systemId === args.ownSystemId && rootIndex === args.ownRootIndex) continue;
      const otherZ = system.roots[rootIndex]!.z;
      if (otherZ <= args.ownZ) continue; // only a FARTHER root can later paint over this content
      const key = `${system.systemId}:${rootIndex}`;
      // No entry -> no currently-growing branch for this root -> no active
      // threat right now (Infinity, never <= anything finite).
      const threatStartX = args.growingRootStartMinX.get(key) ?? Infinity;
      if (threatStartX <= args.ownTipX + args.margin) return false;
    }
  }
  return true;
}

/**
 * Bundles everything isSafeToBake needs about the current cross-root
 * foreground state -- computed once per tick (stepState, for blossom-reveal
 * gating) or once per scene emission (buildScene/buildSceneLayers, for
 * stroke finality gating), then threaded down to each individual branch's
 * or blossom's own isSafeToBake call rather than recomputed per-element.
 * `allSystems` is always `state.foregroundSystems` -- echoes are each their
 * own separate compositor bucket (live-compositor.ts's bucketFor), so they
 * neither need this check applied to them nor participate as an "other
 * root" in anyone else's check (see stepState/buildScene: echo calls pass
 * `undefined` for this instead of a CrossRootBakeSafety).
 */
interface CrossRootBakeSafety {
  growingRootStartMinX: Map<string, number>;
  allSystems: GrowthSystemState[];
  margin: number;
}

function computeCrossRootBakeSafety(state: BotanicalState): CrossRootBakeSafety {
  return {
    growingRootStartMinX: computeGrowingRootStartMinX(state.foregroundSystems),
    allSystems: state.foregroundSystems,
    margin: state.tuning.crossRootBakeSafetyMargin,
  };
}

/** True if the next not-yet-revealed blossom in `pending` (if any) is safe to reveal right now per the cross-root bake-order check -- `safety === undefined` (echo systems, which never need this check) always returns true. */
function isNextBlossomSafe(pending: PendingBlossomCluster, systemId: string, safety: CrossRootBakeSafety | undefined): boolean {
  if (safety === undefined) return true;
  const next = pending.blossoms[pending.revealedCount]!;
  return isSafeToBake({
    ownSystemId: systemId,
    ownRootIndex: next.rootIndex,
    ownZ: next.z,
    ownTipX: next.x,
    allSystems: safety.allSystems,
    growingRootStartMinX: safety.growingRootStartMinX,
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
 * safe to bake per isNextBlossomSafe (cross-root bake-order check) is left
 * pending: the timer is NOT decremented and the blossom is NOT pushed, so
 * `revealTimerMs` keeps accumulating (already incremented this tick, above
 * the while loop) and gets rechecked next tick without losing progress or
 * double-counting. `safety === undefined` (echo systems) skips this check
 * entirely, reproducing the pre-fix behavior exactly.
 */
function revealPendingBlossoms(
  system: GrowthSystemState,
  systemId: string,
  dt: number,
  intervalMs: number,
  speed: number,
  speedFloor: number,
  safety: CrossRootBakeSafety | undefined,
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
      isNextBlossomSafe(pending, systemId, safety)
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
  bakeSafety: CrossRootBakeSafety | undefined,
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
    systemId,
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

  // Computed once per tick, before the per-system loop -- doesn't depend on
  // which system/branch/blossom is being checked, so every foreground
  // system this tick shares the same snapshot (docs/HANDOFF.md cross-root
  // bake-order fix). Echoes never receive this (see CrossRootBakeSafety's
  // own doc comment) -- each echo is its own separate compositor bucket.
  const bakeSafety = computeCrossRootBakeSafety(state);

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
}

/** Emits one growth system's branches/blossoms as scene elements, applying its z-offset (depth-echo placement) and opacity multiplier (depth-echo paleness) on top of each element's own values. zOffset=0/opacityMultiplier=1 for the foreground system is a no-op. */
/**
 * The furthest-right x any point of `branch`'s own path has ever reached --
 * NOT necessarily its current `tipX`. Wander can occasionally curve a
 * branch's direction enough that it ends up net-negative relative to where
 * it started, or otherwise finishes to the left of an earlier point along
 * its own path (docs/HANDOFF.md cross-root bake-order fix: found via the
 * fix's own wide-seed verification sweep). isSafeToBake's `ownTipX` is
 * meant to answer "how far right does this content's own path actually
 * reach" (the relevant question for whether a farther root's still-growing
 * branch could still catch up and overlap it) -- using the raw, possibly
 * backward-drifted `tipX` there would understate that reach and let content
 * bake before it's genuinely safe. Only relevant for this safety check;
 * every other use of `tipX` in this file (front-driven resprout position,
 * growth-plateau hand-off anchoring, wherever a branch actually IS right
 * now) intentionally means the literal current tip, not this.
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
  bakeSafety?: CrossRootBakeSafety,
): void {
  for (const branch of system.branches) {
    if (branch.segments.length < 2) continue; // a stroke needs at least 2 points

    // A mature branch is only reported final (and therefore only baked by
    // the live compositor -- docs/HANDOFF.md cross-root bake-order fix) once
    // it's also safe: no other, farther root sharing this bucket could
    // still arrive later and permanently paint over it. bakeSafety is
    // undefined for echo systems (their own separate compositor bucket --
    // no cross-root risk there), where this is exactly the pre-fix check.
    const final =
      branch.lifecycle === 'mature' &&
      (bakeSafety === undefined ||
        isSafeToBake({
          ownSystemId: system.systemId,
          ownRootIndex: branch.rootIndex,
          ownZ: branch.z,
          ownTipX: branchMaxReachX(branch),
          allSystems: bakeSafety.allSystems,
          growingRootStartMinX: bakeSafety.growingRootStartMinX,
          margin: bakeSafety.margin,
        }));

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
  // Computed once per call, not per branch -- doesn't depend on which
  // branch is being checked (docs/HANDOFF.md cross-root bake-order fix).
  // Applies only to foreground systems; echoes are each their own separate
  // compositor bucket, so they're emitted exactly as before (no bakeSafety).
  const bakeSafety = computeCrossRootBakeSafety(state);

  for (const system of state.foregroundSystems) {
    emitGrowthSystem(elements, state, system, 0, 1, bakeSafety);
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
  // Same bakeSafety contract as buildScene above -- computed once per call,
  // applies only to foreground systems, so this stays byte-for-byte
  // consistent with buildScene's own `final` values for the same state
  // (sceneLayers' own doc comment / the "never silently out of sync with
  // scene()" test both require this).
  const bakeSafety = computeCrossRootBakeSafety(state);

  for (const system of state.foregroundSystems) {
    const elements: SceneElement[] = [];
    emitGrowthSystem(elements, state, system, 0, 1, bakeSafety);
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
