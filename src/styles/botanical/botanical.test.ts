import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import { INITIAL_SESSION_PARAMS, type SessionParams } from '../../engine/session-params';
import { createLabeledStream } from '../../world/labeled-stream';
import { createWorld, type WorldOverrides } from '../../world/world';
import type { SceneElement } from '../style-renderer';
import { angleDifference, growthStepFor } from './branch';
import type { Blossom } from './blossom';
import {
  computeGrowingRootStartMinX,
  createBotanicalInternal,
  createBotanicalStyle,
  isSafeToBake,
  type RootBakeSafetySystem,
} from './botanical';
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

/** Smallest distance between any point of `a` and any point of `b` -- fine for a test-only proximity check on the modest point counts these tests deal with, not a hot path. */
function minSegmentDistance(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  let min = Infinity;
  for (const pa of a) {
    for (const pb of b) {
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d < min) min = d;
    }
  }
  return min;
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

/** A large synthetic blossom cluster's already-generated members, for tests that inject a `PendingBlossomCluster` directly (bypassing organic branch growth) to isolate revealPendingBlossoms's pacing math. Large enough that it never fully drains within any of these tests' tick budgets, so it's never pruned out from `pendingClusters`. Field values are irrelevant here -- only array length/order (via revealedCount) is exercised. */
function makeBigBlossoms(count = 1000): Blossom[] {
  return Array.from({ length: count }, () => ({
    branchId: 'synthetic',
    x: 0.5,
    y: 0.5,
    z: 0,
    color: '#000000',
    radius: 0.01,
    baseOpacity: 0.5,
  }));
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
    const lowTotal = sumGrown(low.state.foregroundSystems[0]!.branches);
    const highTotal = sumGrown(high.state.foregroundSystems[0]!.branches);

    expect(low.state.foregroundSystems[0]!.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(high.state.foregroundSystems[0]!.branches.every((b) => b.lifecycle === 'growing')).toBe(true);
    expect(highTotal).toBeGreaterThan(lowTotal);
  });

  it('speed=0 (with expansion/symmetry actively varying) still matches the SPEED_FLOOR-only formula exactly -- noise never leaks into growth amount', () => {
    const overrides: WorldOverrides = { baseGrowthRate: 0.99, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('honesty-seed', 0, overrides));

    // rootCount=0 (raw) still maps to 1 root (ROOT_COUNT_MIN=1), spawned as
    // the first foreground system's first root branch: 'fg0:root0:0'.
    const branch = state.foregroundSystems[0]!.branches.find((b) => b.id === 'fg0:root0:0');
    if (!branch) throw new Error('expected fg0:root0:0 to exist right after init()');
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

    // Measured on the foreground system alone (state.foregroundSystems[0]), not the
    // merged scene() output: depth echoes (a separate, mostly
    // expansion-invariant "atmosphere" layer -- their own root positions are
    // seed-derived, not expansion-driven) add a large shared point-count
    // "noise floor" to the combined scene that swamps this specific,
    // foreground-only signal once included.
    const foregroundPositions = (state: (typeof low)['state']) => [
      ...state.foregroundSystems[0]!.branches.flatMap((b) => b.segments),
      ...state.foregroundSystems[0]!.blossoms.map((b) => ({ x: b.x, y: b.y })),
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

    // blossomRevealIntervalMs: 0 bypasses reveal-pacing entirely (see the
    // "watercolor reveal" describe block below) -- this test measures
    // decided cluster MEMBERSHIP size (spawnBlossomsFor), not reveal speed,
    // so it must not be sensitive to the tuning defaults' reveal-rate cap.
    const low = createBotanicalInternal({ blossomRevealIntervalMs: 0 });
    const high = createBotanicalInternal({ blossomRevealIntervalMs: 0 });
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

    expect(low.state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(0);
    expect(high.state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(0);
    expect(high.state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(low.state.foregroundSystems[0]!.blossoms.length);
  });
});

describe('createBotanicalStyle — gradual "watercolor" blossom reveal', () => {
  it('a freshly-matured cluster reveals a few blossoms at a time, not all at once', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal({ blossomRevealIntervalMs: 40 });
    renderer.init(createWorld('gradual-reveal-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.9, symmetry: 0.5 });
    const dt = 16.67;
    const countsAtEachTick: number[] = [];
    let firstNonZeroTick = -1;
    let tick = 0;
    let time = 0;
    // Long enough to reveal a whole cluster gradually and see it finish
    // growing (not just start) -- expansion=0.9 makes for a large cluster
    // (visual spec: expansionScaledClusterCount), so this needs real room.
    while (countsAtEachTick.length < 400) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, dt);
      time += dt;
      const count = state.foregroundSystems[0]!.blossoms.length;
      countsAtEachTick.push(count);
      if (firstNonZeroTick === -1 && count > 0) firstNonZeroTick = tick;
      tick++;
    }

    expect(firstNonZeroTick).toBeGreaterThan(-1); // a cluster did spawn within the run

    // The key behavior: the very first tick any blossom appears, the count
    // is small (a handful), not the whole cluster -- proves staggering
    // actually happened rather than an instant full-cluster pop-in.
    const countOnFirstAppearance = countsAtEachTick[firstNonZeroTick]!;
    const finalCount = countsAtEachTick[countsAtEachTick.length - 1]!;
    expect(countOnFirstAppearance).toBeGreaterThan(0);
    expect(countOnFirstAppearance).toBeLessThan(finalCount);

    // Monotonically non-decreasing (permanent ink: nothing is ever
    // un-revealed), and genuinely increases across multiple *different*
    // ticks after first appearing, not just once -- the actual "1 by 1"
    // pacing, not a single second jump to the full count.
    const risingTicks = new Set<number>();
    for (let i = 1; i < countsAtEachTick.length; i++) {
      expect(countsAtEachTick[i]!).toBeGreaterThanOrEqual(countsAtEachTick[i - 1]!);
      if (countsAtEachTick[i]! > countsAtEachTick[i - 1]!) risingTicks.add(i);
    }
    expect(risingTicks.size).toBeGreaterThan(3);
  });

  it('blossomRevealIntervalMs=0 reproduces the old instant-reveal behavior exactly (every cluster fully drains the same tick it is queued)', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal({ blossomRevealIntervalMs: 0 });
    renderer.init(createWorld('instant-reveal-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.9, symmetry: 0.5 });
    let time = 0;
    // With intervalMs=0, revealPendingBlossoms drains and prunes a cluster
    // fully within the same stepGrowthSystem call that queued it -- so the
    // real invariant is that pendingClusters is always empty right after
    // step() returns, never holding a lingering (let alone partial) entry.
    for (let tick = 0; tick < 400; tick++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;
      for (const system of state.foregroundSystems) {
        expect(system.pendingClusters.length).toBe(0);
      }
    }

    expect(state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(0);
  });

  it('speed=0 still creeps forward (never fully stalls) but reveals far slower than speed=1, roughly proportional to blossomRevealSpeedFloor', () => {
    const intervalMs = 40;
    const speedFloor = 0.06;
    const dt = 16.67;
    const ticks = 300;

    const zero = createBotanicalInternal({ blossomRevealIntervalMs: intervalMs, blossomRevealSpeedFloor: speedFloor });
    const full = createBotanicalInternal({ blossomRevealIntervalMs: intervalMs, blossomRevealSpeedFloor: speedFloor });
    zero.renderer.init(createWorld('reveal-speed-seed', 0, { rootCount: 0 }));
    full.renderer.init(createWorld('reveal-speed-seed', 0, { rootCount: 0 }));

    // Inject an identical synthetic cluster directly into each system's
    // pendingClusters, bypassing organic branch growth entirely (branch
    // growth has its own, separate speedFloor scaling -- see branch.ts's
    // growthStepFor -- which would otherwise confound this comparison by
    // changing *when* a cluster spawns, not just how fast it reveals).
    const injectedZero = { blossoms: makeBigBlossoms(), revealedCount: 0, revealTimerMs: 0 };
    const injectedFull = { blossoms: makeBigBlossoms(), revealedCount: 0, revealTimerMs: 0 };
    zero.state.foregroundSystems[0]!.pendingClusters.push(injectedZero);
    full.state.foregroundSystems[0]!.pendingClusters.push(injectedFull);

    let time = 0;
    for (let i = 0; i < ticks; i++) {
      zero.renderer.step(makeParams({ speed: 0, expansion: 0.5, symmetry: 0.5 }), INITIAL_SESSION_PARAMS, time, dt);
      full.renderer.step(makeParams({ speed: 1, expansion: 0.5, symmetry: 0.5 }), INITIAL_SESSION_PARAMS, time, dt);
      time += dt;
    }

    expect(injectedFull.revealedCount).toBeGreaterThan(0);
    // Never fully stalls at speed=0: the leaky bucket still creeps forward.
    expect(injectedZero.revealedCount).toBeGreaterThan(0);
    // Meaningfully lower than speed=1's rate -- not just "greater than 0".
    expect(injectedZero.revealedCount).toBeLessThan(injectedFull.revealedCount);

    // Roughly proportional to speedFloor: effectiveDt at speed=0 is exactly
    // dt*speedFloor vs dt*1 at speed=1, so the ratio of counts should land
    // in the same ballpark as speedFloor itself (loose bound -- the leaky
    // bucket's integer-count rounding means it won't be exact).
    const ratio = injectedZero.revealedCount / injectedFull.revealedCount;
    expect(ratio).toBeGreaterThan(speedFloor * 0.4);
    expect(ratio).toBeLessThan(speedFloor * 2.5);
  });

  it('speed=1 reproduces the pre-fix fixed-rate math exactly, regardless of blossomRevealSpeedFloor', () => {
    const intervalMs = 40;
    const dt = 16.67;
    const ticks = 200;

    const runAt = (speedFloor: number): number => {
      const { renderer, state } = createBotanicalInternal({ blossomRevealIntervalMs: intervalMs, blossomRevealSpeedFloor: speedFloor });
      renderer.init(createWorld('reveal-rate-seed', 0, { rootCount: 0 }));
      const injected = { blossoms: makeBigBlossoms(), revealedCount: 0, revealTimerMs: 0 };
      state.foregroundSystems[0]!.pendingClusters.push(injected);
      let time = 0;
      for (let i = 0; i < ticks; i++) {
        renderer.step(makeParams({ speed: 1, expansion: 0.5, symmetry: 0.5 }), INITIAL_SESSION_PARAMS, time, dt);
        time += dt;
      }
      return injected.revealedCount;
    };

    // At speed=1, effectiveDt === dt regardless of speedFloor (speedFloor +
    // 1 * (1 - speedFloor) === 1 for any speedFloor), so the reveal count
    // must be identical no matter which speedFloor is configured -- a direct
    // regression check against the old, unconditional fixed-rate math.
    const lowFloor = runAt(0.06);
    const highFloor = runAt(0.9);
    expect(lowFloor).toBe(highFloor);

    // And it matches the old fixed-rate formula directly: total elapsed ms
    // divided by the reveal interval (comfortably away from a boundary tick
    // here, so float summation error can't flip the floor).
    const expectedCount = Math.floor((ticks * dt) / intervalMs);
    expect(lowFloor).toBe(expectedCount);
  });

  it('the same fixed (dt, speed) tick sequence always produces an identical revealedCount trajectory (determinism invariant 4)', () => {
    const intervalMs = 40;
    const speedFloor = 0.06;
    const dt = 16.67;
    const ticks = 250;
    // Varies speed tick-to-tick (still always in [0,1]) so the effectiveDt
    // scaling is actually exercised across a range of values, not just one.
    const speedAt = (i: number) => Math.abs(Math.sin(i * 0.13));

    const run = (): number[] => {
      const { renderer, state } = createBotanicalInternal({ blossomRevealIntervalMs: intervalMs, blossomRevealSpeedFloor: speedFloor });
      renderer.init(createWorld('reveal-determinism-seed', 0, { rootCount: 0 }));
      const injected = { blossoms: makeBigBlossoms(), revealedCount: 0, revealTimerMs: 0 };
      state.foregroundSystems[0]!.pendingClusters.push(injected);
      const trajectory: number[] = [];
      let time = 0;
      for (let i = 0; i < ticks; i++) {
        renderer.step(makeParams({ speed: speedAt(i), expansion: 0.5, symmetry: 0.5 }), INITIAL_SESSION_PARAMS, time, dt);
        time += dt;
        trajectory.push(injected.revealedCount);
      }
      return trajectory;
    };

    const trajectoryA = run();
    const trajectoryB = run();
    expect(trajectoryA).toEqual(trajectoryB);
    expect(trajectoryA[trajectoryA.length - 1]!).toBeGreaterThan(0);
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

    expect(low.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(5); // sanity: many independent branches spawned
    expect(high.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(5);

    const totalCurvature = (branches: { segments: { x: number; y: number }[] }[]) =>
      branches.reduce((sum, b) => sum + curvatureSum(b.segments), 0);

    expect(totalCurvature(high.state.foregroundSystems[0]!.branches)).toBeLessThan(totalCurvature(low.state.foregroundSystems[0]!.branches));
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

    expect(low.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(5); // sanity: many independent branches spawned
    expect(high.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(5);

    const totalCurvature = (branches: { segments: { x: number; y: number }[] }[]) =>
      branches.reduce((sum, b) => sum + curvatureSum(b.segments), 0);

    expect(totalCurvature(high.state.foregroundSystems[0]!.branches)).toBeGreaterThan(totalCurvature(low.state.foregroundSystems[0]!.branches));
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

describe('createBotanicalStyle — growth-plateau fix: seamless successor foreground system', () => {
  // A low branchDensity (0 -> the minimum, 15) combined with fast growth
  // (FAST_CYCLE_OVERRIDES) fills the foreground system's maxConcurrentBranches
  // budget quickly, forcing maybeSpawnNextForegroundSystem to fire well
  // within a bounded number of ticks.
  const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0 };

  it('spawns a second system anchored exactly at the first system\'s growth front (largest tipX), not a fresh random position', () => {
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('handoff-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.6, symmetry: 0.3 });

    // Captured the instant foregroundSystems grows past length 1, before any
    // further ticks let the old system's frontier branch move on -- this is
    // what makes the comparison below an exact-position check, not a fuzzy one.
    let frontierTipX: number | undefined;
    let frontierTipY: number | undefined;
    let newRootX: number | undefined;
    let newRootY: number | undefined;

    let tick = 0;
    let time = 0;
    const dt = 200;
    while (state.foregroundSystems.length < 2 && tick < 3000) {
      const beforeCount = state.foregroundSystems.length;
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, dt);
      time += dt;
      tick++;

      if (state.foregroundSystems.length > beforeCount) {
        const oldSystem = state.foregroundSystems[state.foregroundSystems.length - 2]!;
        const frontier = oldSystem.branches.reduce((furthest, b) => (b.tipX > furthest.tipX ? b : furthest));
        const newBranch = state.foregroundSystems[state.foregroundSystems.length - 1]!.branches[0]!;
        frontierTipX = frontier.tipX;
        frontierTipY = frontier.tipY;
        newRootX = newBranch.rootX;
        newRootY = newBranch.rootY;
      }
    }

    expect(tick).toBeLessThan(3000); // sanity: a hand-off actually happened within budget
    expect(state.foregroundSystems.length).toBeGreaterThan(1);
    expect(state.foregroundSystems[0]!.branches.length).toBeGreaterThanOrEqual(state.maxConcurrentBranches);
    // The new system's first branch starts exactly where the old system's
    // growth front was -- a genuine hand-off, not a fresh root planted
    // elsewhere on the canvas.
    expect(newRootX).toBe(frontierTipX);
    expect(newRootY).toBe(frontierTipY);
  });

  it('same seed, run twice, produces an identical foregroundSystems hand-off (determinism)', () => {
    const a = createBotanicalInternal();
    const b = createBotanicalInternal();
    a.renderer.init(createWorld('handoff-determinism-seed', 0, overrides));
    b.renderer.init(createWorld('handoff-determinism-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.6, symmetry: 0.3 });
    runTicks(a.renderer, 3000, 200, paramsAt);
    runTicks(b.renderer, 3000, 200, paramsAt);

    expect(a.state.foregroundSystems.length).toBeGreaterThan(1); // sanity: the fix actually engaged
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

describe('createBotanicalStyle — sceneLayers (incremental live-rendering, docs/HANDOFF.md frame-rate-collapse fix)', () => {
  it('returns one layer per active system, layerIds matching each system\'s own systemId, in the same order buildScene visits them', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('scene-layers-seed', 0));
    runTicks(renderer, 30, 16.67, () => makeParams({ speed: 0.5, expansion: 0.5, symmetry: 0.5 }));

    const layers = renderer.sceneLayers?.();
    expect(layers).toBeDefined();
    // Default rootCount knob range means exactly 1 foreground system at
    // this point (no growth-plateau hand-off has had time to fire) plus
    // the 2 fixed depth echoes -- 3 layers total.
    expect(layers?.map((l) => l.layerId)).toEqual(['fg0', 'echo0', 'echo1']);
  });

  it('grows to include a second layerId once the growth-plateau hand-off spawns a successor foreground system', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0 };
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('scene-layers-handoff-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.6, symmetry: 0.3 });
    let tick = 0;
    while (state.foregroundSystems.length < 2 && tick < 3000) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, tick * 200, 200);
      tick++;
    }
    expect(state.foregroundSystems.length).toBeGreaterThan(1); // sanity: the hand-off actually happened

    const layers = renderer.sceneLayers?.() ?? [];
    expect(layers.map((l) => l.layerId)).toEqual(['fg0', 'fg1', 'echo0', 'echo1']);
  });

  it('is never silently out of sync with scene(): flattening every layer\'s elements in order reproduces scene().elements exactly', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('scene-layers-consistency-seed', 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 400, 16.67, () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.4 }));

    const layers = renderer.sceneLayers?.() ?? [];
    const flattened = layers.flatMap((l) => l.elements);

    expect(flattened.length).toBeGreaterThan(0); // sanity: real geometry exists by now
    expect(flattened).toEqual(renderer.scene().elements);
  });

  it('a growing branch\'s stroke element keeps the same points array reference across calls, only ever getting longer -- the append-only contract the live compositor relies on', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('scene-layers-stability-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.5, expansion: 0.5, symmetry: 0.5 });

    // A couple of ticks in, capture the single root branch's stroke element
    // and its current point count.
    renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, 0, 16.67);
    renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, 16.67, 16.67);
    const firstLayers = renderer.sceneLayers?.() ?? [];
    const strokeIndex = firstLayers[0]!.elements.findIndex((e) => e.kind === 'stroke');
    expect(strokeIndex).toBeGreaterThanOrEqual(0);
    const firstPointCount = (firstLayers[0]!.elements[strokeIndex] as { points: unknown[] }).points.length;

    // A few more ticks -- the branch is still growing (rootCount override
    // above spawns exactly one root, well short of maturity in 5 ticks).
    renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, 33.34, 16.67);
    renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, 50, 16.67);
    renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, 66.67, 16.67);
    const laterLayers = renderer.sceneLayers?.() ?? [];
    const laterElement = laterLayers[0]!.elements[strokeIndex] as { kind: string; points: unknown[] };

    expect(state.foregroundSystems[0]!.branches[0]!.lifecycle).toBe('growing'); // sanity: still growing, not matured/replaced
    expect(laterElement.kind).toBe('stroke'); // same index, same kind -- never changes identity
    expect(laterElement.points.length).toBeGreaterThan(firstPointCount); // only ever grows
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
    while (state.foregroundSystems[0]!.blossoms.length === 0 && tick < 2000) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, tick * 16.67, 16.67);
      tick++;
    }

    expect(state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(0);
    for (const blossom of state.foregroundSystems[0]!.blossoms) {
      // blossomRadiusSmallSpan: 0 and blossomLargeFraction: 0 make the
      // formula deterministic: radius === blossomRadiusSmallMin exactly.
      expect(blossom.radius).toBeCloseTo(0.2, 10);
    }
  });
});

// --- fix-cross-root-bake-order: computeRootFrontierMaxX / isSafeToBake pure
// functions, plus end-to-end wiring tests. See docs/HANDOFF.md -- confirmed
// bug: a root's z is fixed by its own index (initGrowthSystem's
// `z = clamp01((i + zJitter) / rootCount)`), so within one growth system a
// higher-rootIndex root is ALWAYS farther, yet both roots start bunched
// close together near the left edge (ROOT_X_MIN/ROOT_X_SPAN) before the
// canvas has spread out -- if the nearer root's branch matures and bakes
// first, a farther root arriving later at the same screen position
// permanently overwrites it (the live compositor's own within-frame z-sort
// can't reconcile bakes across different frames).

function strokeFinalFlags(elements: SceneElement[]): boolean[] {
  return elements.filter((e) => e.kind === 'stroke').map((e) => e.final === true);
}

describe('computeGrowingRootStartMinX — per-root growing-branch start tracking', () => {
  it('tracks the min rootX among GROWING branches per (systemId, rootIndex) key, ignoring mature ones', () => {
    const systems: RootBakeSafetySystem[] = [
      {
        systemId: 'fg0',
        roots: [
          { x: 0.1, z: 0.2 },
          { x: 0.15, z: 0.8 },
        ],
        branches: [
          { rootIndex: 0, rootX: 0.3, lifecycle: 'mature' }, // mature -- excluded, no future bake risk
          { rootIndex: 0, rootX: 0.32, lifecycle: 'growing' },
          { rootIndex: 0, rootX: 0.28, lifecycle: 'growing' }, // smaller rootX -- this is the min
          { rootIndex: 1, rootX: 0.2, lifecycle: 'growing' },
        ],
      },
    ];
    const minX = computeGrowingRootStartMinX(systems);
    expect(minX.get('fg0:0')).toBe(0.28);
    expect(minX.get('fg0:1')).toBe(0.2);
  });

  it('keys are namespaced per systemId, so two systems both having a rootIndex 0 stay independent', () => {
    const systems: RootBakeSafetySystem[] = [
      { systemId: 'fg0', roots: [{ x: 0, z: 0.5 }], branches: [{ rootIndex: 0, rootX: 1.2, lifecycle: 'growing' }] },
      { systemId: 'fg1', roots: [{ x: 1.2, z: 0.5 }], branches: [{ rootIndex: 0, rootX: 1.25, lifecycle: 'growing' }] },
    ];
    const minX = computeGrowingRootStartMinX(systems);
    expect(minX.get('fg0:0')).toBe(1.2);
    expect(minX.get('fg1:0')).toBe(1.25);
  });

  it('has no entry for a lineage with no branches, or whose branches are all mature', () => {
    const systems: RootBakeSafetySystem[] = [
      { systemId: 'fg0', roots: [{ x: 0, z: 0.5 }], branches: [] },
      { systemId: 'fg1', roots: [{ x: 0, z: 0.5 }], branches: [{ rootIndex: 0, rootX: 0.1, lifecycle: 'mature' }] },
    ];
    const minX = computeGrowingRootStartMinX(systems);
    expect(minX.size).toBe(0);
  });
});

describe('isSafeToBake — cross-root bake-order safety predicate', () => {
  it('is a complete no-op when the only system has exactly one root (the single-root regression guarantee)', () => {
    const singleRootSystem: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [{ x: 0.1, z: 0.37 }],
      branches: [{ rootIndex: 0, rootX: 0.1, lifecycle: 'growing' }],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([singleRootSystem]);
    for (const ownZ of [0, 0.1, 0.37, 0.9, 1]) {
      expect(
        isSafeToBake({
          ownSystemId: 'fg0',
          ownRootIndex: 0,
          ownZ,
          ownTipX: 0.9,
          allSystems: [singleRootSystem],
          growingRootStartMinX,
          margin: 0.15,
        }),
      ).toBe(true);
    }
  });

  it('is a no-op across multiple single-root foreground systems (the growth-plateau hand-off case)', () => {
    // fg1's root happens to land at a HIGHER z than fg0's root, and fg1's
    // sole branch is still growing right near fg0's own territory -- if
    // single-root systems were treated as mutual threats, this would
    // (wrongly) gate fg0's content: neither system ever had more than one
    // root, so there is no structural nearer/farther guarantee between them.
    const fg0: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [{ x: 0.1, z: 0.2 }],
      branches: [{ rootIndex: 0, rootX: 0.1, lifecycle: 'mature' }],
    };
    const fg1: RootBakeSafetySystem = {
      systemId: 'fg1',
      roots: [{ x: 0.12, z: 0.8 }],
      branches: [{ rootIndex: 0, rootX: 0.12, lifecycle: 'growing' }],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([fg0, fg1]);
    expect(
      isSafeToBake({
        ownSystemId: 'fg0',
        ownRootIndex: 0,
        ownZ: 0.2,
        ownTipX: 0.9,
        allSystems: [fg0, fg1],
        growingRootStartMinX,
        margin: 0.15,
      }),
    ).toBe(true);
  });

  it('never gates against a nearer or equal-z other root (nearer/equal painting on top is already correct)', () => {
    const system: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [
        { x: 0.1, z: 0.6 },
        { x: 0.12, z: 0.6 }, // equal z to root0
      ],
      branches: [
        { rootIndex: 0, rootX: 0.1, lifecycle: 'mature' },
        { rootIndex: 1, rootX: 0.12, lifecycle: 'growing' }, // root1 still growing right nearby -- would gate if z were treated as farther
      ],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([system]);
    expect(
      isSafeToBake({ ownSystemId: 'fg0', ownRootIndex: 0, ownZ: 0.6, ownTipX: 0.9, allSystems: [system], growingRootStartMinX, margin: 0.15 }),
    ).toBe(true);
  });

  it('withholds (false) when a farther root has a currently-growing branch starting at or before ownTipX + margin', () => {
    // The exact violation shape found via integration testing: root0
    // (nearer, z=0.2) has a branch that reached far ahead (tipX=0.5); root1
    // (farther, z=0.8) has a branch STILL GROWING, spawned back at its own
    // anchor (rootX=0.06) -- root1's eventual bake (whenever it matures)
    // will still cover that whole path from 0.06 onward, so it could still
    // arrive later and paint over root0's content near there.
    const system: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [
        { x: 0.05, z: 0.2 },
        { x: 0.06, z: 0.8 },
      ],
      branches: [
        { rootIndex: 0, rootX: 0.05, lifecycle: 'mature' },
        { rootIndex: 1, rootX: 0.06, lifecycle: 'growing' },
      ],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([system]);
    expect(
      isSafeToBake({ ownSystemId: 'fg0', ownRootIndex: 0, ownZ: 0.2, ownTipX: 0.5, allSystems: [system], growingRootStartMinX, margin: 0.15 }),
    ).toBe(false);
  });

  it('allows (true) once that farther root\'s growing branch has moved its own start well past ownTipX + margin', () => {
    // A forked child of root1, spawned once root1's own growth had already
    // swept well past root0's tipX + margin (0.5 + 0.15 = 0.65) -- its own
    // rootX (0.7) is already beyond that, so its future bake can never
    // retroactively cover root0's territory back at 0.5.
    const system: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [
        { x: 0.05, z: 0.2 },
        { x: 0.06, z: 0.8 },
      ],
      branches: [
        { rootIndex: 0, rootX: 0.05, lifecycle: 'mature' },
        { rootIndex: 1, rootX: 0.06, lifecycle: 'mature' }, // root1's own root branch already resolved
        { rootIndex: 1, rootX: 0.7, lifecycle: 'growing' }, // its child, forked far out, still growing
      ],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([system]);
    expect(
      isSafeToBake({ ownSystemId: 'fg0', ownRootIndex: 0, ownZ: 0.2, ownTipX: 0.5, allSystems: [system], growingRootStartMinX, margin: 0.15 }),
    ).toBe(true);
  });

  it('treats a root with no currently-growing branch (all mature) as having no active threat', () => {
    const system: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [
        { x: 0.05, z: 0.2 },
        { x: 0.06, z: 0.8 },
      ],
      branches: [
        { rootIndex: 0, rootX: 0.05, lifecycle: 'mature' },
        { rootIndex: 1, rootX: 0.06, lifecycle: 'mature' }, // root1's only branch so far -- already mature
      ],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([system]);
    expect(growingRootStartMinX.has('fg0:1')).toBe(false); // sanity: no entry, "no active threat" path is what's under test
    expect(
      isSafeToBake({ ownSystemId: 'fg0', ownRootIndex: 0, ownZ: 0.2, ownTipX: 0.5, allSystems: [system], growingRootStartMinX, margin: 0.15 }),
    ).toBe(true);
  });

  it('never gates against its own root (same systemId + rootIndex pair is always skipped)', () => {
    const system: RootBakeSafetySystem = {
      systemId: 'fg0',
      roots: [
        { x: 0.05, z: 0.2 },
        { x: 0.06, z: 0.8 },
      ],
      branches: [{ rootIndex: 1, rootX: 0.06, lifecycle: 'growing' }],
    };
    const growingRootStartMinX = computeGrowingRootStartMinX([system]);
    expect(
      isSafeToBake({ ownSystemId: 'fg0', ownRootIndex: 1, ownZ: 0.8, ownTipX: 0.9, allSystems: [system], growingRootStartMinX, margin: 0.15 }),
    ).toBe(true);
  });
});

describe('createBotanicalStyle — cross-root bake-order safety: single-root regression (must be a complete no-op)', () => {
  it('final is exactly `lifecycle === "mature"` for every fg0 branch in a single-root session, byte-for-byte the pre-fix formula', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 }; // -> 1 root
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('single-root-noop-seed', 0, overrides));

    runTicks(renderer, 800, 16.67, () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.4 }));

    expect(state.foregroundSystems[0]!.branches.some((b) => b.lifecycle === 'mature')).toBe(true); // sanity: real maturity happened

    const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
    const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
    const finals = strokeFinalFlags(layer.elements);

    expect(finals.length).toBe(branches.length); // sanity: same alignment emitGrowthSystem produces
    finals.forEach((final, i) => {
      expect(final).toBe(branches[i]!.lifecycle === 'mature');
    });
  });

  it('scene() and sceneLayers() agree with each other in the single-root case too (no divergence introduced by the fix)', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('single-root-consistency-seed', 0, overrides));
    runTicks(renderer, 500, 16.67, () => makeParams({ speed: 0.7, expansion: 0.5, symmetry: 0.5 }));

    const flattened = (renderer.sceneLayers?.() ?? []).flatMap((l) => l.elements);
    expect(flattened.length).toBeGreaterThan(0);
    expect(flattened).toEqual(renderer.scene().elements);
  });
});

