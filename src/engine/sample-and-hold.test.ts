import { describe, expect, it } from 'vitest';
import type { MovementParams, MovementSample } from '../adapters/movement-params';
import { sampleIndexAtOrBefore } from './sample-and-hold';

function params(seed: number): MovementParams {
  // Distinct-ish values per index just so samples are individually
  // identifiable in test failure output; the exact values don't matter.
  return { v: 1, expansion: seed, speed: seed, symmetry: seed };
}

function sample(t: number, seed: number): MovementSample {
  return { t, params: params(seed) };
}

const recording: MovementSample[] = [
  sample(0, 0),
  sample(10, 1),
  sample(20, 2),
  sample(30, 3),
];

describe('sampleIndexAtOrBefore — exact match', () => {
  it('returns the index of the sample whose t exactly equals the query time', () => {
    expect(sampleIndexAtOrBefore(recording, 10)).toBe(1);
    expect(sampleIndexAtOrBefore(recording, 20)).toBe(2);
  });
});

describe('sampleIndexAtOrBefore — between samples', () => {
  it('holds the earlier sample when t falls strictly between two sample times', () => {
    expect(sampleIndexAtOrBefore(recording, 15)).toBe(1);
    expect(sampleIndexAtOrBefore(recording, 29)).toBe(2);
  });
});

describe('sampleIndexAtOrBefore — after the last sample', () => {
  it('holds the last sample forever once t reaches or passes it', () => {
    expect(sampleIndexAtOrBefore(recording, 30)).toBe(3);
    expect(sampleIndexAtOrBefore(recording, 1000)).toBe(3);
  });
});

describe('sampleIndexAtOrBefore — before the first sample', () => {
  it('clamps to the first sample rather than inventing a zero-params sample', () => {
    expect(sampleIndexAtOrBefore(recording, -5)).toBe(0);
  });
});

describe('sampleIndexAtOrBefore — empty recording', () => {
  it('throws, since an empty recording is an invalid recipe, not "no movement yet"', () => {
    expect(() => sampleIndexAtOrBefore([], 0)).toThrow();
  });
});

describe('sampleIndexAtOrBefore — forward-cursor equivalence', () => {
  it('a threaded cursor gives the same answer as a fresh scan from 0', () => {
    // Walk the recording tick-by-tick, threading fromIndex forward, and
    // compare each result against a fresh fromIndex=0 call at the same t.
    // This proves the O(1)-amortized forward-only optimization never
    // changes the answer relative to a full rescan.
    let cursor = 0;
    for (let t = -5; t <= 35; t += 1) {
      cursor = sampleIndexAtOrBefore(recording, t, cursor);
      const fresh = sampleIndexAtOrBefore(recording, t, 0);
      expect(cursor).toBe(fresh);
    }
  });
});
