import { describe, expect, it } from 'vitest';
import { createLabeledStream } from '../../world/labeled-stream';
import { lightenHex, spawnBlossomCluster } from './blossom';
import { DEFAULT_BOTANICAL_TUNING_CONFIG } from './tuning-config';

const TEST_PALETTE = ['#a31621', '#7c0f1c', '#4a1218', '#2a0d10', '#c4707d', '#e8b4b8', '#f2e3d5', '#f0d7d7'];

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
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });
    expect(blossoms.length).toBe(12);
  });

  it('produces zero blossoms for a zero count', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 0,
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });
    expect(blossoms).toEqual([]);
  });
});

describe('spawnBlossomCluster — determinism', () => {
  it('the same branch id + seed + segments produces an identical cluster', () => {
    const segments = makeSegments(20);
    const drawA = createLabeledStream('seed-1', 'branch1:blossoms');
    const drawB = createLabeledStream('seed-1', 'branch1:blossoms');

    const a = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, paletteColors: TEST_PALETTE, z: 0.3, draw: drawA, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });
    const b = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, paletteColors: TEST_PALETTE, z: 0.3, draw: drawB, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });

    expect(a).toEqual(b);
  });

  it('a different seed produces a different cluster', () => {
    const segments = makeSegments(20);
    const drawA = createLabeledStream('seed-1', 'branch1:blossoms');
    const drawB = createLabeledStream('seed-2', 'branch1:blossoms');

    const a = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, paletteColors: TEST_PALETTE, z: 0.3, draw: drawA, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });
    const b = spawnBlossomCluster({ branchId: 'branch1', segments, count: 8, paletteColors: TEST_PALETTE, z: 0.3, draw: drawB, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });

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
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });

    for (const blossom of blossoms) {
      expect(blossom.branchId).toBe('branch1');
      expect(blossom.x).toBeGreaterThanOrEqual(0);
      expect(blossom.x).toBeLessThanOrEqual(1);
      expect(blossom.y).toBeGreaterThanOrEqual(0);
      expect(blossom.y).toBeLessThanOrEqual(1);
      expect(blossom.z).toBeGreaterThanOrEqual(0);
      expect(blossom.z).toBeLessThanOrEqual(1);
      expect(TEST_PALETTE).toContain(blossom.color);
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
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });
    expect(blossoms.length).toBe(6);
  });
});

describe('spawnBlossomCluster — size mixture', () => {
  it('produces mostly small blossoms with at least one in the large range', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 60,
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });

    const largeThreshold = DEFAULT_BOTANICAL_TUNING_CONFIG.blossomRadiusLargeMin;
    const largeCount = blossoms.filter((b) => b.radius >= largeThreshold).length;
    const smallCount = blossoms.filter((b) => b.radius < largeThreshold).length;

    expect(largeCount).toBeGreaterThanOrEqual(1);
    expect(smallCount).toBeGreaterThan(blossoms.length / 2);
  });
});

describe('spawnBlossomCluster — gaussian packing', () => {
  it('clusters positions around the anchor rather than spreading uniformly', () => {
    const segments = makeSegments(20);
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');

    // Compute the anchor the same way spawnBlossomCluster does, using an
    // independent draw stream with the identical seed/label so the first
    // draw call lines up with the function's own anchorFraction draw.
    const anchorDraw = createLabeledStream('seed-1', 'branch1:blossoms');
    const anchorFraction = 0.7 + anchorDraw() * 0.3;
    const lastIndex = segments.length - 1;
    const anchorIndex = Math.min(lastIndex, Math.floor(anchorFraction * segments.length));
    const anchor = segments[anchorIndex] ?? segments[lastIndex]!;

    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments,
      count: 40,
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });

    const maxSigma = DEFAULT_BOTANICAL_TUNING_CONFIG.blossomClusterSigmaMin + DEFAULT_BOTANICAL_TUNING_CONFIG.blossomClusterSigmaSpan;
    const bound = maxSigma * 6;

    for (const blossom of blossoms) {
      expect(Math.abs(blossom.x - anchor.x)).toBeLessThanOrEqual(bound);
      expect(Math.abs(blossom.y - anchor.y)).toBeLessThanOrEqual(bound);
    }
  });
});

describe('lightenHex', () => {
  it('lightens black toward white by the given amount', () => {
    expect(lightenHex('#000000', 1)).toBe('#ffffff');
  });

  it('leaves black unchanged when amount is 0', () => {
    expect(lightenHex('#000000', 0)).toBe('#000000');
  });

  it('leaves white unchanged since it cannot lighten further', () => {
    expect(lightenHex('#ffffff', 0.5)).toBe('#ffffff');
  });
});

describe('spawnBlossomCluster — ring outline', () => {
  it('every blossom carries a ring when blossomRingProbability is 1', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 10,
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: { ...DEFAULT_BOTANICAL_TUNING_CONFIG, blossomRingProbability: 1 },
    });

    for (const blossom of blossoms) {
      expect(blossom.ringColor).toBeDefined();
      expect(blossom.ringOpacity).toBeDefined();
    }
  });

  it('no blossom carries a ring when blossomRingProbability is 0', () => {
    const draw = createLabeledStream('seed-1', 'branch1:blossoms');
    const blossoms = spawnBlossomCluster({
      branchId: 'branch1',
      segments: makeSegments(20),
      count: 10,
      paletteColors: TEST_PALETTE,
      z: 0.3,
      draw,
      tuning: { ...DEFAULT_BOTANICAL_TUNING_CONFIG, blossomRingProbability: 0 },
    });

    for (const blossom of blossoms) {
      expect(blossom.ringColor).toBeUndefined();
      expect(blossom.ringOpacity).toBeUndefined();
    }
  });
});
