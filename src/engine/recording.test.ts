import { describe, expect, it } from 'vitest';
import type { MovementParams, MovementSample } from '../adapters/movement-params';
import { recordSample } from './recording';

function params(seed: number): MovementParams {
  return { v: 1, expansion: seed, speed: seed, symmetry: seed };
}

describe('recordSample — ascending sequence', () => {
  it('pushes samples in order and the array reflects exactly what was recorded', () => {
    const recording: MovementSample[] = [];
    recordSample(recording, 0, params(0));
    recordSample(recording, 10, params(1));
    recordSample(recording, 25, params(2));

    expect(recording).toHaveLength(3);
    expect(recording).toEqual([
      { t: 0, params: params(0) },
      { t: 10, params: params(1) },
      { t: 25, params: params(2) },
    ]);
  });
});

describe('recordSample — non-ascending t', () => {
  it('throws when the new t equals the last recorded t', () => {
    const recording: MovementSample[] = [];
    recordSample(recording, 10, params(0));
    expect(() => recordSample(recording, 10, params(1))).toThrow();
  });

  it('throws when the new t is less than the last recorded t', () => {
    const recording: MovementSample[] = [];
    recordSample(recording, 10, params(0));
    expect(() => recordSample(recording, 5, params(1))).toThrow();
    // The rejected sample must not have been pushed.
    expect(recording).toHaveLength(1);
  });
});

describe('recordSample — first sample', () => {
  it('always succeeds on an empty recording regardless of t value', () => {
    const negativeStart: MovementSample[] = [];
    expect(() => recordSample(negativeStart, -100, params(0))).not.toThrow();
    expect(negativeStart).toHaveLength(1);

    const zeroStart: MovementSample[] = [];
    expect(() => recordSample(zeroStart, 0, params(0))).not.toThrow();
    expect(zeroStart).toHaveLength(1);
  });
});
