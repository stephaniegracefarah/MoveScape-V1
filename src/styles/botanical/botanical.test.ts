import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import { createLabeledStream } from '../../world/labeled-stream';
import { createWorld, type WorldOverrides } from '../../world/world';
import { angleDifference, growthStepFor } from './branch';
import { createBotanicalInternal, createBotanicalStyle } from './botanical';
import { BOTANICAL_PALETTES } from './palettes';

function makeParams(overrides: Partial<MovementParams> = {}): MovementParams {
  return { v: 1, expansion: 0.5, speed: 0.5, symmetry: 0.5, ...overrides };
}

/** Runs `ticks` step() calls with the given dt, calling `paramsAt(i)` for each tick's params. */
function runTicks(
  renderer: ReturnType<typeof createBotanicalStyle>,
  ticks: number,
  dt: number,
  paramsAt: (i: number) => MovementParams,
): void {
  let time = 0;
  for (let i = 0; i < ticks; i++) {
    renderer.step(paramsAt(i), time, dt);
    time += dt;
  }
}

function boundingBoxSpread(points: { x: number; y: number }[]): number {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width + height;
}

function curvatureSum(segments: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 1; i < segments.length - 1; i++) {
    const before = segments[i - 1]!;
    const at = segments[i]!;
    const after = segments[i + 1]!;
    const dirIn = Math.atan2(at.y - before.y, at.x - before.x);
    const dirOut = Math.atan2(after.y - at.y, after.x - at.x);
    sum += Math.abs(angleDifference(dirIn, dirOut));
  }
  return sum;
}

// Overrides used by tests that need a full growing->mature->shrinking->
// resprout cycle to complete within a bounded number of ticks: fast growth,
// short maturity, so cycles complete in tens of ticks rather than thousands.
const FAST_CYCLE_OVERRIDES: WorldOverrides = {
  baseGrowthRate: 0.99, // -> ~1.985, near the top of [0.5, 2.0)
  matureDurationMs: 0, // -> 3000ms, the minimum
};

describe('createBotanicalStyle — worldKnobs', () => {
  it('declares exactly the 11 documented knob names', () => {
    const renderer = createBotanicalStyle();
    const expected = [
      'hueBase',
      'hueSpread',
      'branchDensity',
      'baseGrowthRate',
      'matureDurationMs',
      'windAngle',
      'rootCount',
      'branchSpreadBase',
      'wanderAmplitudeBase',
      'blossomsPerCluster',
      'subBranchSpawnChance',
    ];
    expect([...renderer.worldKnobs()].sort()).toEqual([...expected].sort());
  });
});

describe('createBotanicalStyle — determinism (invariant 4)', () => {
  it('two instances with the same world, driven through an identical long step() sequence, produce identical scenes', () => {
    const rendererA = createBotanicalStyle();
    const rendererB = createBotanicalStyle();
    rendererA.init(createWorld('same-seed', 0, FAST_CYCLE_OVERRIDES));
    rendererB.init(createWorld('same-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.3 * Math.sin(i * 0.1), expansion: 0.4, symmetry: 0.3 });
    runTicks(rendererA, 700, 16.67, paramsAt);
    runTicks(rendererB, 700, 16.67, paramsAt);

    expect(rendererA.scene()).toEqual(rendererB.scene());
  });

  it('finish() called after the same sequence returns the same shape/values scene() would', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('same-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.5, symmetry: 0.4 });
    runTicks(renderer, 700, 16.67, paramsAt);

    expect(renderer.finish()).toEqual(renderer.scene());
  });

  it('scene() returns a fresh array each call, not a shared mutable reference', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('same-seed', 0));
    renderer.step(makeParams(), 0, 16);

    const first = renderer.scene();
    const firstLength = first.elements.length;
    first.elements.pop();

    expect(renderer.scene().elements.length).toBe(firstLength);
  });
});

describe('createBotanicalStyle — seed variation', () => {
  it('different worldSeeds produce different initial root layouts', () => {
    const rendererA = createBotanicalStyle();
    const rendererB = createBotanicalStyle();
    rendererA.init(createWorld('world-seed-a', 0));
    rendererB.init(createWorld('world-seed-b', 0));

    rendererA.step(makeParams(), 0, 16);
    rendererB.step(makeParams(), 0, 16);

    expect(rendererA.scene()).not.toEqual(rendererB.scene());
  });
});

