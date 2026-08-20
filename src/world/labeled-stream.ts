/**
 * The one function any world/style code should call for randomness (spec
 * Part 3). Combines a seed string with a label into a fresh hash->PRNG
 * chain, so that different labels are statistically independent and adding
 * a new label never perturbs any other label's output sequence.
 */
import { cyrb53 } from '../shared/hash';
import { createMulberry32, type Prng } from '../shared/prng';

// A control character separator (U+0001, "start of heading"). Seed strings
// elsewhere use '::' as a separator for their own composite parts, so a
// control character -- built via fromCharCode rather than an inline literal,
// to keep it visible in editors/diffs -- avoids any collision with real
// seed/label content.
const SEPARATOR = String.fromCharCode(1);

/**
 * Builds a fresh, independent Prng for a given (seed, label) pair. Always
 * constructs a new hash and a new PRNG on every call -- never advances or
 * shares state with any other call, regardless of label.
 */
export function createLabeledStream(seed: string, label: string): Prng {
  const combined = `${seed}${SEPARATOR}${label}`;
  const hashed = cyrb53(combined);
  return createMulberry32(hashed);
}
