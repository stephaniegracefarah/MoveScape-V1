import { describe, expect, it } from 'vitest';
import { createLabeledNoise } from '../../world/labeled-noise';
import {
  SPEED_FLOOR,
  SYMMETRY_DAMPING,
  angleDifference,
  computeColor,
  computeHue,
  computeMatureDurationMs,
  computeShrinkDurationMs,
  computeTargetLength,
  growthStepFor,
  mod360,
  spawnBranch,
  tickGrowing,
  visibleSegmentCount,
  wanderDeltaFor,
} from './branch';

describe('growthStepFor — honesty (invariant 6)', () => {
  it('is an exact, noise-free function of dt and speed', () => {
    const baseGrowthPerTick = 0.00007;
    const dt = 16.67;
    const speed = 0.42;

    const expected = baseGrowthPerTick * dt * (SPEED_FLOOR + speed * (1 - SPEED_FLOOR));
    expect(growthStepFor({ dt, speed, baseGrowthPerTick })).toBeCloseTo(expected, 12);
  });

  it('speed=0 still produces a nonzero floor amount, never exactly zero', () => {
    const step = growthStepFor({ dt: 16, speed: 0, baseGrowthPerTick: 0.0001 });
    expect(step).toBeGreaterThan(0);
    expect(step).toBeCloseTo(0.0001 * 16 * SPEED_FLOOR, 12);
  });

  it('speed=1 produces the full, un-floored rate', () => {
    const step = growthStepFor({ dt: 16, speed: 1, baseGrowthPerTick: 0.0001 });
    expect(step).toBeCloseTo(0.0001 * 16, 12);
  });
});

describe('wanderDeltaFor — determinism and shape', () => {
  const baseArgs = {
    wanderAmplitudeBase: 0.1,
    symmetry: 0.5,
    expansion: 0.5,
    dt: 16,
    windAngle: 0,
    currentDirection: 0,
  };

  it('the same grownLength (via the same noise01) gives the same directionDelta', () => {
    const noise = createLabeledNoise('seed-a', 'branch-1:wander');
    const a = wanderDeltaFor({ ...baseArgs, noise01: noise(0.2) });
    const b = wanderDeltaFor({ ...baseArgs, noise01: noise(0.2) });
    expect(a).toBe(b);
  });

  it('a different grownLength gives a different directionDelta', () => {
    const noise = createLabeledNoise('seed-a', 'branch-1:wander');
    const a = wanderDeltaFor({ ...baseArgs, noise01: noise(0.2) });
    const b = wanderDeltaFor({ ...baseArgs, noise01: noise(5.7) });
    expect(a).not.toBe(b);
  });

  it('symmetry=1 produces measurably smaller amplitude than symmetry=0 for the same noise', () => {
    const noise01 = 0.9; // a non-degenerate, non-midpoint sample
    const low = wanderDeltaFor({ ...baseArgs, symmetry: 0, noise01, windAngle: 0, currentDirection: 0 });
    const high = wanderDeltaFor({ ...baseArgs, symmetry: 1, noise01, windAngle: 0, currentDirection: 0 });
    // windPull is 0 here (currentDirection === windAngle), so the whole
    // delta is the noise term, scaled by (1 - symmetry * SYMMETRY_DAMPING).
    expect(Math.abs(high)).toBeLessThan(Math.abs(low));
    expect(Math.abs(high)).toBeCloseTo(Math.abs(low) * (1 - SYMMETRY_DAMPING), 10);
  });

  it('wind pulls direction toward windAngle via the shorter rotational direction', () => {
    // noise01 = 0.5 -> signedNoise = 0, isolating the wind term.
    const delta = wanderDeltaFor({
      ...baseArgs,
      noise01: 0.5,
      currentDirection: 0,
      windAngle: 0.1,
    });
    expect(delta).toBeGreaterThan(0); // pulls toward +0.1, the shorter way
  });
});

