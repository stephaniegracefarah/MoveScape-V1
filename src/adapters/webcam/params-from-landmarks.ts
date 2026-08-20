/**
 * Pure landmark → MovementParams math. No DOM, network, camera, or worker
 * dependencies — this is what makes it unit-testable with synthetic
 * landmark data (see params-from-landmarks.test.ts) and is the single place
 * the expansion/speed/symmetry mapping lives.
 *
 * Coordinates are used exactly as MediaPipe reports them — nothing here
 * flips or mirrors x. Mirroring is a CSS display concern only (spec Part 3,
 * "Technology choices": "handle mirroring through CSS transform only").
 *
 * All tunable constants are gathered in POSE_PARAM_TUNING below. The POC's
 * findings (spec Part 3) are the starting points; retune freely — nothing
 * else in the codebase depends on these specific values.
 */
import { MOVEMENT_PARAMS_VERSION, type MovementParams } from '../movement-params';
import { clamp01 } from '../../shared/math';

/**
 * A single pose landmark's position. Structurally compatible with
 * MediaPipe's `NormalizedLandmark` (which also carries `visibility`) — the
 * pose worker passes MediaPipe's landmarks straight through.
 */
export interface PoseLandmarkPoint {
  x: number;
  y: number;
  z: number;
}

/** Named indices into the 33 MediaPipe Pose landmarks, for the ones this
 *  module reads by name (torso + limb landmarks). */
export const POSE_LANDMARK = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const;

/**
 * Landmarks used for the speed metric: shoulders through feet (indices
 * 11–32). The 11 face landmarks (0–10) are deliberately excluded so small
 * facial jitter can't move the speed reading.
 */
const SPEED_LANDMARK_INDICES: readonly number[] = Array.from({ length: 22 }, (_, i) => i + 11);

/**
 * All tunable constants for the landmark → MovementParams mapping, gathered
 * in one place. Starting points are the POC's hard-won findings (spec Part
 * 3, "The POC's role"): torso-scale normalization, a practical speed
 * ceiling around 0.85, and (for expansion/symmetry) reasonable geometric
 * defaults re-derived for this fresh build.
 */
export const POSE_PARAM_TUNING = {
  /**
   * Extremity-distance-from-center ÷ torso-size ratio that reads as full
   * expansion (1.0). Torso-normalized so camera distance is irrelevant.
   */
  EXPANSION_MAX_RATIO: 2.2,

  /**
   * Floor on torso size (normalized image units) to avoid divide-by-zero /
   * exploding ratios when pose detection is momentarily degenerate.
   */
  MIN_TORSO_SIZE: 0.02,

  /**
   * Practical speed ceiling (POC finding): a raw pre-EMA reading at this
   * value already reads as full-burst (1.0), rather than requiring an
   * unreachable true maximum.
   */
  SPEED_CEILING: 0.85,

  /**
   * Converts torso-normalized landmark displacement rate (torso-units per
   * second) into the raw, pre-ceiling speed reading. Tunable to taste.
   */
  SPEED_RATE_SCALE: 0.28,

  /**
   * EMA smoothing factor for speed (0–1; higher = less smoothing, faster
   * response), applied for sensor stability only (invariant 6) — never
   * noise-blended. Kept high so the smoothed value converges within the
   * ~2-frame immediacy budget.
   */
  SPEED_EMA_ALPHA: 0.5,

  /**
   * Average mirrored-pair positional deviation (torso-normalized) that
   * reads as zero symmetry. A deviation of 0 (perfectly mirrored) reads
   * as 1.
   */
  SYMMETRY_MAX_DEVIATION: 1.0,

  /**
   * Consecutive no-pose frames (nobody confidently detected in view) after
   * which frame-to-frame state resets to null. Without this, a pose
   * reappearing after a gap would compute speed from landmarks that are
   * now stale by the whole gap's duration — dt in the denominator softens
   * that, but a clean reset (re-entry starts speed fresh, like the first
   * frame of a session) is the more honest behavior. Kept small since a
   * gap this short is imperceptible either way.
   */
  NO_POSE_RESET_THRESHOLD: 15,
} as const;

/**
 * Per-frame state threaded from one computeMovementParams call into the
 * next, so this module stays a pure function of
 * (landmarks, timestamp, previous state) instead of hiding mutable state
 * internally.
 */
export interface PoseFrameState {
  landmarks: readonly PoseLandmarkPoint[];
  timestampMs: number;
  emaSpeed: number;
}

function distance(a: PoseLandmarkPoint, b: PoseLandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: PoseLandmarkPoint, b: PoseLandmarkPoint): PoseLandmarkPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Computes one frame of MovementParams from 33 MediaPipe pose landmarks.
 *
 * Pure: given the same (landmarks, timestampMs, previous) it always returns
 * the same result.
 *
 * @param landmarks The 33 MediaPipe Pose landmarks for this frame.
 * @param timestampMs Capture-clock timestamp for this frame, in ms.
 * @param previous The state returned alongside the previous frame's params,
 *   or null for the first frame of a session (speed reads 0 on that frame —
 *   there is nothing yet to compare against).
 */
