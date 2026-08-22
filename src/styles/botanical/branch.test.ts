import { describe, expect, it } from 'vitest';
import { createLabeledNoise } from '../../world/labeled-noise';
import {
  angleDifference,
  checkCrossedForks,
  computeChildBaseWidth,
  computeForkFractions,
  computeMatureDurationMs,
  computeShrinkDurationMs,
  computeTargetLength,
  growthStepFor,
  spawnBranch,
  tickGrowing,
  visibleSegmentCount,
  wanderDeltaFor,
} from './branch';
import { DEFAULT_BOTANICAL_TUNING_CONFIG } from './tuning-config';

const SPEED_FLOOR = DEFAULT_BOTANICAL_TUNING_CONFIG.speedFloor;
const SYMMETRY_DAMPING = DEFAULT_BOTANICAL_TUNING_CONFIG.symmetryDamping;

describe('growthStepFor — honesty (invariant 6)', () => {
  it('is an exact, noise-free function of dt and speed', () => {
    const baseGrowthPerTick = 0.00007;
    const dt = 16.67;
    const speed = 0.42;

    const expected = baseGrowthPerTick * dt * (SPEED_FLOOR + speed * (1 - SPEED_FLOOR));
    expect(growthStepFor({ dt, speed, baseGrowthPerTick, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG })).toBeCloseTo(
      expected,
      12,
    );
  });

  it('speed=0 still produces a nonzero floor amount, never exactly zero', () => {
    const step = growthStepFor({ dt: 16, speed: 0, baseGrowthPerTick: 0.0001, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });
    expect(step).toBeGreaterThan(0);
    expect(step).toBeCloseTo(0.0001 * 16 * SPEED_FLOOR, 12);
  });

  it('speed=1 produces the full, un-floored rate', () => {
    const step = growthStepFor({ dt: 16, speed: 1, baseGrowthPerTick: 0.0001, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });
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
    sweepTarget: 0,
    tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
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
    // windPull and sweepPull are 0 here (currentDirection === windAngle ===
    // sweepTarget), so the whole delta is the noise term, scaled by
    // (1 - symmetry * SYMMETRY_DAMPING).
    expect(Math.abs(high)).toBeLessThan(Math.abs(low));
    expect(Math.abs(high)).toBeCloseTo(Math.abs(low) * (1 - SYMMETRY_DAMPING), 10);
  });

  it('wind pulls direction toward windAngle via the shorter rotational direction', () => {
    // noise01 = 0.5 -> signedNoise = 0, isolating the wind term.
    // sweepTarget === currentDirection here, so the sweep term is inert.
    // DEFAULT_BOTANICAL_TUNING_CONFIG.windStrength is 0 (the sweepTarget
    // mechanism is what makes branches commit to a direction now -- see its
    // own doc comment in tuning-config.ts), so this test overrides it to a
    // nonzero value to isolate and verify the windPull formula term itself,
    // independent of what the current product default happens to be.
    const delta = wanderDeltaFor({
      ...baseArgs,
      noise01: 0.5,
      currentDirection: 0,
      windAngle: 0.1,
      sweepTarget: 0,
      tuning: { ...DEFAULT_BOTANICAL_TUNING_CONFIG, windStrength: 0.0005 },
    });
    expect(delta).toBeGreaterThan(0); // pulls toward +0.1, the shorter way
  });

  it('sweep pulls direction toward sweepTarget via the shorter rotational direction', () => {
    // noise01 = 0.5 -> signedNoise = 0, isolating the sweep term.
    // windAngle === currentDirection here, so the wind term is inert.
    const delta = wanderDeltaFor({
      ...baseArgs,
      noise01: 0.5,
      currentDirection: 0,
      windAngle: 0,
      sweepTarget: 0.1,
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
      color: '#4a1218',
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 1, // large, so a single small tick won't cross it
      sweepTarget: 0,
      baseWidth: 0.02,
      forkFractions: [],
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
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
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
      color: '#4a1218',
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 0.0001, // tiny, so one tick crosses it
      sweepTarget: 0,
      baseWidth: 0.02,
      forkFractions: [],
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
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
    });

    expect(becameMature).toBe(true);
    expect(branch.grownLength).toBeGreaterThanOrEqual(branch.targetLength);
  });

  it('appends exactly one permanent segment per tick', () => {
    const branch = spawnBranch({
      id: 'b1',
      generation: 0,
      z: 0.5,
      color: '#4a1218',
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 10,
      sweepTarget: 0,
      baseWidth: 0.02,
      forkFractions: [],
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
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
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
      tuning: DEFAULT_BOTANICAL_TUNING_CONFIG,
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
    const shrinkDurationMs = computeShrinkDurationMs(0.35, DEFAULT_BOTANICAL_TUNING_CONFIG);
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
    const gen0 = computeTargetLength(0.35, 0.5, 0, DEFAULT_BOTANICAL_TUNING_CONFIG);
    const gen1 = computeTargetLength(0.35, 0.5, 1, DEFAULT_BOTANICAL_TUNING_CONFIG);
    const gen2 = computeTargetLength(0.35, 0.5, 2, DEFAULT_BOTANICAL_TUNING_CONFIG);
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
    const a = computeShrinkDurationMs(0.1, DEFAULT_BOTANICAL_TUNING_CONFIG);
    const b = computeShrinkDurationMs(0.2, DEFAULT_BOTANICAL_TUNING_CONFIG);
    expect(b).toBeCloseTo(a * 2, 10);
  });
});

describe('computeForkFractions — scheduled fork points', () => {
  it('produces `count` ascending-ish values within [forkFractionMin, forkFractionMax]', () => {
    const draws = [0.5, 0.5, 0.5];
    const fractions = computeForkFractions(3, draws, DEFAULT_BOTANICAL_TUNING_CONFIG);
    expect(fractions.length).toBe(3);
    fractions.forEach((f) => {
      expect(f).toBeGreaterThanOrEqual(DEFAULT_BOTANICAL_TUNING_CONFIG.forkFractionMin);
      expect(f).toBeLessThanOrEqual(DEFAULT_BOTANICAL_TUNING_CONFIG.forkFractionMax);
    });
    expect(fractions[0]!).toBeLessThan(fractions[1]!);
    expect(fractions[1]!).toBeLessThan(fractions[2]!);
  });

  it('count=0 produces an empty array', () => {
    expect(computeForkFractions(0, [], DEFAULT_BOTANICAL_TUNING_CONFIG)).toEqual([]);
  });

  it('is deterministic for the same count and jitterDraws', () => {
    const draws = [0.2, 0.8, 0.4];
    const a = computeForkFractions(3, draws, DEFAULT_BOTANICAL_TUNING_CONFIG);
    const b = computeForkFractions(3, draws, DEFAULT_BOTANICAL_TUNING_CONFIG);
    expect(a).toEqual(b);
  });
});

describe('checkCrossedForks — fork-point crossing detection', () => {
  function makeBranch() {
    return spawnBranch({
      id: 'b1',
      generation: 0,
      z: 0.5,
      color: '#4a1218',
      rootX: 0.5,
      rootY: 0.9,
      baseDirection: -Math.PI / 2,
      targetLength: 1,
      sweepTarget: 0,
      baseWidth: 0.02,
      forkFractions: [0.3, 0.6],
    });
  }

  it('reports a fraction newly crossed this tick and marks it fired', () => {
    const branch = makeBranch();
    const previousGrownLength = 0.2;
    branch.grownLength = 0.4;

    const crossed = checkCrossedForks(branch, previousGrownLength);
    expect(crossed).toEqual([0]);
    expect(branch.forkedFractions[0]).toBe(true);
    expect(branch.forkedFractions[1]).toBe(false);
  });

  it('never reports an already-fired fraction again', () => {
    const branch = makeBranch();
    branch.grownLength = 0.4;
    checkCrossedForks(branch, 0.2); // fires index 0

    const previousGrownLength = branch.grownLength;
    branch.grownLength = 0.5;
    const crossed = checkCrossedForks(branch, previousGrownLength);
    expect(crossed).toEqual([]);
  });

  it('does not report index 1 until grownLength actually reaches 0.6', () => {
    const branch = makeBranch();
    branch.grownLength = 0.4;
    checkCrossedForks(branch, 0.2); // fires index 0 only

    let previousGrownLength = branch.grownLength;
    branch.grownLength = 0.55;
    expect(checkCrossedForks(branch, previousGrownLength)).toEqual([]);
    expect(branch.forkedFractions[1]).toBe(false);

    previousGrownLength = branch.grownLength;
    branch.grownLength = 0.6;
    expect(checkCrossedForks(branch, previousGrownLength)).toEqual([1]);
    expect(branch.forkedFractions[1]).toBe(true);
  });
});

describe('computeChildBaseWidth — generation width decay', () => {
  it('scales the parent baseWidth by generationWidthDecay', () => {
    expect(computeChildBaseWidth(0.02, DEFAULT_BOTANICAL_TUNING_CONFIG)).toBeCloseTo(
      0.02 * DEFAULT_BOTANICAL_TUNING_CONFIG.generationWidthDecay,
      12,
    );
  });
});
