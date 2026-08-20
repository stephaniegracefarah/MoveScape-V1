/** A deterministic pseudo-random generator: each call returns a uniform float in [0, 1). */
export type Prng = () => number;

/**
 * mulberry32: a small, fast, deterministic PRNG. A factory — each call
 * creates an independent generator with its own internal state, so two
 * generators created with the same seed produce identical call sequences.
 *
 * Reference implementation: https://github.com/bryc/code/blob/master/jshash/PRNGs.md
 */
export function createMulberry32(seed: number): Prng {
  let state = seed >>> 0;
  return function mulberry32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
