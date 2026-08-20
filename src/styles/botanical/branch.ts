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

// --- Internal constants (not world knobs -- first-pass values, expected to
// get retuned after a live visual pass; each documented at its use site). ---

/** Recursion depth cap for sub-branches. The reference image shows fairly
 * dense fanning of thin branches, so this errs a bit above a minimal guess. */
export const MAX_GENERATION = 4;

/** Fraction of max growth rate that still applies at speed=0 -- "any
 * movement counts," true stillness still yields a faint trickle of growth. */
export const SPEED_FLOOR = 0.06;

/** How much symmetry=1 damps wander amplitude vs symmetry=0. */
export const SYMMETRY_DAMPING = 0.85;

/** Scales the constant directional pull toward the world's windAngle knob.
 * Small and dt-scaled (ms), so its per-tick contribution stays comparable
 * to the noise-driven wander term rather than overwhelming it. */
export const WIND_STRENGTH = 0.0005;

/** grownLength (normalized units) per millisecond while shrinking. Picked
 * so a fully-grown branch fades away noticeably faster than it grew --
 * "fading away," not slow-motion growth in reverse. */
export const SHRINK_RATE = 0.0002;

/** Internal per-ms growth scale folded into baseGrowthPerTick alongside the
 * baseGrowthRate knob (0.5-2.0) -- tuned so growth reads at a reasonable
 * multi-second pace at 60Hz with a mid-range baseGrowthRate. */
export const BASE_GROWTH_SCALE = 0.00005;

/** Root/generation-0 target branch length before generation-based decay,
 * in normalized canvas units. */
export const TARGET_LENGTH_BASE = 0.35;

/** targetLength jitter multiplier lands in [0.7, 1.3). */
export const TARGET_LENGTH_JITTER_SPAN = 0.6;

/** Each sub-branch generation is half the (jittered) length of its parent's base. */
export const GENERATION_LENGTH_DECAY = 0.5;

/** Fixed line-segment radius (normalized, fraction of shorter side) that
 * makes many closely-spaced segment points read as a thin line, not a blob. */
export const BRANCH_SEGMENT_RADIUS = 0.003;

/** Branches read as solid, near-opaque lines (unlike genuinely translucent blossoms). */
export const BRANCH_BASE_OPACITY = 0.92;

// Color formula constants: dark + saturated near (z=0), pale + faded far (z=1).
export const MAX_SAT = 70;
export const SAT_FALLOFF = 45; // saturation range ~25-70%
export const MIN_LIGHT = 15;
export const LIGHT_RISE = 65; // lightness range ~15-80%

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
export function growthStepFor(args: { dt: number; speed: number; baseGrowthPerTick: number }): number {
  return args.baseGrowthPerTick * args.dt * (SPEED_FLOOR + args.speed * (1 - SPEED_FLOOR));
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
}): number {
  const signedNoise = args.noise01 * 2 - 1;
  const wanderAmplitude =
    args.wanderAmplitudeBase * (1 - args.symmetry * SYMMETRY_DAMPING) * (0.7 + args.expansion * 0.6);
  const windPull = WIND_STRENGTH * args.dt * angleDifference(args.currentDirection, args.windAngle);
  return signedNoise * wanderAmplitude + windPull;
}

/** targetLength for a freshly-spawned branch: jittered base, decayed per generation. */
export function computeTargetLength(baseTargetLength: number, jitterDraw01: number, generation: number): number {
  const jitterMultiplier = 0.7 + jitterDraw01 * TARGET_LENGTH_JITTER_SPAN;
  return baseTargetLength * jitterMultiplier * GENERATION_LENGTH_DECAY ** generation;
}

/** matureDurationMs for a branch entering 'mature', drawn once at that transition. */
export function computeMatureDurationMs(baseMatureDurationMs: number, jitterDraw01: number): number {
  return baseMatureDurationMs * (0.7 + jitterDraw01 * 0.6);
}

/** shrinkDurationMs for a branch entering 'shrinking', proportional to how much it grew. */
export function computeShrinkDurationMs(grownLength: number): number {
  return grownLength / SHRINK_RATE;
}

/** Hue for a freshly-spawned root/resprout branch: hueBase +/- hueSpread. */
export function computeHue(hueBaseDegrees: number, hueSpreadDegrees: number, signedDraw: number): number {
  return mod360(hueBaseDegrees + signedDraw * hueSpreadDegrees);
}

/** hsl() color string per the depth formula: dark+saturated near, pale+faded far. */
export function computeColor(hue: number, z: number): string {
  const saturation = MAX_SAT - z * SAT_FALLOFF;
  const lightness = MIN_LIGHT + z * LIGHT_RISE;
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
  },
): boolean {
  const growthStep = growthStepFor({ dt: args.dt, speed: args.speed, baseGrowthPerTick: args.baseGrowthPerTick });
  const directionDelta = wanderDeltaFor({
    noise01: args.noise01,
    wanderAmplitudeBase: args.wanderAmplitudeBase,
    symmetry: args.symmetry,
    expansion: args.expansion,
    dt: args.dt,
    windAngle: args.windAngle,
    currentDirection: branch.direction,
  });

  branch.grownLength += growthStep;
  branch.direction += directionDelta;
  branch.tipX = clamp01(branch.tipX + Math.cos(branch.direction) * growthStep);
  branch.tipY = clamp01(branch.tipY + Math.sin(branch.direction) * growthStep);
  branch.segments.push({ x: branch.tipX, y: branch.tipY });

  return branch.grownLength >= branch.targetLength;
}
