import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import { INITIAL_SESSION_PARAMS, type SessionParams } from '../../engine/session-params';
import { createLabeledStream } from '../../world/labeled-stream';
import { createWorld, type WorldOverrides } from '../../world/world';
import { angleDifference, growthStepFor } from './branch';
import { createBotanicalInternal, createBotanicalStyle } from './botanical';
import { BOTANICAL_PALETTE_PRESETS } from './palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG } from './tuning-config';

function makeParams(overrides: Partial<MovementParams> = {}): MovementParams {
  return { v: 1, expansion: 0.5, speed: 0.5, symmetry: 0.5, ...overrides };
}

/** Runs `ticks` step() calls with the given dt, calling `paramsAt(i)` for each tick's params. `sessionParams` defaults to INITIAL_SESSION_PARAMS (held constant across the run) for tests that don't care about session-level effects. */
function runTicks(
  renderer: ReturnType<typeof createBotanicalStyle>,
  ticks: number,
  dt: number,
  paramsAt: (i: number) => MovementParams,
  sessionParams: SessionParams = INITIAL_SESSION_PARAMS,
): void {
  let time = 0;
  for (let i = 0; i < ticks; i++) {
    renderer.step(paramsAt(i), sessionParams, time, dt);
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

// Overrides used by tests that need a full growing->mature->(front-driven
// resprout) cycle to complete within a bounded number of ticks: fast growth,
// short maturity, so a root's next sibling branch appears within tens of
// ticks rather than thousands. Marks are permanent (docs/styles/botanical.md
// section 7) -- "cycle" here means growth-then-resprout, not shrink/removal.
const FAST_CYCLE_OVERRIDES: WorldOverrides = {
  baseGrowthRate: 0.99, // -> ~1.985, near the top of [0.5, 2.0)
  matureDurationMs: 0, // -> 3000ms, the minimum
};

describe('createBotanicalStyle — worldKnobs', () => {
  it('declares exactly the 9 documented knob names', () => {
    const renderer = createBotanicalStyle();
    const expected = [
      'paletteIndex',
      'branchDensity',
      'baseGrowthRate',
      'matureDurationMs',
      'windAngle',
      'rootCount',
      'branchSpreadBase',
      'wanderAmplitudeBase',
      'blossomsPerCluster',
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
    renderer.step(makeParams(), INITIAL_SESSION_PARAMS, 0, 16);

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

    rendererA.step(makeParams(), INITIAL_SESSION_PARAMS, 0, 16);
    rendererB.step(makeParams(), INITIAL_SESSION_PARAMS, 0, 16);

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
    const lowTotal = sumGrown(low.state.foreground.branches);
    const highTotal = sumGrown(high.state.foreground.branches);

    expect(low.state.foreground.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(high.state.foreground.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(highTotal).toBeGreaterThan(lowTotal);
  });

  it('speed=0 (with expansion/symmetry actively varying) still matches the SPEED_FLOOR-only formula exactly -- noise never leaks into growth amount', () => {
    const overrides: WorldOverrides = { baseGrowthRate: 0.99, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('honesty-seed', 0, overrides));

    // rootCount=0 (raw) still maps to 1 root (ROOT_COUNT_MIN=1), spawned as
    // the foreground system's first root branch: 'fg:root0:0'.
    const branch = state.foreground.branches.find((b) => b.id === 'fg:root0:0');
    if (!branch) throw new Error('expected fg:root0:0 to exist right after init()');
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
        expectedGrown += growthStepFor({ dt, speed: 0, baseGrowthPerTick, tuning: DEFAULT_BOTANICAL_TUNING_CONFIG });
      }
      renderer.step(makeParams({ speed: 0, expansion: expansionDraw(), symmetry: symmetryDraw() }), INITIAL_SESSION_PARAMS, time, dt);
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

    const low = createBotanicalInternal();
    const high = createBotanicalInternal();
    low.renderer.init(createWorld('expansion-seed', 0, overrides));
    high.renderer.init(createWorld('expansion-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ expansion: 0, speed: 0.6, symmetry: 0.5 });
    const highParamsAt = () => makeParams({ expansion: 1, speed: 0.6, symmetry: 0.5 });
    runTicks(low.renderer, 400, 200, lowParamsAt);
    runTicks(high.renderer, 400, 200, highParamsAt);

    // Measured on the foreground system alone (state.foreground), not the
    // merged scene() output: depth echoes (a separate, mostly
    // expansion-invariant "atmosphere" layer -- their own root positions are
    // seed-derived, not expansion-driven) add a large shared point-count
    // "noise floor" to the combined scene that swamps this specific,
    // foreground-only signal once included.
    const foregroundPositions = (state: (typeof low)['state']) => [
      ...state.foreground.branches.flatMap((b) => b.segments),
      ...state.foreground.blossoms.map((b) => ({ x: b.x, y: b.y })),
    ];
    const lowSpread = boundingBoxSpread(foregroundPositions(low.state));
    const highSpread = boundingBoxSpread(foregroundPositions(high.state));

    expect(highSpread).toBeGreaterThan(lowSpread);
  });
});

describe('createBotanicalStyle — expansion scales blossom cluster size', () => {
  it('a branch that matures during expansion=1 gets a bigger cluster than one maturing during expansion=0, else identical', () => {
    // visual spec section 7: "expansion maps to spread/reach of new growth
    // and cluster size." rootCount forced to 1 root so this measures one
    // cluster's own count, not a sum across a variable number of roots.
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };

    const low = createBotanicalInternal();
    const high = createBotanicalInternal();
    low.renderer.init(createWorld('cluster-size-seed', 0, overrides));
    high.renderer.init(createWorld('cluster-size-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ expansion: 0, speed: 0.9, symmetry: 0.5 });
    const highParamsAt = () => makeParams({ expansion: 1, speed: 0.9, symmetry: 0.5 });
    // Long enough for the single root branch to reach maturity and spawn
    // its one cluster (targetLengthBase is 0.65 post-rebuild -- a real
    // stretch of ticks, not a handful), short enough that a front-driven
    // resprout's second cluster hasn't also spawned yet to dilute the
    // comparison (matureDurationMs's minimum is 3000ms = ~180 ticks past
    // maturity, well beyond this window).
    runTicks(low.renderer, 500, 16.67, lowParamsAt);
    runTicks(high.renderer, 500, 16.67, highParamsAt);

    expect(low.state.foreground.blossoms.length).toBeGreaterThan(0);
    expect(high.state.foreground.blossoms.length).toBeGreaterThan(0);
    expect(high.state.foreground.blossoms.length).toBeGreaterThan(low.state.foreground.blossoms.length);
  });
});

describe('createBotanicalStyle — symmetry calms wander', () => {
  it('symmetry=1 produces measurably lower aggregate path curvature than symmetry=0, else-identical inputs', () => {
    // Wander noise varies very slowly relative to a single branch's whole
    // grownLength range (by design -- spec calls for smooth curves, not
    // jitter), so any ONE branch's path curvature is dominated by whichever
    // way its own noise+wind realization happened to lean, not cleanly by
    // the symmetry amplitude factor. Aggregating curvature across MANY
    // independently-seeded branches (fast growth, high branchDensity so many
    // generations' worth of scheduled forks actually get to fire -- marks
    // are permanent now, docs/styles/botanical.md section 7, so every
    // branch that ever spawns stays in the aggregate) lets the law of large
    // numbers surface the systematic (1 - symmetry * SYMMETRY_DAMPING)
    // amplitude effect that wanderDeltaFor's own unit tests already pin
    // down exactly.
    const overrides: WorldOverrides = {
      baseGrowthRate: 0.99,
      matureDurationMs: 0.99, // long -- fewer root resprouts, so forking (not resprouting) dominates branch count
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

    expect(low.state.foreground.branches.length).toBeGreaterThan(5); // sanity: many independent branches spawned
    expect(high.state.foreground.branches.length).toBeGreaterThan(5);

    const totalCurvature = (branches: { segments: { x: number; y: number }[] }[]) =>
      branches.reduce((sum, b) => sum + curvatureSum(b.segments), 0);

    expect(totalCurvature(high.state.foreground.branches)).toBeLessThan(totalCurvature(low.state.foreground.branches));
  });
});

describe('createBotanicalStyle — session movementVariance widens wander', () => {
  it('higher movementVariance (via a hand-constructed SessionParams) produces measurably larger aggregate path curvature than movementVariance: 0, else-identical inputs', () => {
    // Same aggregation strategy as the "symmetry calms wander" test above:
    // wander noise on any ONE branch is dominated by its own noise+wind
    // realization, so aggregate curvature across MANY independently-seeded
    // branches (fast growth, high branchDensity) is needed to surface the
    // systematic SESSION_VARIANCE_WANDER_SCALE effect on wanderAmplitudeBase.
    const overrides: WorldOverrides = {
      baseGrowthRate: 0.99,
      matureDurationMs: 0.99,
      branchDensity: 0.99,
    };

    const low = createBotanicalInternal();
    const high = createBotanicalInternal();
    low.renderer.init(createWorld('variance-seed', 0, overrides));
    high.renderer.init(createWorld('variance-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.5, symmetry: 0.5 });
    const lowSessionParams: SessionParams = { ...INITIAL_SESSION_PARAMS, movementVariance: 0 };
    // 0.25 is movementVariance's practical ceiling (population variance of a
    // 0-1-bounded signal), matching SESSION_VARIANCE_WANDER_SCALE's own doc comment.
    const highSessionParams: SessionParams = { ...INITIAL_SESSION_PARAMS, movementVariance: 0.25 };

    runTicks(low.renderer, 700, 16.67, paramsAt, lowSessionParams);
    runTicks(high.renderer, 700, 16.67, paramsAt, highSessionParams);

    expect(low.state.foreground.branches.length).toBeGreaterThan(5); // sanity: many independent branches spawned
    expect(high.state.foreground.branches.length).toBeGreaterThan(5);

    const totalCurvature = (branches: { segments: { x: number; y: number }[] }[]) =>
      branches.reduce((sum, b) => sum + curvatureSum(b.segments), 0);

    expect(totalCurvature(high.state.foreground.branches)).toBeGreaterThan(totalCurvature(low.state.foreground.branches));
  });
});

describe('createBotanicalStyle — bounded branch/element count', () => {
  it('element count at a late checkpoint is not dramatically larger than at an earlier checkpoint', () => {
    const overrides: WorldOverrides = FAST_CYCLE_OVERRIDES;
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('bounded-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.3 });

    runTicks(renderer, 500, 200, paramsAt);
    const earlyCount = renderer.scene().elements.length;

    runTicks(renderer, 1500, 200, paramsAt); // continues on to tick 2000 total
    const lateCount = renderer.scene().elements.length;

    expect(earlyCount).toBeGreaterThan(0);
    expect(lateCount).toBeGreaterThan(0);
    // Marks are permanent (docs/styles/botanical.md section 7), so element
    // count only ever grows -- but it must grow *toward a ceiling*
    // (maxConcurrentBranches, the composition budget: both forking and
    // front-driven resprouting stop once a growth system's branch count
    // hits it), not without limit. A generous 5x band comfortably separates
    // "converges to a bound" from "unbounded."
    expect(lateCount).toBeGreaterThanOrEqual(earlyCount);
    expect(lateCount / earlyCount).toBeLessThan(5);
  });
});

describe('createBotanicalStyle — branchDensity knob changes steady-state element count', () => {
  it('a low branchDensity override yields fewer elements than a high one, else identical', () => {
    const lowOverrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0 };
    const highOverrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0.99 };

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

describe('BOTANICAL_PALETTE_PRESETS — paletteIndex knob resolves the intended preset', () => {
  it('each preset index round-trips through the paletteIndex world knob, landing mid-bucket', () => {
    BOTANICAL_PALETTE_PRESETS.forEach((preset, index) => {
      const raw = (index + 0.5) / BOTANICAL_PALETTE_PRESETS.length;
      const { renderer, state } = createBotanicalInternal();
      renderer.init(createWorld('palette-seed', 0, { paletteIndex: raw }));
      expect(state.palette.id).toBe(preset.id);
    });
  });
});

describe('BotanicalTuningConfig — override plumbing (M4x tuning panel)', () => {
  it('createBotanicalStyle() with no args behaves identically to passing DEFAULT_BOTANICAL_TUNING_CONFIG explicitly', () => {
    const a = createBotanicalStyle();
    const b = createBotanicalStyle(DEFAULT_BOTANICAL_TUNING_CONFIG);
    a.init(createWorld('tuning-default-seed', 0, FAST_CYCLE_OVERRIDES));
    b.init(createWorld('tuning-default-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.5, symmetry: 0.4 });
    runTicks(a, 300, 16.67, paramsAt);
    runTicks(b, 300, 16.67, paramsAt);

    expect(a.scene()).toEqual(b.scene());
  });

  it("overriding blossomRadiusSmallMin/blossomRadiusSmallSpan (with blossomLargeFraction forced to 0) changes a spawned blossom's radius", () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 1 };
    const { renderer, state } = createBotanicalInternal({
      blossomRadiusSmallMin: 0.2,
      blossomRadiusSmallSpan: 0,
      blossomLargeFraction: 0,
    });
    renderer.init(createWorld('tuning-blossom-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.5, symmetry: 0.5 });
    let tick = 0;
    while (state.foreground.blossoms.length === 0 && tick < 2000) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, tick * 16.67, 16.67);
      tick++;
    }

    expect(state.foreground.blossoms.length).toBeGreaterThan(0);
    for (const blossom of state.foreground.blossoms) {
      // blossomRadiusSmallSpan: 0 and blossomLargeFraction: 0 make the
      // formula deterministic: radius === blossomRadiusSmallMin exactly.
      expect(blossom.radius).toBeCloseTo(0.2, 10);
    }
  });
});
