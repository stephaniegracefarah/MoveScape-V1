import { describe, expect, it } from 'vitest';
import { createValueNoise1D } from './noise';

function sample(seed: number, ts: number[]): number[] {
  const noise = createValueNoise1D(seed);
  return ts.map((t) => noise(t));
}

const WIDE_RANGE_TS = Array.from({ length: 200 }, (_, i) => -50 + i * 0.5);

describe('createValueNoise1D — determinism', () => {
  it('the same seed queried at the same t sequence produces identical output every time', () => {
    const ts = [-3.7, -1, 0, 0.25, 2.5, 10.125, 99.9];
    const a = sample(42, ts);
    const b = sample(42, ts);
    expect(a).toEqual(b);
  });
});

describe('createValueNoise1D — continuity/smoothness', () => {
  it('a tiny step in t produces a tiny change in output, mid-segment', () => {
    const noise = createValueNoise1D(7);
    // Within one lattice segment, output = lerp(v0, v1, fade(frac)) with
    // v0, v1 in [0,1). fade(frac) = 3frac^2 - 2frac^3 has derivative
    // 6*frac*(1-frac), maximized at frac=0.5 with value 1.5. So the
    // steepest possible slope of the noise curve (w.r.t. t) is
    // |v1 - v0| * 1.5 <= 1 * 1.5 = 1.5. Over a step of 0.001, output can
    // change by at most ~1.5 * 0.001 = 0.0015; 0.01 leaves comfortable
    // margin without being loose enough to hide a real discontinuity.
    const ts = [-4.3, -0.5, 1.2, 3.5, 7.75, 20.1];
    for (const t of ts) {
      const a = noise(t);
      const b = noise(t + 0.001);
      expect(Math.abs(b - a)).toBeLessThan(0.01);
    }
  });

  it('does not jump discontinuously exactly at an integer lattice boundary', () => {
    const noise = createValueNoise1D(7);
    // Naive per-integer-only randomness would produce an unrelated value
    // the instant t crosses 3 -- value noise instead fades smoothly
    // through the boundary, so values just below/at/above 3 stay close.
    const below = noise(2.999);
    const at = noise(3.0);
    const above = noise(3.001);
    expect(Math.abs(at - below)).toBeLessThan(0.01);
    expect(Math.abs(above - at)).toBeLessThan(0.01);
  });
});

describe('createValueNoise1D — range sanity', () => {
  it('output stays within [0,1) across a wide range of t', () => {
    const values = sample(123, WIDE_RANGE_TS);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('createValueNoise1D — seed variation', () => {
  it('different seeds queried at the same t sequence produce different output', () => {
    const ts = [-3.7, -1, 0, 0.25, 2.5, 10.125, 99.9];
    const a = sample(1, ts);
    const b = sample(2, ts);
    expect(a).not.toEqual(b);
  });
});
