import { describe, expect, it } from 'vitest';
import { createLabeledStream } from '../../world/labeled-stream';
import { spawnBlossomCluster } from './blossom';

function makeSegments(n: number): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => ({ x: i / n, y: 1 - i / n }));
}

describe('spawnBlossomCluster — count', () => {
  it('produces exactly `count` blossoms', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 12,
      hue: 350,
      z: 0.3,
      draw,
    });
    expect(blossoms.length).toBe(12);
  });

  it('produces zero blossoms for a zero count', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 0,
      hue: 350,
      z: 0.3,
      draw,
    });
    expect(blossoms).toEqual([]);
  });
});

describe('spawnBlossomCluster — determinism', () => {
  it('the same branch id + seed + segments produces an identical cluster', () => {
    const segments = makeSegments(20);
    const drawA = createLabeledStream('seed-1', 'branch1:blossoms');
    const drawB = createLabeledStream('seed-1', 'branch1:blossoms');

    const a = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, hue: 350, z: 0.3, draw: drawA });
    const b = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, hue: 350, z: 0.3, draw: drawB });

    expect(a).toEqual(b);
  });

  it('a different seed produces a different cluster', () => {
    const segments = makeSegments(20);
    const drawA = createLabeledStream('seed-1', 'branch1:blossoms');
    const drawB = createLabeledStream('seed-2', 'branch1:blossoms');

    const a = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, hue: 350, z: 0.3, draw: drawA });
    const b = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, hue: 350, z: 0.3, draw: drawB });

    expect(a).not.toEqual(b);
  });
});

describe('spawnBlossomCluster — shape', () => {
  it('every blossom carries the branchId and stays within normalized bounds', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 10,
      hue: 350,
      z: 0.3,
      draw,
    });

    for (const blossom of blossoms) {
      expect(blossom.branchId).toBe('branch1');
      expect(blossom.x).toBeGreaterThanOrEqual(0);
      expect(blossom.x).toBeLessThanOrEqual(1);
      expect(blossom.y).toBeGreaterThanOrEqual(0);
      expect(blossom.y).toBeLessThanOrEqual(1);
      expect(blossom.z).toBeGreaterThanOrEqual(0);
      expect(blossom.z).toBeLessThanOrEqual(1);
      expect(blossom.hue).toBeGreaterThanOrEqual(0);
      expect(blossom.hue).toBeLessThan(360);
      expect(blossom.radius).toBeGreaterThan(0);
      expect(blossom.baseOpacity).toBeGreaterThan(0);
      expect(blossom.baseOpacity).toBeLessThan(1);
    }
  });

  it('handles a single-segment branch (freshly spawned, not yet grown) without crashing', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: [{ x: 0.5, y: 0.9 }],
      count: 6,
      hue: 350,
      z: 0.3,
      draw,
    });
    expect(blossoms.length).toBe(6);
  });
});
