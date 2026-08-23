/**
 * Botanical style (spec Part 4, M4): Branch data model plus the pure,
 * isolated-testable growth/wander/lifecycle math. Randomness itself is
 * never drawn in here -- callers (botanical.ts) draw from labeled
 * streams/noise and pass already-resolved numbers in, so every function in
 * this file is a pure function of its explicit arguments (invariant 4).
 *
 * Angle convention used throughout Botanical: 0 = pointing along +x
 * (right), increasing clockwise (canvas y grows downward), so "straight
 * up" is -PI/2.
 */
import { clamp01 } from '../../shared/math';
import type { BotanicalTuningConfig } from './tuning-config';

// Persistence (docs/styles/botanical.md section 7, decided 2026-08-22): marks
// are permanent ink. There is no 'shrinking' state and nothing is ever
// removed -- a branch grows, matures, and stays exactly as it is forever.
// Liveliness comes from continued new growth at generation-0 roots (see
// botanical.ts's stepGrowthSystem), not from anything disappearing.
export type BranchLifecycle = 'growing' | 'mature';

export interface Branch {
  id: string;
  generation: number;
  /** Which root (0-based, within its own growth system) this branch's lineage descends from -- set explicitly at spawn (spawnRootBranch in botanical.ts) and inherited unchanged by every forked descendant (spawnChildBranch), so a branch's own root lineage is always known directly rather than needing to be parsed back out of its `id` string. Used by the cross-root bake-order safety check (isSafeToBake in botanical.ts) to tell which of a system's roots a given branch belongs to. */
  rootIndex: number;
  z: number;
  color: string;

  rootX: number;
  rootY: number;
  baseDirection: number;
  direction: number;
  tipX: number;
  tipY: number;
  sweepTarget: number;

  grownLength: number;
  targetLength: number;
  segments: { x: number; y: number }[];
  baseWidth: number;

  lifecycle: BranchLifecycle;
  /** Counts up while mature. For a generation-0 branch, reaching matureDurationMs triggers the next sibling at this root (front-driven new growth) and resets to 0 -- see botanical.ts's stepGrowthSystem. Non-root branches just carry it, unused, once mature. */
  lifecycleTimer: number;
  matureDurationMs: number;

  forkFractions: number[];
  forkedFractions: boolean[];
}

// Internal tuning constants formerly hardcoded here (MAX_GENERATION,
// SPEED_FLOOR, SYMMETRY_DAMPING, WIND_STRENGTH, SHRINK_RATE, BASE_GROWTH_SCALE,
// TARGET_LENGTH_BASE, TARGET_LENGTH_JITTER_SPAN, GENERATION_LENGTH_DECAY,
// BRANCH_SEGMENT_RADIUS, BRANCH_BASE_OPACITY, MAX_SAT, SAT_FALLOFF, MIN_LIGHT,
// LIGHT_RISE) now live in tuning-config.ts's BotanicalTuningConfig, threaded
// through the functions below as an explicit `tuning` argument -- see
// DEFAULT_BOTANICAL_TUNING_CONFIG for their (unchanged) default values.

/**
 * Shortest signed angle (radians, wrapped to [-PI, PI]) you'd add to `from`
 * to reach `to`. Handles the 0/2*PI wraparound so a caller can always rotate
 * "the short way around" rather than always the same rotational direction.
 */
export function angleDifference(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let diff = (to - from) % twoPi;
  if (diff < -Math.PI) diff += twoPi;
  if (diff > Math.PI) diff -= twoPi;
  return diff;
}

/**
 * Growth formula (invariant 6): a pure, noise-free function of dt and
 * params.speed (plus fixed constants / the knob-derived multiplier) only.
 * This is exactly what the "speed drives growth honestly" tests assert
 * against, computed independently.
 */
export function growthStepFor(args: {
  dt: number;
  speed: number;
  baseGrowthPerTick: number;
  tuning: BotanicalTuningConfig;
}): number {
  const speedFloor = args.tuning.speedFloor;
  return args.baseGrowthPerTick * args.dt * (speedFloor + args.speed * (1 - speedFloor));
}

/**
 * Wander formula: direction-only, grown-length-scaled (not time-scaled) for
 * the noise term, so curvature-per-unit-length stays constant regardless of
 * how fast a branch grows -- plus a small dt-scaled constant pull toward
 * the world's wind angle. `noise01` must be pre-sampled by the caller via
 * createLabeledNoise(sessionSeed, branch.id + ':wander')(branch.grownLength)
 * -- this function itself never touches randomness.
 */
export function wanderDeltaFor(args: {
  noise01: number;
  wanderAmplitudeBase: number;
  symmetry: number;
  expansion: number;
  dt: number;
  windAngle: number;
  currentDirection: number;
  sweepTarget: number;
  tuning: BotanicalTuningConfig;
}): number {
  const signedNoise = args.noise01 * 2 - 1;
  const wanderAmplitude =
    args.wanderAmplitudeBase * (1 - args.symmetry * args.tuning.symmetryDamping) * (0.7 + args.expansion * 0.6);
  const windPull = args.tuning.windStrength * args.dt * angleDifference(args.currentDirection, args.windAngle);
  const sweepPull =
    args.tuning.sweepStrength * args.dt * angleDifference(args.currentDirection, args.sweepTarget);
  return signedNoise * wanderAmplitude + windPull + sweepPull;
}

/** targetLength for a freshly-spawned branch: jittered base, decayed per generation. */
export function computeTargetLength(
  baseTargetLength: number,
  jitterDraw01: number,
  generation: number,
  tuning: BotanicalTuningConfig,
): number {
  const jitterMultiplier = 0.7 + jitterDraw01 * tuning.targetLengthJitterSpan;
  return baseTargetLength * jitterMultiplier * tuning.generationLengthDecay ** generation;
}

