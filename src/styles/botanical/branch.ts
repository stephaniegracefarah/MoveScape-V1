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

export type BranchLifecycle = 'growing' | 'mature' | 'shrinking';

export interface Branch {
  id: string;
  generation: number;
  z: number;
  hue: number;

  rootX: number;
  rootY: number;
  baseDirection: number;
  direction: number;
  tipX: number;
  tipY: number;

  grownLength: number;
  targetLength: number;
  segments: { x: number; y: number }[];

  lifecycle: BranchLifecycle;
  lifecycleTimer: number;
  matureDurationMs: number;
  shrinkDurationMs: number;
  shrinkProgress: number;

  subBranchRolled: boolean;
}

// Internal tuning constants formerly hardcoded here (MAX_GENERATION,
// SPEED_FLOOR, SYMMETRY_DAMPING, WIND_STRENGTH, SHRINK_RATE, BASE_GROWTH_SCALE,
// TARGET_LENGTH_BASE, TARGET_LENGTH_JITTER_SPAN, GENERATION_LENGTH_DECAY,
// BRANCH_SEGMENT_RADIUS, BRANCH_BASE_OPACITY, MAX_SAT, SAT_FALLOFF, MIN_LIGHT,
// LIGHT_RISE) now live in tuning-config.ts's BotanicalTuningConfig, threaded
// through the functions below as an explicit `tuning` argument -- see
// DEFAULT_BOTANICAL_TUNING_CONFIG for their (unchanged) default values.

/** Wraps a degree value into [0, 360). */
export function mod360(degrees: number): number {
  const m = degrees % 360;
  return m < 0 ? m + 360 : m;
}

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
  tuning: BotanicalTuningConfig;
}): number {
  const signedNoise = args.noise01 * 2 - 1;
  const wanderAmplitude =
    args.wanderAmplitudeBase * (1 - args.symmetry * args.tuning.symmetryDamping) * (0.7 + args.expansion * 0.6);
  const windPull = args.tuning.windStrength * args.dt * angleDifference(args.currentDirection, args.windAngle);
  return signedNoise * wanderAmplitude + windPull;
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

/** shrinkDurationMs for a branch entering 'shrinking', proportional to how much it grew. */
export function computeShrinkDurationMs(grownLength: number, tuning: BotanicalTuningConfig): number {
  return grownLength / tuning.shrinkRate;
}

/** Hue for a freshly-spawned root/resprout branch: hueBase +/- hueSpread. */
export function computeHue(hueBaseDegrees: number, hueSpreadDegrees: number, signedDraw: number): number {
  return mod360(hueBaseDegrees + signedDraw * hueSpreadDegrees);
}

/** hsl() color string per the depth formula: dark+saturated near, pale+faded far. */
export function computeColor(hue: number, z: number, tuning: BotanicalTuningConfig): string {
  const saturation = tuning.maxSat - z * tuning.satFalloff;
  const lightness = tuning.minLight + z * tuning.lightRise;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * How many segments (from the START of the array) are visible while
 * shrinking, retracting from the tip end as shrinkProgress advances. The
 * real `segments` array is never truncated -- this is computed fresh each
 * scene-build call.
 */
export function visibleSegmentCount(totalSegments: number, shrinkProgress: number): number {
  const remainingFraction = 1 - shrinkProgress;
  return Math.ceil(totalSegments * remainingFraction);
}

export interface SpawnBranchArgs {
  id: string;
  generation: number;
  z: number;
  hue: number;
  rootX: number;
  rootY: number;
  baseDirection: number;
  targetLength: number;
}

/**
 * Builds a freshly-spawned branch in 'growing' state. Pure: every value
 * that would otherwise require randomness (hue, targetLength, baseDirection,
 * z-jitter, ...) must already be resolved by the caller and passed in.
 */
export function spawnBranch(args: SpawnBranchArgs): Branch {
  return {
    id: args.id,
    generation: args.generation,
    z: args.z,
    hue: args.hue,
    rootX: args.rootX,
    rootY: args.rootY,
    baseDirection: args.baseDirection,
    direction: args.baseDirection,
    tipX: args.rootX,
    tipY: args.rootY,
    grownLength: 0,
    targetLength: args.targetLength,
    segments: [{ x: args.rootX, y: args.rootY }],
    lifecycle: 'growing',
    lifecycleTimer: 0,
    matureDurationMs: 0,
    shrinkDurationMs: 0,
    shrinkProgress: 0,
    subBranchRolled: false,
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
    tuning: args.tuning,
  });

  branch.grownLength += growthStep;
  branch.direction += directionDelta;
  branch.tipX = clamp01(branch.tipX + Math.cos(branch.direction) * growthStep);
  branch.tipY = clamp01(branch.tipY + Math.sin(branch.direction) * growthStep);
  branch.segments.push({ x: branch.tipX, y: branch.tipY });

  return branch.grownLength >= branch.targetLength;
}