export function computeMovementParams(
  landmarks: readonly PoseLandmarkPoint[],
  timestampMs: number,
  previous: PoseFrameState | null
): { params: MovementParams; state: PoseFrameState } {
  if (landmarks.length < 33) {
    throw new Error(`computeMovementParams expects 33 pose landmarks, got ${landmarks.length}`);
  }

  const leftShoulder = landmarks[POSE_LANDMARK.LEFT_SHOULDER]!;
  const rightShoulder = landmarks[POSE_LANDMARK.RIGHT_SHOULDER]!;
  const leftElbow = landmarks[POSE_LANDMARK.LEFT_ELBOW]!;
  const rightElbow = landmarks[POSE_LANDMARK.RIGHT_ELBOW]!;
  const leftWrist = landmarks[POSE_LANDMARK.LEFT_WRIST]!;
  const rightWrist = landmarks[POSE_LANDMARK.RIGHT_WRIST]!;
  const leftHip = landmarks[POSE_LANDMARK.LEFT_HIP]!;
  const rightHip = landmarks[POSE_LANDMARK.RIGHT_HIP]!;
  const leftKnee = landmarks[POSE_LANDMARK.LEFT_KNEE]!;
  const rightKnee = landmarks[POSE_LANDMARK.RIGHT_KNEE]!;
  const leftAnkle = landmarks[POSE_LANDMARK.LEFT_ANKLE]!;
  const rightAnkle = landmarks[POSE_LANDMARK.RIGHT_ANKLE]!;

  const midShoulder = midpoint(leftShoulder, rightShoulder);
  const midHip = midpoint(leftHip, rightHip);
  const center = midpoint(midShoulder, midHip);
  const torsoSize = Math.max(distance(midShoulder, midHip), POSE_PARAM_TUNING.MIN_TORSO_SIZE);

  // --- expansion: extremity spread from body center, torso-normalized so
  // camera distance is irrelevant. ---
  const extremities = [leftWrist, rightWrist, leftAnkle, rightAnkle];
  const avgExtremityRatio = mean(extremities.map((p) => distance(p, center))) / torsoSize;
  const expansion = clamp01(avgExtremityRatio / POSE_PARAM_TUNING.EXPANSION_MAX_RATIO);

  // --- symmetry: how closely mirrored limb pairs match across the torso's
  // vertical axis. Reflect the right-side point across that axis (flip its
  // torso-relative x, keep y — mirroring across a vertical line never
  // touches y) and measure its distance from the left-side point; average
  // over the four pairs the spec calls out. ---
  const pairs: ReadonlyArray<readonly [PoseLandmarkPoint, PoseLandmarkPoint]> = [
    [leftWrist, rightWrist],
    [leftElbow, rightElbow],
    [leftKnee, rightKnee],
    [leftAnkle, rightAnkle],
  ];
  const deviations = pairs.map(([left, right]) => {
    const leftRel = { x: (left.x - center.x) / torsoSize, y: (left.y - center.y) / torsoSize };
    const rightRel = { x: (right.x - center.x) / torsoSize, y: (right.y - center.y) / torsoSize };
    const mirroredRight = { x: -rightRel.x, y: rightRel.y };
    return Math.hypot(leftRel.x - mirroredRight.x, leftRel.y - mirroredRight.y);
  });
  const symmetry = clamp01(1 - mean(deviations) / POSE_PARAM_TUNING.SYMMETRY_MAX_DEVIATION);

  // --- speed: frame-to-frame landmark movement rate. Raw reading is
  // ceiling-scaled, then EMA-smoothed for sensor stability only (invariant
  // 6) — never noise-blended, and never the source of the movement signal
  // itself. ---
  let rawSpeed = 0;
  if (previous && timestampMs > previous.timestampMs && previous.landmarks.length >= 33) {
    const dtSeconds = (timestampMs - previous.timestampMs) / 1000;
    const totalDisplacement = SPEED_LANDMARK_INDICES.reduce((sum, idx) => {
      const current = landmarks[idx]!;
      const prior = previous.landmarks[idx]!;
      return sum + distance(current, prior);
    }, 0);
    const avgDisplacement = totalDisplacement / SPEED_LANDMARK_INDICES.length;
    const ratePerSecond = avgDisplacement / torsoSize / dtSeconds;
    rawSpeed = clamp01((ratePerSecond * POSE_PARAM_TUNING.SPEED_RATE_SCALE) / POSE_PARAM_TUNING.SPEED_CEILING);
  }
  const priorEma = previous ? previous.emaSpeed : rawSpeed;
  const emaSpeed = clamp01(priorEma + POSE_PARAM_TUNING.SPEED_EMA_ALPHA * (rawSpeed - priorEma));

  const params: MovementParams = {
    v: MOVEMENT_PARAMS_VERSION,
    expansion,
    speed: emaSpeed,
    symmetry,
  };

  const state: PoseFrameState = {
    landmarks,
    timestampMs,
    emaSpeed,
  };

  return { params, state };
}

/**
 * Decides what frame-to-frame state should carry forward after a frame
 * where no pose was confidently detected. Kept as a small pure function
 * (rather than inline counter logic in the worker) so the reset threshold
 * is unit-testable with plain data.
 *
 * @param consecutiveNoPoseFrames How many frames in a row (including this
 *   one) have had no confidently detected pose.
 * @param previous The state to carry forward if the gap hasn't reached the
 *   reset threshold yet.
 * @returns `previous` unchanged while the gap is short; `null` once the gap
 *   reaches POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD, so the next detected
 *   pose starts speed fresh instead of reading the gap as one huge
 *   displacement.
 */
export function nextStateAfterNoPose(
  consecutiveNoPoseFrames: number,
  previous: PoseFrameState | null
): PoseFrameState | null {
  return consecutiveNoPoseFrames >= POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD ? null : previous;
}
