/**
 * The adapter interface every input source implements (invariant 1: the
 * MovementParams contract is the only coupling between adapters and
 * everything downstream).
 */
import type { MovementParams } from './movement-params';

/** Receives each new sample as the adapter produces it. */
export type ParamsListener = (params: MovementParams, timestampMs: number) => void;

/**
 * One tracked body point, normalized 0-1 in the source image's own frame
 * (MediaPipe's convention — nothing flipped or mirrored; mirroring stays a
 * CSS display concern, spec Part 3). Deliberately a minimal generic shape
 * so the adapter contract doesn't couple to any one tracker's landmark type
 * (invariant 1); the webcam adapter's own `PoseLandmarkPoint` is
 * structurally compatible.
 */
export interface PosePoint {
  x: number;
  y: number;
  z: number;
}

export interface InputAdapter {
  id: string;
  /** Begin producing samples; resolves once the adapter is live. */
  start(onParams: ParamsListener): Promise<void>;
  /** Stop producing samples and release resources (camera, workers, timers). */
  stop(): void;
  /**
   * Optional: a live preview stream for adapters that have one (the webcam).
   * Purely a UI affordance — tracking never depends on it, and the preview
   * element must apply mirroring via CSS transform only (spec Part 3).
   * Returns null when the adapter is not running.
   */
  previewStream?(): MediaStream | null;
  /**
   * Optional: live-retunes the sensor-noise floor subtracted from the raw
   * speed reading before it becomes MovementParams.speed (the webcam
   * adapter only — POSE_PARAM_TUNING.SPEED_JITTER_FLOOR). Dev-only pose
   * tuning affordance (main.ts): this constant can only really be
   * calibrated against a real camera, not blind, so it's adjustable live
   * instead of requiring a redeploy per guess. A no-op while not running.
   */
  setSpeedJitterFloor?(value: number): void;
  /**
   * Optional: the most recent frame's tracked body points (33 for the
   * webcam adapter's MediaPipe pose), or null before the first detection /
   * while not running / when the adapter has no pose concept (the sliders
   * adapter). Purely a UI affordance for the "Show the magic" skeleton
   * overlay (UX Stage 2) — like `previewStream()`, tracking never depends
   * on anyone reading this, and it stays outside the MovementParams
   * contract (invariant 1: this is an adapter→UI affordance, never seen by
   * the world layer or styles). Pull-based on purpose: the overlay redraws
   * on its own animation frame and just reads the latest value each time.
   */
  latestPose?(): readonly PosePoint[] | null;
}