describe('createBotanicalStyle — speed drives growth honestly (invariant 6)', () => {
  it('a higher-speed run accumulates measurably more total grownLength than a lower-speed run, expansion/symmetry held equal', () => {
    // A moderate growth rate and a short window (50 ticks) chosen so that
    // NEITHER run reaches maturity -- every branch stays in 'growing' the
    // whole time, so grownLength is a clean, uncomplicated proxy for how
    // much the honest growth formula produced.
    const overrides: WorldOverrides = { baseGrowthRate: 0.3 };

    const low = createBotanicalInternal();
    const high = createBotanicalInternal();
    low.renderer.init(createWorld('speed-seed', 0, overrides));
    high.renderer.init(createWorld('speed-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ speed: 0.1, expansion: 0.5, symmetry: 0.5 });
    const highParamsAt = () => makeParams({ speed: 0.9, expansion: 0.5, symmetry: 0.5 });
    runTicks(low.renderer, 50, 16.67, lowParamsAt);
    runTicks(high.renderer, 50, 16.67, highParamsAt);

    const sumGrown = (branches: { grownLength: number }[]) => branches.reduce((s, b) => s + b.grownLength, 0);
    const lowTotal = sumGrown(low.state.branches);
    const highTotal = sumGrown(high.state.branches);

    expect(low.state.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(high.state.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(highTotal).toBeGreaterThan(lowTotal);
  });

  it('speed=0 (with expansion/symmetry actively varying) still matches the SPEED_FLOOR-only formula exactly -- noise never leaks into growth amount', () => {
    const overrides: WorldOverrides = { baseGrowthRate: 0.99, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('honesty-seed', 0, overrides));

    const branch = state.branches.find((b) => b.id === 'root0:0');
    if (!branch) throw new Error('expected root0:0 to exist right after init()');
    const targetLength = branch.targetLength;
    const baseGrowthPerTick = state.baseGrowthPerTick;

    // Expansion/symmetry vary tick-to-tick (from a labeled stream, not
    // Math.random) so wander noise is actively steering direction -- this
    // is exactly the scenario invariant 6 says must NOT leak into growth.
    const expansionDraw = createLabeledStream('honesty-seed-extra', 'expansion-sequence');
    const symmetryDraw = createLabeledStream('honesty-seed-extra', 'symmetry-sequence');

    let expectedGrown = 0;
    let time = 0;
    let tick = 0;
    const MAX_TICKS = 5000;
    const dt = 500; // large fixed step so maturity is reached in well under MAX_TICKS

    while (branch.lifecycle === 'growing' && tick < MAX_TICKS) {
      if (expectedGrown < targetLength) {
        expectedGrown += growthStepFor({ dt, speed: 0, baseGrowthPerTick });
      }
      renderer.step(makeParams({ speed: 0, expansion: expansionDraw(), symmetry: symmetryDraw() }), time, dt);
      time += dt;
      tick++;
    }

    expect(tick).toBeLessThan(MAX_TICKS); // sanity: maturity was actually reached
    expect(branch.lifecycle).toBe('mature');
    expect(branch.grownLength).toBeCloseTo(expectedGrown, 9);
  });
});

describe('createBotanicalStyle — expansion widens spatial spread', () => {
  it('expansion=1 produces a measurably wider bounding-box spread than expansion=0, across resprout cycles', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };

    const low = createBotanicalStyle();
    const high = createBotanicalStyle();
    low.init(createWorld('expansion-seed', 0, overrides));
    high.init(createWorld('expansion-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ expansion: 0, speed: 0.6, symmetry: 0.5 });
    const highParamsAt = () => makeParams({ expansion: 1, speed: 0.6, symmetry: 0.5 });
    runTicks(low, 400, 200, lowParamsAt);
    runTicks(high, 400, 200, highParamsAt);

    const lowSpread = boundingBoxSpread(low.scene().elements);
    const highSpread = boundingBoxSpread(high.scene().elements);

    expect(highSpread).toBeGreaterThan(lowSpread);
  });
});

describe('createBotanicalStyle — symmetry calms wander', () => {
  it('symmetry=1 produces measurably lower aggregate path curvature than symmetry=0, else-identical inputs', () => {
    // Wander noise varies very slowly relative to a single branch's whole
    // grownLength range (by design -- spec calls for smooth curves, not
    // jitter), so any ONE branch's path curvature is dominated by whichever
    // way its own noise+wind realization happened to lean, not cleanly by
    // the symmetry amplitude factor. Aggregating curvature across MANY
    // independently-seeded branches (fast growth + a long matureDuration so
    // nothing shrinks away mid-run, high subBranchSpawnChance/branchDensity
    // so many generations spawn) lets the law of large numbers surface the
    // systematic (1 - symmetry * SYMMETRY_DAMPING) amplitude effect that
    // wanderDeltaFor's own unit tests already pin down exactly.
    const overrides: WorldOverrides = {
      baseGrowthRate: 0.99,
      matureDurationMs: 0.99, // long -- keeps branches alive (not shrunk away) for the whole run
      subBranchSpawnChance: 0.999,
      branchDensity: 0.99,
    };

    const low = createBotanicalInternal();
    const high = createBotanicalInternal();
    low.renderer.init(createWorld('symmetry-seed', 0, overrides));
    high.renderer.init(createWorld('symmetry-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ symmetry: 0, speed: 0.9, expansion: 0.5 });
    const highParamsAt = () => makeParams({ symmetry: 1, speed: 0.9, expansion: 0.5 });
    runTicks(low.renderer, 700, 16.67, lowParamsAt);
    runTicks(high.renderer, 700, 16.67, highParamsAt);

    expect(low.state.branches.length).toBeGreaterThan(5); // sanity: many independent branches spawned
    expect(high.state.branches.length).toBeGreaterThan(5);

    const totalCurvature = (branches: { segments: { x: number; y: number }[] }[]) =>
      branches.reduce((sum, b) => sum + curvatureSum(b.segments), 0);

    expect(totalCurvature(high.state.branches)).toBeLessThan(totalCurvature(low.state.branches));
  });
});

describe('createBotanicalStyle — bounded branch/element count', () => {
  it('element count at a late checkpoint is not dramatically larger than at an earlier checkpoint', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, subBranchSpawnChance: 0.9 };
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('bounded-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.3 });

    runTicks(renderer, 500, 200, paramsAt);
    const earlyCount = renderer.scene().elements.length;

    runTicks(renderer, 1500, 200, paramsAt); // continues on to tick 2000 total
    const lateCount = renderer.scene().elements.length;

    expect(earlyCount).toBeGreaterThan(0);
    expect(lateCount).toBeGreaterThan(0);
    // "Roughly steady-state" -- not monotonically growing without limit. A
    // generous 5x band comfortably separates "bounded" from "unbounded."
    expect(lateCount / earlyCount).toBeLessThan(5);
    expect(earlyCount / lateCount).toBeLessThan(5);
  });
});

describe('createBotanicalStyle — branchDensity knob changes steady-state element count', () => {
  it('a low branchDensity override yields fewer elements than a high one, else identical', () => {
    const lowOverrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0, subBranchSpawnChance: 0.9 };
    const highOverrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0.99, subBranchSpawnChance: 0.9 };

    const low = createBotanicalStyle();
    const high = createBotanicalStyle();
    low.init(createWorld('density-seed', 0, lowOverrides));
    high.init(createWorld('density-seed', 0, highOverrides));

    const paramsAt = () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.3 });
    runTicks(low, 1500, 200, paramsAt);
    runTicks(high, 1500, 200, paramsAt);

    expect(high.scene().elements.length).toBeGreaterThan(low.scene().elements.length);
  });
});

describe('BOTANICAL_PALETTES — override sanity', () => {
  it('each preset\'s overrides come back verbatim from world.knob()', () => {
    for (const id of Object.keys(BOTANICAL_PALETTES) as (keyof typeof BOTANICAL_PALETTES)[]) {
      const overrides = BOTANICAL_PALETTES[id];
      const world = createWorld('palette-seed', 0, overrides);
      expect(world.knob('hueBase')).toBe(overrides.hueBase);
      expect(world.knob('hueSpread')).toBe(overrides.hueSpread);
    }
  });
});
