/**
 * The MovementParams contract — the single coupling point between input
 * adapters (layer 1) and everything downstream (invariant 1). Every adapter
 * emits this vector and only this vector; every consumer reads this vector
 * and only this vector.
 */

export const MOVEMENT_PARAMS_VERSION = 1;

/**
 * Instantaneous movement qualities, one sample per adapter frame.
 * All values are normalized 0–1.
 */
export interface MovementParams {
  /** Contract version; bumps when fields are added so old recordings stay valid. */
  v: typeof MOVEMENT_PARAMS_VERSION;
  /** How far the extremities spread from body center, torso-normalized. */
  expansion: number;
  /** Frame-to-frame movement rate, EMA-smoothed for sensor stability only (invariant 6). */
  speed: number;
  /** How closely mirrored limb pairs match across the body's vertical axis. */
  symmetry: number;
}

/** A timestamped sample as written into a session recording. */
export interface MovementSample {
  /** Milliseconds since session start — the recording's own clock (invariant 4). */
  t: number;
  params: MovementParams;
}
