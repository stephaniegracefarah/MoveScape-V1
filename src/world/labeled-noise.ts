/**
 * The value-noise equivalent of `createLabeledStream` (spec Part 3): the
 * one function world/style code should call for a "slow-drifting" noise
 * source, so that different labels are statistically independent and
 * adding a new label never perturbs any other label's output.
 */
import { cyrb53 } from '../shared/hash';
import { createValueNoise1D } from '../shared/noise';
import { combineSeedLabel } from './labeled-stream';

/**
 * Builds a fresh, independent value-noise function for a given
 * (seed, label) pair. Always constructs a new hash and a new noise
 * generator on every call -- never shares state with any other call,
 * regardless of label.
 */
export function createLabeledNoise(seed: string, label: string): (t: number) => number {
  const hashed = cyrb53(combineSeedLabel(seed, label));
  return createValueNoise1D(hashed);
}