/** matureDurationMs for a branch entering 'mature', drawn once at that transition. */
export function computeMatureDurationMs(baseMatureDurationMs: number, jitterDraw01: number): number {
  return baseMatureDurationMs * (0.7 + jitterDraw01 * 0.6);
}

export interface SpawnBranchArgs {
  id: string;
  generation: number;
  rootIndex: number;
  z: number;
  color: string;
  rootX: number;
  rootY: number;
  baseDirection: number;
  targetLength: number;
  sweepTarget: number;
  baseWidth: number;
  forkFractions: number[];
}

/**
 * Builds a freshly-spawned branch in 'growing' state. Pure: every value
 * that would otherwise require randomness (color, targetLength, baseDirection,
 * z-jitter, ...) must already be resolved by the caller and passed in.
 */
export function spawnBranch(args: SpawnBranchArgs): Branch {
  return {
    id: args.id,
    generation: args.generation,
    rootIndex: args.rootIndex,
    z: args.z,
    color: args.color,
    rootX: args.rootX,
    rootY: args.rootY,
    baseDirection: args.baseDirection,
    direction: args.baseDirection,
    tipX: args.rootX,
    tipY: args.rootY,
    sweepTarget: args.sweepTarget,
    grownLength: 0,
    targetLength: args.targetLength,
    segments: [{ x: args.rootX, y: args.rootY }],
    baseWidth: args.baseWidth,
    lifecycle: 'growing',
    lifecycleTimer: 0,
    matureDurationMs: 0,
    forkFractions: args.forkFractions,
    forkedFractions: args.forkFractions.map(() => false),
  };
}

/**
 * Mutates `branch` one growing tick forward: advances grownLength (honest
 * growth, invariant 6), direction (wander), tip position, and appends a
 * permanent segment. Returns true if this tick crossed into maturity (the
 * caller is responsible for the mature-transition side effects: blossom
 * spawn, matureDurationMs draw).
 */
export function tickGrowing(
  branch: Branch,
  args: {
    dt: number;
    speed: number;
    symmetry: number;
    expansion: number;
    windAngle: number;
    noise01: number;
    baseGrowthPerTick: number;
    wanderAmplitudeBase: number;
    tuning: BotanicalTuningConfig;
  },
): boolean {
  const growthStep = growthStepFor({
    dt: args.dt,
    speed: args.speed,
    baseGrowthPerTick: args.baseGrowthPerTick,
    tuning: args.tuning,
  });
  const directionDelta = wanderDeltaFor({
    noise01: args.noise01,
    wanderAmplitudeBase: args.wanderAmplitudeBase,
    symmetry: args.symmetry,
    expansion: args.expansion,
    dt: args.dt,
    windAngle: args.windAngle,
    currentDirection: branch.direction,
    sweepTarget: branch.sweepTarget,
    tuning: args.tuning,
  });

  branch.grownLength += growthStep;
  branch.direction += directionDelta;
  // x is world-space and unbounded (the Scroll: the canvas grows to fit
  // whatever x content reaches -- see compositor/render-scene.ts's
  // computeCanvasSize), so only y -- the canvas's fixed height -- stays
  // clamped to [0,1]. Clamping x here would hard-cap every branch's growth
  // at world x=1 regardless of how wide the canvas has grown, which is
  // exactly the "extended canvas has no art" bug this comment now guards
  // against (docs/HANDOFF.md, session 011 fold).
  branch.tipX = branch.tipX + Math.cos(branch.direction) * growthStep;
  branch.tipY = clamp01(branch.tipY + Math.sin(branch.direction) * growthStep);
  branch.segments.push({ x: branch.tipX, y: branch.tipY });

  return branch.grownLength >= branch.targetLength;
}

/**
 * Schedules `count` fork points along a branch's own growth path, as
 * fractions of its targetLength, roughly evenly spaced across
 * [tuning.forkFractionMin, tuning.forkFractionMax] with light jitter.
 * `jitterDraws01` must have at least `count` entries (extras ignored);
 * pure function of its arguments only.
 */
export function computeForkFractions(
  count: number,
  jitterDraws01: number[],
  tuning: BotanicalTuningConfig,
): number[] {
  const span = tuning.forkFractionMax - tuning.forkFractionMin;
  const step = count > 0 ? span / count : 0;
  const fractions: number[] = [];
  for (let i = 0; i < count; i++) {
    const center = tuning.forkFractionMin + step * (i + 0.5);
    const signedJitter = (jitterDraws01[i] ?? 0.5) * 2 - 1;
    fractions.push(clamp01(center + signedJitter * step * 0.3));
  }
  return fractions;
}

/**
 * Compares a branch's grownLength/targetLength ratio before and after a
 * growth tick against its scheduled forkFractions, returning the indices
 * of any fractions newly crossed this tick (and marking them fired on the
 * branch itself, mutating `forkedFractions` in place — mirrors tickGrowing's
 * own mutate-and-report style). A fraction already fired is never reported
 * again.
 */
export function checkCrossedForks(branch: Branch, previousGrownLength: number): number[] {
  const previousT = previousGrownLength / branch.targetLength;
  const currentT = branch.grownLength / branch.targetLength;
  const crossed: number[] = [];
  branch.forkFractions.forEach((fraction, i) => {
    if (!branch.forkedFractions[i] && previousT < fraction && currentT >= fraction) {
      branch.forkedFractions[i] = true;
      crossed.push(i);
    }
  });
  return crossed;
}

/** A forked child's baseWidth at its attachment point: a fixed fraction of the parent's own baseWidth. */
export function computeChildBaseWidth(parentBaseWidth: number, tuning: BotanicalTuningConfig): number {
  return parentBaseWidth * tuning.generationWidthDecay;
}
