/**
 * Sample-and-hold lookup over a recorded movement stream (spec Part 4,
 * invariant 4). Given the recording clock's current time, finds the most
 * recent sample at or before that time -- no interpolation between samples.
 *
 * Designed for a forward-only calling pattern: the engine ticks time
 * monotonically forward and threads the returned index back in as the next
 * call's `fromIndex`, so the scan below only ever advances, never rescans
 * from the start (O(1) amortized over a full replay).
 */
import type { MovementSample } from '../adapters/movement-params';

export function sampleIndexAtOrBefore(
  recording: readonly MovementSample[],
  t: number,
  fromIndex = 0,
): number {
  if (recording.length === 0) {
    throw new Error('sampleIndexAtOrBefore: recording is empty');
  }

  let index = fromIndex;
  let next = recording[index + 1];
  while (next !== undefined && next.t <= t) {
    index += 1;
    next = recording[index + 1];
  }
  return index;
}
