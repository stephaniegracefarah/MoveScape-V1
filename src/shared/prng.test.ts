import { describe, expect, it } from 'vitest';
import { createMulberry32 } from './prng';

function draw(prng: () => number, n: number): number[] {
  return Array.from({ length: n }, () => prng());
}

describe('createMulberry32 — determinism', () => {
  it('two independently-created generators with the same seed produce identical sequences', () => {
    const a = createMulberry32(12345);
    const b = createMulberry32(12345);
    expect(draw(a, 10)).toEqual(draw(b, 10));
  });
});

describe('createMulberry32 — sensitivity to seed', () => {
  it('different seeds produce different sequences', () => {
    const a = createMulberry32(1);
    const b = createMulberry32(2);
    expect(draw(a, 10)).not.toEqual(draw(b, 10));
  });
});

describe('createMulberry32 — output range', () => {
  it('every draw is in [0, 1)', () => {
    const prng = createMulberry32(42);
    for (const value of draw(prng, 1000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('createMulberry32 — distribution sanity', () => {
  it('the mean of ~10k draws lands close to 0.5', () => {
    const prng = createMulberry32(7);
    const n = 10000;
    const sum = draw(prng, n).reduce((acc, v) => acc + v, 0);
    const mean = sum / n;
    // For n=10000 uniform draws on [0,1), the standard error of the mean is
    // sqrt(Var(U)/n) = sqrt((1/12)/10000) ≈ 0.00289. A tolerance of 0.02 is
    // roughly 7 standard errors, which is safe from flakiness for a
    // deterministic PRNG while still catching a badly broken generator
    // (e.g. one biased toward 0 or 1).
    expect(mean).toBeGreaterThan(0.5 - 0.02);
    expect(mean).toBeLessThan(0.5 + 0.02);
  });
});
