import { describe, expect, it } from 'vitest';
import { createLabeledNoise } from './labeled-noise';

const TS = [-3.7, -1, 0, 0.25, 2.5, 10.125, 99.9];

function sample(seed: string, label: string, ts: number[]): number[] {
  const noise = createLabeledNoise(seed, label);
  return ts.map((t) => noise(t));
}

describe('createLabeledNoise — determinism', () => {
  it('the same (seed, label) produces an identical output sequence every call', () => {
    const a = sample('worldSeed-1', 'branchWander', TS);
    const b = sample('worldSeed-1', 'branchWander', TS);
    expect(a).toEqual(b);
  });
});

describe('createLabeledNoise — label independence', () => {
  it('the same seed with different labels produces different output sequences', () => {
    const a = sample('worldSeed-1', 'branchWander', TS);
    const b = sample('worldSeed-1', 'leafFlutter', TS);
    expect(a).not.toEqual(b);
  });

  it('adding a new label does not perturb an existing label\'s output', () => {
    const before = sample('worldSeed-1', 'branchWander', TS);
    // Reading a different, previously-unused label first must not change
    // what 'branchWander' produces -- each call builds a fresh hash->noise
    // chain rather than advancing shared state.
    createLabeledNoise('worldSeed-1', 'someNewKnob')(0);
    const after = sample('worldSeed-1', 'branchWander', TS);
    expect(after).toEqual(before);
  });
});

describe('createLabeledNoise — seed independence', () => {
  it('the same label with different seeds produces different output sequences', () => {
    const a = sample('worldSeed-1', 'branchWander', TS);
    const b = sample('worldSeed-2', 'branchWander', TS);
    expect(a).not.toEqual(b);
  });
});
