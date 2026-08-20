import { describe, expect, it } from 'vitest';
import { clamp01 } from './math';

describe('clamp01', () => {
  it('passes through in-range values', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
  });
});
