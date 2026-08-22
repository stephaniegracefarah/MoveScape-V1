/**
 * The fixed-timestep simulation engine (spec Part 4, invariant 4). Ticks
 * are pure integer indices; time is derived arithmetically from the tick
 * index, never sampled from a wall clock. This makes `advanceTicks` a pure
 * function of its arguments, which is what lets live sessions and replays
 * -- and replays pumped at different tick-batch sizes -- run the identical
 * code path and produce bit-identical output (invariant 3, two-tier
 * determinism).
 */
import type { World } from '../world/world';
import type { Scene, StyleRenderer } from '../styles/style-renderer';
import type { MovementRecording } from './recording';
import { sampleIndexAtOrBefore } from './sample-and-hold';
import { createSessionParamsAccumulator, type SessionParamsAccumulator } from './session-params';

export const SIMULATION_TICK_HZ = 60;
export const SIMULATION_TICK_MS = 1000 / SIMULATION_TICK_HZ;

/**
 * Advances `style` one fixed tick at a time over the half-open tick range
 * [fromTick, toTick), sampling `recording` via sample-and-hold at each
 * tick's time. Returns the sample index reached, to thread into the next
 * call's `fromSampleIndex` -- across a call boundary or within a single
 * call, the cursor only ever advances, so the resulting sequence of
 * `style.step(...)` calls is identical regardless of how the tick range is
 * chunked.
 */
export function advanceTicks(
  style: StyleRenderer,
  recording: MovementRecording,
  fromTick: number,
  toTick: number,
  fromSampleIndex: number,
  accumulator: SessionParamsAccumulator,
  tickMs: number = SIMULATION_TICK_MS,
): number {
  let sampleIndex = fromSampleIndex;

  for (let tick = fromTick; tick < toTick; tick += 1) {
    const time = tick * tickMs;
    sampleIndex = sampleIndexAtOrBefore(recording, time, sampleIndex);
    const sample = recording[sampleIndex];
    if (sample === undefined) {
      // Unreachable: sampleIndexAtOrBefore always returns a valid index
      // into a non-empty recording (it throws on an empty one).
      throw new Error('advanceTicks: sample index out of range');
    }
    accumulator.update(sample.params.speed, time);
    style.step(sample.params, accumulator.current(), time, tickMs);
  }

  return sampleIndex;
}

/**
 * Convenience wrapper: initializes `style` against `world`, ticks it
 * through the entire recording's duration, and returns the final scene.
 * Creates its own SessionParamsAccumulator internally, since it always runs
 * start-to-finish in one call.
 */
export function replay(
  style: StyleRenderer,
  world: World,
  recording: MovementRecording,
  durationMs: number,
  tickMs: number = SIMULATION_TICK_MS,
): Scene {
  style.init(world);
  const toTick = Math.ceil(durationMs / tickMs);
  const accumulator = createSessionParamsAccumulator();
  advanceTicks(style, recording, 0, toTick, 0, accumulator, tickMs);
  return style.finish();
}