describe('createBotanicalStyle — cross-root bake-order safety: forced two-root integration', () => {
  const TWO_ROOT_OVERRIDES: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0.75 }; // -> 1 + floor(0.75*2) = 2 roots

  it('no baked-order violation occurs between different-root branches, across many ticks and several seeds', () => {
    const CLOSE_THRESHOLD = 0.04; // world units -- roughly a branch stroke width or two
    const dt = 16.67;
    const TICKS = 1200;

    for (let seedNum = 0; seedNum < 5; seedNum++) {
      const { renderer, state } = createBotanicalInternal();
      renderer.init(createWorld(`bake-safety-seed-${seedNum}`, 0, TWO_ROOT_OVERRIDES));
      expect(state.foregroundSystems[0]!.roots.length).toBe(2); // sanity: the scenario actually engages the fix

      const firstFinalTick = new Map<number, number>(); // stroke-kind index -> first tick observed final
      let time = 0;
      for (let t = 0; t < TICKS; t++) {
        renderer.step({ v: 1, expansion: 0.6, speed: 0.6, symmetry: 0.6 }, INITIAL_SESSION_PARAMS, time, dt);
        time += dt;

        const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
        strokeFinalFlags(layer.elements).forEach((final, i) => {
          if (final && !firstFinalTick.has(i)) firstFinalTick.set(i, t);
        });
      }

      const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
      let violations = 0;
      for (let j = 0; j < branches.length; j++) {
        for (let i = 0; i < branches.length; i++) {
          if (i === j) continue;
          const a = branches[i]!;
          const b = branches[j]!;
          if (a.rootIndex === b.rootIndex) continue;
          const tickA = firstFinalTick.get(i);
          const tickB = firstFinalTick.get(j);
          if (tickA === undefined || tickB === undefined) continue;
          if (tickB <= tickA) continue; // only a LATER bake can overwrite an earlier one
          if (b.z <= a.z) continue; // only a FARTHER later bake is a violation
          if (minSegmentDistance(a.segments, b.segments) <= CLOSE_THRESHOLD) violations++;
        }
      }

      expect(violations).toBe(0);
    }
  });

  it("withholds a nearer, already-mature branch's final flag until the farther root's frontier catches up, in the full renderer pipeline", () => {
    const { renderer, state } = createBotanicalInternal({ crossRootBakeSafetyMargin: 0.4 }); // large margin -- easy to observe withholding
    renderer.init(createWorld('bake-safety-withhold-seed', 0, TWO_ROOT_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.5, symmetry: 0.5 });
    let sawMatureNotYetFinal = false;
    let time = 0;
    for (let t = 0; t < 400 && !sawMatureNotYetFinal; t++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;

      const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
      const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
      strokeFinalFlags(layer.elements).forEach((final, i) => {
        if (branches[i]!.lifecycle === 'mature' && !final) sawMatureNotYetFinal = true;
      });
    }

    expect(sawMatureNotYetFinal).toBe(true);
  });

  it('same seed, forced two roots, produces identical scenes across two independent runs (determinism holds with the safety gate engaged)', () => {
    const a = createBotanicalInternal();
    const b = createBotanicalInternal();
    a.renderer.init(createWorld('bake-safety-determinism-seed', 0, TWO_ROOT_OVERRIDES));
    b.renderer.init(createWorld('bake-safety-determinism-seed', 0, TWO_ROOT_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.7, expansion: 0.6, symmetry: 0.4 });
    runTicks(a.renderer, 900, 16.67, paramsAt);
    runTicks(b.renderer, 900, 16.67, paramsAt);

    expect(a.state.foregroundSystems[0]!.roots.length).toBe(2); // sanity
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});
