import { describe, expect, it } from 'vitest';
import {
  computeMovementParams,
  nextStateAfterNoPose,
  POSE_LANDMARK,
  POSE_PARAM_TUNING,
  type PoseFrameState,
  type PoseLandmarkPoint,
} from './params-from-landmarks';

/**
 * Builds a full 33-landmark array from a relaxed, left/right-symmetric
 * T-pose (mirrored about x = 0.5), with any indices in `overrides`
 * replaced. Keeps each test focused on only the points that matter.
 */
function buildLandmarks(overrides: Partial<Record<number, PoseLandmarkPoint>> = {}): PoseLandmarkPoint[] {
  const base: PoseLandmarkPoint[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0 }));

  const defaults: Record<number, PoseLandmarkPoint> = {
    [POSE_LANDMARK.LEFT_SHOULDER]: { x: 0.4, y: 0.3, z: 0 },
    [POSE_LANDMARK.RIGHT_SHOULDER]: { x: 0.6, y: 0.3, z: 0 },
    [POSE_LANDMARK.LEFT_ELBOW]: { x: 0.35, y: 0.4, z: 0 },
    [POSE_LANDMARK.RIGHT_ELBOW]: { x: 0.65, y: 0.4, z: 0 },
    [POSE_LANDMARK.LEFT_WRIST]: { x: 0.3, y: 0.5, z: 0 },
    [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.7, y: 0.5, z: 0 },
    [POSE_LANDMARK.LEFT_HIP]: { x: 0.45, y: 0.6, z: 0 },
    [POSE_LANDMARK.RIGHT_HIP]: { x: 0.55, y: 0.6, z: 0 },
    [POSE_LANDMARK.LEFT_KNEE]: { x: 0.45, y: 0.75, z: 0 },
    [POSE_LANDMARK.RIGHT_KNEE]: { x: 0.55, y: 0.75, z: 0 },
    [POSE_LANDMARK.LEFT_ANKLE]: { x: 0.45, y: 0.9, z: 0 },
    [POSE_LANDMARK.RIGHT_ANKLE]: { x: 0.55, y: 0.9, z: 0 },
    29: { x: 0.45, y: 0.92, z: 0 }, // left heel
    30: { x: 0.55, y: 0.92, z: 0 }, // right heel
    31: { x: 0.45, y: 0.95, z: 0 }, // left foot index
    32: { x: 0.55, y: 0.95, z: 0 }, // right foot index
  };

  for (const [index, point] of Object.entries(defaults)) {
    base[Number(index)] = point;
  }
  for (const [index, point] of Object.entries(overrides)) {
    if (point) base[Number(index)] = point;
  }
  return base;
}

/** Scales every landmark coordinate about the origin — simulates the same
 *  pose standing further from (or closer to) the camera. */
function scaleLandmarks(landmarks: readonly PoseLandmarkPoint[], factor: number): PoseLandmarkPoint[] {
  return landmarks.map((p) => ({ x: p.x * factor, y: p.y * factor, z: p.z * factor }));
}

describe('computeMovementParams — expansion', () => {
  it('grows when the extremities spread further from body center', () => {
    const relaxed = buildLandmarks();
    const spread = buildLandmarks({
      [POSE_LANDMARK.LEFT_WRIST]: { x: 0.05, y: 0.5, z: 0 },
      [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.95, y: 0.5, z: 0 },
    });

    const relaxedResult = computeMovementParams(relaxed, 0, null);
    const spreadResult = computeMovementParams(spread, 0, null);

    expect(spreadResult.params.expansion).toBeGreaterThan(relaxedResult.params.expansion);
  });

  it('is invariant to camera distance — torso normalization', () => {
    const pose = buildLandmarks({
      [POSE_LANDMARK.LEFT_WRIST]: { x: 0.1, y: 0.45, z: 0 },
      [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.9, y: 0.45, z: 0 },
    });
    const scaledDown = scaleLandmarks(pose, 0.4); // same pose, standing further from the camera

    const fullSize = computeMovementParams(pose, 0, null);
    const scaled = computeMovementParams(scaledDown, 0, null);

    expect(scaled.params.expansion).toBeCloseTo(fullSize.params.expansion, 5);
  });
});

