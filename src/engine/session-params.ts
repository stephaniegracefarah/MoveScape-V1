/**
 * Session-level movement parameters (spec Part 3): derived from the whole
 * recording seen so far, not one frame at a time. Where MovementParams
 * (src/adapters/movement-params.ts) gives styles instantaneous qualities
 * that can create sparks in the moment, SessionParams gives styles "a
 * second layer to work with" -- a session-level quality that gradually
 * shapes the structure of the whole world.
 *
 * Computed as a running accumulator updated once per simulation tick
 * (O(1) per tick, O(n) total over a session) rather than by rescanning the
 * recording array on each tick -- ticks are uniform-duration, so a running
 * accumulator both stays cheap and naturally time-weights correctly, since
 * every tick represents equal elapsed time.
 */

export interface SessionParams {
  /** Milliseconds elapsed in the session as of the current tick. */
  duration: number;
  /** Fraction (0-1) of ticks so far with speed below STILLNESS_SPEED_THRESHOLD. */
  stillnessRatio: number;
  /** Mean speed (0-1) over ticks so far. */
  averageEnergy: number;
  /** Population variance of speed over ticks so far. */
  movementVariance: number;
}

/** Matches spec Part 3's POC-derived dead-zone finding ("a speed dead-zone (~0.05)"). */
export const STILLNESS_SPEED_THRESHOLD = 0.05;

export const INITIAL_SESSION_PARAMS: SessionParams = {
  duration: 0,
  stillnessRatio: 0,
  averageEnergy: 0,
  movementVariance: 0,
};

export interface SessionParamsAccumulator {
  /** Call once per simulation tick with that tick's held sample and the tick's own elapsed-ms (the same `time` value passed to style.step). */
  update(speed: number, elapsedMs: number): void;
  /** Cheap snapshot — safe to call every tick. */
  current(): SessionParams;
}

export function createSessionParamsAccumulator(): SessionParamsAccumulator {
  let tickCount = 0;
  let mean = 0;
  let m2 = 0; // Welford's running sum of squared deviations from the mean.
  let stillTickCount = 0;
  let duration = 0;

  return {
    update(speed: number, elapsedMs: number): void {
      tickCount += 1;
      // Welford's online algorithm: numerically stable running mean/variance,
      // and -- since ticks are always processed in the same chronological
      // order for both live sessions and replays -- the accumulated
      // floating-point result is bit-identical across the two.
      const delta = speed - mean;
      mean += delta / tickCount;
      const delta2 = speed - mean;
      m2 += delta * delta2;

      if (speed < STILLNESS_SPEED_THRESHOLD) {
        stillTickCount += 1;
      }

      duration = elapsedMs;
    },

    current(): SessionParams {
      if (tickCount === 0) {
        return INITIAL_SESSION_PARAMS;
      }
      return {
        duration,
        stillnessRatio: stillTickCount / tickCount,
        averageEnergy: mean,
        movementVariance: m2 / tickCount, // population variance
      };
    },
  };
}
