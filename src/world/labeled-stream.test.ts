import { describe, expect, it } from 'vitest';
import { createLabeledStream } from './labeled-stream';

function draw(seed: string, label: string, n: number): number[] {
  const prng = createLabeledStream(seed, label);
  return Array.from({ length: n }, () => prng());
}

describe('createLabeledStream — determinism', () => {
  it('the same (seed, label) produces an identical sequence of draws every call', () => {
    const a = draw('worldSeed-1', 'paletteHue', 5);
    const b = draw('worldSeed-1', 'paletteHue', 5);
    expect(a).toEqual(b);
  });
});

describe('createLabeledStream — label independence', () => {
  it('the same seed with different labels produces different sequences', () => {
    const a = draw('worldSeed-1', 'paletteHue', 5);
    const b = draw('worldSeed-1', 'windAngle', 5);
    expect(a).not.toEqual(b);
  });

  it('adding a new label does not perturb an existing label\'s sequence', () => {
    const before = draw('worldSeed-1', 'paletteHue', 5);
    // Reading a different, previously-unused label first must not change
    // what 'paletteHue' produces -- each call builds a fresh hash->PRNG
    // chain rather than advancing shared state.
    createLabeledStream('worldSeed-1', 'someNewKnob')();
    const after = draw('worldSeed-1', 'paletteHue', 5);
    expect(after).toEqual(before);
  });
});

describe('createLabeledStream — seed independence', () => {
  it('the same label with different seeds produces different sequences', () => {
    const a = draw('worldSeed-1', 'paletteHue', 5);
    const b = draw('worldSeed-2', 'paletteHue', 5);
    expect(a).not.toEqual(b);
  });
});