describe('computeMovementParams — symmetry', () => {
  it('reads 1 for a perfectly mirrored pose', () => {
    const mirrored = buildLandmarks();
    const result = computeMovementParams(mirrored, 0, null);
    expect(result.params.symmetry).toBeCloseTo(1, 5);
  });

  it('drops for an asymmetric pose', () => {
    const mirroredResult = computeMovementParams(buildLandmarks(), 0, null);
    const asymmetric = buildLandmarks({
      // Right arm raised overhead; left arm stays at the side.
      [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.65, y: 0.15, z: 0 },
    });
    const asymmetricResult = computeMovementParams(asymmetric, 0, null);

    expect(asymmetricResult.params.symmetry).toBeLessThan(mirroredResult.params.symmetry);
  });
});

describe('computeMovementParams — speed', () => {
  it('reads 0 on the first frame (nothing yet to compare against)', () => {
    const result = computeMovementParams(buildLandmarks(), 0, null);
    expect(result.params.speed).toBe(0);
  });

  it('EMA-smoothed speed converges within about 2 frames of sustained fast movement', () => {
    const frameIntervalMs = 1000 / 30;

    const still = buildLandmarks();
    const movedOut = buildLandmarks({
      [POSE_LANDMARK.LEFT_WRIST]: { x: 0.05, y: 0.5, z: 0 },
      [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.95, y: 0.5, z: 0 },
      [POSE_LANDMARK.LEFT_ANKLE]: { x: 0.1, y: 0.9, z: 0 },
      [POSE_LANDMARK.RIGHT_ANKLE]: { x: 0.9, y: 0.9, z: 0 },
    });
    const movedAgain = buildLandmarks({
      [POSE_LANDMARK.LEFT_WRIST]: { x: 0.4, y: 0.05, z: 0 },
      [POSE_LANDMARK.RIGHT_WRIST]: { x: 0.6, y: 0.05, z: 0 },
      [POSE_LANDMARK.LEFT_ANKLE]: { x: 0.3, y: 0.85, z: 0 },
      [POSE_LANDMARK.RIGHT_ANKLE]: { x: 0.7, y: 0.85, z: 0 },
    });

    let state: PoseFrameState | null = null;

    const frame1 = computeMovementParams(still, 0, state);
    state = frame1.state;

    const frame2 = computeMovementParams(movedOut, frameIntervalMs, state);
    state = frame2.state;

    const frame3 = computeMovementParams(movedAgain, frameIntervalMs * 2, state);

    // Both transitions are large enough to saturate the raw pre-EMA reading
    // at the ceiling (1.0) regardless of the exact scale constants, so the
    // EMA trajectory reduces to 1 - (1 - alpha)^n — this keeps the test
    // meaningful even if SPEED_EMA_ALPHA is retuned later.
    const alpha = POSE_PARAM_TUNING.SPEED_EMA_ALPHA;
    expect(frame2.params.speed).toBeCloseTo(1 - (1 - alpha) ** 1, 5);
    expect(frame3.params.speed).toBeCloseTo(1 - (1 - alpha) ** 2, 5);

    // Responds immediately (frame 2) and keeps converging (frame 3) —
    // within the ~2-frame immediacy budget (invariant 6).
    expect(frame2.params.speed).toBeGreaterThan(0);
    expect(frame3.params.speed).toBeGreaterThan(frame2.params.speed);
  });
});

describe('nextStateAfterNoPose', () => {
  const someState: PoseFrameState = { landmarks: buildLandmarks(), timestampMs: 1000, emaSpeed: 0.6 };

  it('carries state forward across a short no-pose gap', () => {
    for (let gap = 1; gap < POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD; gap++) {
      expect(nextStateAfterNoPose(gap, someState)).toBe(someState);
    }
  });

  it('resets to null once the gap reaches the threshold', () => {
    expect(nextStateAfterNoPose(POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD, someState)).toBeNull();
    expect(nextStateAfterNoPose(POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD + 5, someState)).toBeNull();
  });

  it('is a no-op on state that is already null', () => {
    expect(nextStateAfterNoPose(1, null)).toBeNull();
    expect(nextStateAfterNoPose(POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD, null)).toBeNull();
  });
});
