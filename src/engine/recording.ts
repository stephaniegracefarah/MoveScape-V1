/**
 * The raw timestamped sample array captured during a live session (spec
 * Part 4). This is deliberately NOT the full piece recipe
 * ({ version, styleId, userChoices, worldSeed, sessionIndex, movementRecording })
 * -- that wrapper is a later milestone's job. This module only owns the
 * append-only array of { t, params } samples and the invariant that keeps
 * it valid for sample-and-hold lookup: strictly ascending `t`.
 */
import type { MovementParams, MovementSample } from '../adapters/movement-params';

export type MovementRecording = readonly MovementSample[];

export function recordSample(
  recording: MovementSample[],
  t: number,
  params: MovementParams,
): void {
  const last = recording[recording.length - 1];
  if (last !== undefined && t <= last.t) {
    throw new Error(
      `recordSample: t (${t}) must be strictly greater than the last recorded t (${last.t})`,
    );
  }
  recording.push({ t, params });
}