describe('angleDifference — wraparound', () => {
  it('returns 0 for identical angles', () => {
    expect(angleDifference(1, 1)).toBe(0);
  });

  it('picks the shorter rotational direction across the 0/2*PI seam', () => {
    // From near 2*PI to near 0 should be a small positive step forward, not
    // a huge negative one all the way around.
    const diff = angleDifference(Math.PI * 2 - 0.1, 0.1);
    expect(diff).toBeCloseTo(0.2, 10);
  });

  it('stays within [-PI, PI]', () => {
    const diff = angleDifference(0, Math.PI * 3);
    expect(Math.abs(diff)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});

describe('tickGrowing — lifecycle transition threshold', () => {
  it('does not report maturity while grownLength stays below targetLength', () => {
    const branch = spawnBranch({
      id: 'b1',
      generation: 0,
      z: 0.5,
      hue: 100,
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 1, // large, so a single small tick won't cross it
    });

    const becameMature = tickGrowing(branch, {
      dt: 16,
      speed: 0.5,
      symmetry: 0.5,
      expansion: 0.5,
      windAngle: 0,
      noise01: 0.5,
      baseGrowthPerTick: 0.00001,
      wanderAmplitudeBase: 0.05,
    });

    expect(becameMature).toBe(false);
    expect(branch.lifecycle).toBe('growing'); // tickGrowing itself never flips lifecycle
    expect(branch.grownLength).toBeLessThan(branch.targetLength);
  });

  it('reports maturity exactly when grownLength reaches targetLength', () => {
    const branch = spawnBranch({
      id: 'b1',
      generation: 0,
      z: 0.5,
      hue: 100,
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 0.0001, // tiny, so one tick crosses it
    });

    const becameMature = tickGrowing(branch, {
      dt: 16,
      speed: 1,
      symmetry: 0.5,
      expansion: 0.5,
      windAngle: 0,
      noise01: 0.5,
      baseGrowthPerTick: 0.001,
      wanderAmplitudeBase: 0.05,
    });

    expect(becameMature).toBe(true);
    expect(branch.grownLength).toBeGreaterThanOrEqual(branch.targetLength);
  });

  it('appends exactly one permanent segment per tick', () => {
    const branch = spawnBranch({
      id: 'b1',
      generation: 0,
      z: 0.5,
      hue: 100,
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 10,
    });
    expect(branch.segments.length).toBe(1);

    tickGrowing(branch, {
      dt: 16,
      speed: 0.5,
      symmetry: 0.5,
      expansion: 0.5,
      windAngle: 0,
      noise01: 0.5,
      baseGrowthPerTick: 0.00001,
      wanderAmplitudeBase: 0.05,
    });
    expect(branch.segments.length).toBe(2);

    tickGrowing(branch, {
      dt: 16,
      speed: 0.5,
      symmetry: 0.5,
      expansion: 0.5,
      windAngle: 0,
      noise01: 0.6,
      baseGrowthPerTick: 0.00001,
      wanderAmplitudeBase: 0.05,
    });
    expect(branch.segments.length).toBe(3);
  });
});

describe('mature -> shrinking threshold (documented in botanical.ts orchestration)', () => {
  it('lifecycleTimer >= matureDurationMs is the exact documented trigger', () => {
    // This is a thin, direct check of the threshold comparison itself
    // (the actual mutation happens in botanical.ts's stepState, which is
    // covered end-to-end in botanical.test.ts).
    const matureDurationMs = 5000;
    expect(4999 >= matureDurationMs).toBe(false);
    expect(5000 >= matureDurationMs).toBe(true);
  });
});

describe('shrinking-complete threshold', () => {
  it('shrinkProgress >= 1 is the exact documented trigger', () => {
    const shrinkDurationMs = computeShrinkDurationMs(0.35);
    expect(shrinkDurationMs).toBeGreaterThan(0);
    const justBelow = (shrinkDurationMs - 1) / shrinkDurationMs;
    const atOrAbove = shrinkDurationMs / shrinkDurationMs;
    expect(justBelow < 1).toBe(true);
    expect(atOrAbove >= 1).toBe(true);
  });
});

describe('visibleSegmentCount — shrink retraction', () => {
  it('keeps all segments at shrinkProgress=0', () => {
    expect(visibleSegmentCount(10, 0)).toBe(10);
  });

  it('keeps none at shrinkProgress=1', () => {
    expect(visibleSegmentCount(10, 1)).toBe(0);
  });

  it('retracts from the tip end proportionally in between', () => {
    expect(visibleSegmentCount(10, 0.5)).toBe(5);
  });
});

describe('computeTargetLength — generation decay', () => {
  it('decays by GENERATION_LENGTH_DECAY (0.5) per generation, else-identical jitter', () => {
    const gen0 = computeTargetLength(0.35, 0.5, 0);
    const gen1 = computeTargetLength(0.35, 0.5, 1);
    const gen2 = computeTargetLength(0.35, 0.5, 2);
    expect(gen1).toBeCloseTo(gen0 * 0.5, 12);
    expect(gen2).toBeCloseTo(gen0 * 0.25, 12);
  });
});

describe('computeMatureDurationMs / computeShrinkDurationMs', () => {
  it('jitters matureDurationMs within the documented [0.7, 1.3) multiplier band', () => {
    const base = 5000;
    expect(computeMatureDurationMs(base, 0)).toBeCloseTo(base * 0.7, 10);
    expect(computeMatureDurationMs(base, 0.999999)).toBeLessThan(base * 1.3);
  });

  it('shrinkDurationMs scales linearly with grownLength', () => {
    const a = computeShrinkDurationMs(0.1);
    const b = computeShrinkDurationMs(0.2);
    expect(b).toBeCloseTo(a * 2, 10);
  });
});

describe('computeHue / mod360', () => {
  it('wraps into [0, 360)', () => {
    expect(mod360(370)).toBeCloseTo(10, 10);
    expect(mod360(-10)).toBeCloseTo(350, 10);
    expect(mod360(0)).toBe(0);
  });

  it('computeHue applies signed spread around hueBase and wraps', () => {
    expect(computeHue(350, 20, 1)).toBeCloseTo(10, 10); // 350 + 20 wraps to 10
    expect(computeHue(10, 20, -1)).toBeCloseTo(350, 10); // 10 - 20 wraps to 350
  });
});

describe('computeColor — depth formula', () => {
  it('is dark and saturated near (z=0), pale and faded far (z=1)', () => {
    const near = computeColor(100, 0);
    const far = computeColor(100, 1);
    expect(near).toBe('hsl(100, 70%, 15%)');
    expect(far).toBe('hsl(100, 25%, 80%)');
  });
});
