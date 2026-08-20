/**
 * A pure, deterministic 1D value-noise generator: continuous,
 * smoothly-interpolated pseudo-random noise over a real-valued input `t`
 * (not raw per-integer randomness). Built from this project's own
 * `cyrb53` hash so it never depends on a global/unseeded noise function
 * (spec invariant 2 -- e.g. p5.js's global `noise()` is banned for this
 * project for exactly that reason).
 */
import { cyrb53 } from './hash';

// One more than cyrb53's maximum possible output (2^53 - 1; see hash.ts's
// 53-bit combination of h1/h2). Dividing by 2^53 rather than by the max
// output itself guarantees the normalized result is always strictly below
// 1, matching Prng's [0,1) convention, rather than only "almost always"
// below 1.
const HASH_NORMALIZER = 2 ** 53;

/** A deterministic pseudo-random value in [0,1) for one integer lattice point. */
function latticeValue(seed: number, latticeIndex: number): number {
  return cyrb53(String(latticeIndex), seed) / HASH_NORMALIZER;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smoothstep fade curve (3t^2 - 2t^3). Its derivative, 6t(1-t), is zero at
 * both t=0 and t=1, so interpolated noise doesn't just meet at integer
 * lattice boundaries -- it meets with matching slope too, avoiding the
 * visible slope-discontinuity "kinks" plain linear interpolation would
 * produce there. (Perlin's quintic 6t^5-15t^4+10t^3 also has this property
 * and would work equally well; smoothstep is used here for simplicity.)
 */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * A factory -- each call creates an independent noise function with no
 * shared mutable state, so two generators created with the same seed
 * produce identical output for the same `t` sequence, matching the
 * `createMulberry32` / `createLabeledStream` pattern.
 */
export function createValueNoise1D(seed: number): (t: number) => number {
  return function valueNoise1D(t: number): number {
    const i0 = Math.floor(t);
    const i1 = i0 + 1;
    const frac = t - i0;
    const v0 = latticeValue(seed, i0);
    const v1 = latticeValue(seed, i1);
    return lerp(v0, v1, fade(frac));
  };
}
