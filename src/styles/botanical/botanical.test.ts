import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import { INITIAL_SESSION_PARAMS, type SessionParams } from '../../engine/session-params';
import { createLabeledStream } from '../../world/labeled-stream';
import { createWorld, type WorldOverrides } from '../../world/world';
import type { SceneElement } from '../style-renderer';
import { computeCanvasSize, renderScene, type CanvasLike } from '../../compositor/render-scene';
import { angleDifference, growthStepFor, wanderDeltaFor } from './branch';
import type { Blossom } from './blossom';
import {
  computeBakeThreats,
  createBotanicalInternal,
  createBotanicalStyle,
  isAncestorOrDescendant,
  isSafeToBake,
  type BakeSafetySystem,
  type BakeThreatEntry,
  type ForkZBound,
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

/**
 * A large synthetic blossom cluster's already-generated members, for tests
 * that inject a `PendingBlossomCluster` directly (bypassing organic branch
 * growth) to isolate revealPendingBlossoms's pacing math from everything
 * else -- including, now, the bake-order safety gate (session 018's
 * branch-level generalization made this an explicit new confound: these
 * synthetic blossoms carry a `branchId` ('synthetic') that never matches
 * any real branch's lineage, so isSafeToBake never treats them as
 * ancestor/descendant of anything real). `z: 1` (the max, after clamp01)
 * is deliberate, not arbitrary -- isSafeToBake only gates against entries
 * with `entry.z > ownZ`, and no real branch's z can ever exceed 1, so this
 * guarantees the safety gate can never withhold these synthetic blossoms,
 * exactly reproducing the pre-generalization single-root bypass these
 * tests were originally written against. Large enough that it never fully
 * drains within any of these tests' tick budgets, so it's never pruned out
 * from `pendingClusters`. Every other field is irrelevant here -- only
 * array length/order (via revealedCount) is exercised.
 */
function makeBigBlossoms(count = 1000): Blossom[] {
  return Array.from({ length: count }, () => ({
    branchId: 'synthetic',
    rootIndex: 0,
    x: 0.5,
    y: 0.5,
    z: 1,
    color: '#000000',
    radius: 0.01,
    baseOpacity: 0.5,
    bakeResolved: false,
    blockedMs: 0,
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

// Roadmap C1 rework (docs/HANDOFF.md Roadmap C / Session 026): many
// bake-safety tests below want a FIXED, known number of generation-0 "main"
// branches for the whole run. The `rootCount` world knob no longer sizes the
// foreground -- `tuning.trunkCount` does -- and under the persistent
// trunk-lineage model that number is EXACT and constant: each lineage always
// has exactly one growing gen-0 segment, so there are always exactly
// `trunkCount` growing gen-0 branches, never more, never fewer. `FIXED_TRUNKS(n)`
// just sets `trunkCount: n` (no birth-spacing hack needed anymore).
const FIXED_TRUNKS = (n: number) => ({ trunkCount: n });

// Roadmap B: the pure-threat-model sweeps below (the "zero bake-order
// violation" tests) exist to verify isSafeToBake / computeBakeThreats --
// the threat model this session deliberately did NOT touch. The new
// forced-bake ceiling (resolveBucketBakeThreats: a mature branch or
// revealed blossom blocked longer than tuning.forcedBakeCeilingMs of
// SIMULATED time is force-baked anyway) intentionally produces a rare,
// small, founder-accepted depth-ordering artifact -- exactly the kind of
// "violation" those sweeps count. Setting the ceiling far beyond any of
// these tests' simulated-time budgets keeps them testing the pure threat
// model unchanged; the ceiling's own behavior has dedicated tests in the
// "forced-bake ceiling (roadmap B)" describe block near the end of this file.
const CEILING_EFFECTIVELY_DISABLED = { forcedBakeCeilingMs: 1e9 };

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
    const overrides: WorldOverrides = { baseGrowthRate: 0.99 };
    const { renderer, state } = createBotanicalInternal({ trunkCount: 1 });
    renderer.init(createWorld('honesty-seed', 0, overrides));

    // trunkCount=1 -> one trunk lineage; its FIRST segment keeps
    // spawnRootBranch's id scheme: 'fg0:root0:0' (continuations from segment 1
    // on use 'fg0:trunk0:1', ...).
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
  it('expansion=1 produces a measurably wider bounding-box spread than expansion=0, for a main branch and its forks', () => {
    // Roadmap C1 rework: pin the foreground to a single trunk lineage (+ its
    // forks + its cluster) so this measures expansion's effect on one
    // lineage's spread, not the down-scroll advance of several trunks (which
    // is speed-driven and equal in both runs, and would swamp the expansion
    // signal).
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };
    const tuning = FIXED_TRUNKS(1);

    const low = createBotanicalInternal(tuning);
    const high = createBotanicalInternal(tuning);
    low.renderer.init(createWorld('expansion-seed', 0, overrides));
    high.renderer.init(createWorld('expansion-seed', 0, overrides));

    const lowParamsAt = () => makeParams({ expansion: 0, speed: 0.6, symmetry: 0.5 });
    const highParamsAt = () => makeParams({ expansion: 1, speed: 0.6, symmetry: 0.5 });
    // Roadmap C1 rework: a persistent trunk keeps advancing right forever, so
    // over a long run the x-travel (identical in both runs -- speed-driven)
    // swamps expansion's effect on spread. Keep the window to roughly the
    // first segment + its forks + first cluster, where expansion's widening
    // of wander / fork angle / cluster size is the dominant differentiator.
    runTicks(low.renderer, 120, 200, lowParamsAt);
    runTicks(high.renderer, 120, 200, highParamsAt);

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

/**
 * Total decided blossom membership for `system` -- every blossom any
 * matured cluster has ever generated (spawnBlossomsFor), whether or not it
 * has been REVEALED into `system.blossoms` yet. Before session 018's
 * branch-level generalization, `blossomRevealIntervalMs: 0` was enough on
 * its own to guarantee `system.blossoms.length` equaled decided membership
 * within a short tick window, because the single-root case was a complete
 * bypass of the (then cross-root-only) bake-safety gate. That's no longer
 * true: the gate is now branch-level and applies even at rootCount=1
 * whenever a farther, unrelated (non-ancestor/descendant) branch is still
 * growing nearby -- entirely realistic under this project's default
 * tuning, where forking is on by default (forkCountMin/Span) and
 * childZJitter is nonzero, so a same-root cousin can legitimately hold a
 * few of a cluster's blossoms pending even with pacing itself disabled.
 * That's the fix working as intended, not a regression -- so this helper
 * measures the quantity the test actually cares about (decided membership)
 * directly, unconfounded by reveal-gating: `system.blossoms.length` (already
 * revealed) plus, for each still-open pendingCluster, however many of its
 * fixed, already-decided membership haven't been revealed yet.
 */
function decidedBlossomCount(system: { blossoms: unknown[]; pendingClusters: { blossoms: unknown[]; revealedCount: number }[] }): number {
  const pendingRemainder = system.pendingClusters.reduce((sum, p) => sum + (p.blossoms.length - p.revealedCount), 0);
  return system.blossoms.length + pendingRemainder;
}

describe('createBotanicalStyle — expansion scales blossom cluster size', () => {
  it('a branch that matures during expansion=1 gets a bigger cluster than one maturing during expansion=0, else identical', () => {
    // visual spec section 7: "expansion maps to spread/reach of new growth
    // and cluster size." trunkCount forced to 1 so this measures one
    // cluster's own count, not a sum across several trunks.
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };

    // blossomRevealIntervalMs: 0 bypasses the leaky-bucket PACING timer
    // entirely (see the "watercolor reveal" describe block below) -- this
    // test measures decided cluster MEMBERSHIP size (spawnBlossomsFor), not
    // reveal speed, via decidedBlossomCount (see its own doc comment for why
    // raw `blossoms.length` is no longer a safe stand-in for that after the
    // bake-safety generalization).
    const low = createBotanicalInternal({ blossomRevealIntervalMs: 0, trunkCount: 1 });
    const high = createBotanicalInternal({ blossomRevealIntervalMs: 0, trunkCount: 1 });
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

    const lowCount = decidedBlossomCount(low.state.foregroundSystems[0]!);
    const highCount = decidedBlossomCount(high.state.foregroundSystems[0]!);
    expect(lowCount).toBeGreaterThan(0);
    expect(highCount).toBeGreaterThan(0);
    expect(highCount).toBeGreaterThan(lowCount);
  });
});

describe('createBotanicalStyle — gradual "watercolor" blossom reveal', () => {
  // 60s timeout: the 3000-tick run below takes ~7s in isolation on the dev
  // machine but far longer under a full-suite run's load; the assertions, not
  // the clock, carry this test's meaning, so the budget is deliberately loose.
  it('a freshly-matured cluster reveals a few blossoms at a time, not all at once', { timeout: 60_000 }, () => {
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
    // Bumped from 400 to 3000 ticks in session 020: the snapshot-timing-gap
    // fix's conservative threat-z bound (computeBakeThreats' own doc
    // comment) makes a still-growing generation-0 branch (this test forces
    // rootCount=1, maxGeneration defaults to 5) look like a threat for
    // longer than the old, less-conservative check did, which legitimately
    // delays this specific cluster's reveal -- measured directly for this
    // exact seed/tuning: first blossom around tick 229, but the count
    // barely moves past 1 until several hundred ticks later, with the bulk
    // of the reveal happening between roughly tick 800 and 2600. This is a
    // real, measured behavioral consequence of the fix (reported to the
    // coordinator, not silently absorbed) -- 400 ticks is simply no longer
    // enough runway to observe genuine staggering under the corrected
    // algorithm; it isn't a sign anything is broken.
    while (countsAtEachTick.length < 3000) {
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

  it('blossomRevealIntervalMs=0 disables the pacing TIMER entirely -- every cluster drains the SAME tick it matures, regardless of bake-safety (session 021: reveal and bake-safety are decoupled)', () => {
    // REWRITTEN, session 021 -- this test's session-018/020 premise (the
    // bake-safety gate can legitimately hold pendingClusters open for a
    // while, only guaranteed to drain "by the end") is now false BY
    // DESIGN: the founder reported a real regression (docs/HANDOFF.md)
    // where blossoms stayed invisible for a long time because REVEAL
    // itself waited on bake-safety. revealPendingBlossoms no longer takes
    // a safety argument at all, so with intervalMs=0 every due blossom
    // reveals the INSTANT its cluster matures, full stop -- pendingClusters
    // should never accumulate even transiently now. What CAN still lag
    // behind (checked separately, by the echo-scoped equivalent test
    // above) is each revealed blossom's own `final`/`bakeResolved` flag --
    // a completely different thing from whether it's revealed at all.
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal({ blossomRevealIntervalMs: 0 });
    renderer.init(createWorld('instant-reveal-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.9, symmetry: 0.5 });
    let time = 0;
    let sawNonEmptyPending = false;
    for (let tick = 0; tick < 1000; tick++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;
      if (state.foregroundSystems[0]!.pendingClusters.some((c) => c.revealedCount < c.blossoms.length)) {
        sawNonEmptyPending = true;
      }
    }

    expect(state.foregroundSystems[0]!.blossoms.length).toBeGreaterThan(0); // sanity: clusters actually formed and revealed
    expect(sawNonEmptyPending).toBe(false); // never held open, not even transiently
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
  it(
    'element count at a late checkpoint is not dramatically larger than at an earlier checkpoint',
    () => {
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
    },
    // Bumped from the default 5000ms in session 021: decoupling blossom
    // reveal from bake-safety (docs/HANDOFF.md) means many more blossoms
    // can be simultaneously revealed-but-unresolved than before (reveal is
    // no longer implicitly rate-limited by bake-safety), which is real,
    // measured, bounded-but-not-cheap work (see the perf measurement in
    // that session's own handoff entry) -- this specific FAST_CYCLE_OVERRIDES
    // + large-dt scenario produces enough concurrent unresolved blossoms
    // to need more wall-clock time than the default budget, not a hang.
    // Re-bumped 30s -> 120s in session 022: measured 43.6s in isolation on
    // the dev machine (timing out at 30s), and slower still under full-suite
    // load -- the bound this test guards is the element-count ratio, not speed.
    120_000,
  );
});

describe('createBotanicalStyle — branchDensity knob changes steady-state element count', () => {
  it(
    'a low branchDensity override yields fewer elements than a high one, else identical',
    () => {
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
    },
    // Same reason as the bounded-element-count test above -- session 021's
    // decoupling of blossom reveal from bake-safety.
    30000,
  );
});

describe('createBotanicalStyle — N persistent trunk-lineages (roadmap C1 rework)', () => {
  // Replaces the old "population model (roadmap C1)" block (which asserted the
  // now-retired ephemeral born-and-ending population). The founder rejected
  // that behavior; the mechanism is now a FIXED small number N =
  // `tuning.trunkCount` of PERSISTENT trunk-lineages, each an unbroken chain
  // of generation-0 segments: exactly one growing per lineage at all times,
  // and when it matures the lineage CONTINUES from that segment's own tip
  // (spawnTrunkContinuation). All in the single foreground system
  // (foregroundSystems stays length 1 forever).
  const SEED = 'c1-trunk-lineage-seed';

  const fg = (s: ReturnType<typeof createBotanicalInternal>['state']) => s.foregroundSystems[0]!;
  const growingGen0 = (s: ReturnType<typeof createBotanicalInternal>['state']) =>
    fg(s).branches.filter((b) => b.generation === 0 && b.lifecycle === 'growing').length;

  it('keeps EXACTLY trunkCount growing generation-0 segments at all times over a long run -- never more, never fewer', () => {
    const N = 4;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    expect(fg(state).roots.length).toBe(N); // exactly N lineage origins, created once

    let time = 0;
    for (let t = 0; t < 3000; t++) {
      renderer.step(makeParams({ speed: 0.5 + 0.4 * Math.sin(t * 0.03), expansion: 0.6, symmetry: 0.3 }), INITIAL_SESSION_PARAMS, time, 100);
      time += 100;
      expect(growingGen0(state)).toBe(N); // hard invariant: one growing segment per lineage, always
    }
    // Never grew a second foreground system, never added a lineage.
    expect(state.foregroundSystems.length).toBe(1);
    expect(fg(state).roots.length).toBe(N);
    // Plenty of continuations happened (each lineage advanced through many
    // segments), and plenty of gen-0 segments matured and simply stayed
    // mature (permanent ink) -- the lineage is a long chain, not a one-shot.
    const maturedGen0 = fg(state).branches.filter((b) => b.generation === 0 && b.lifecycle === 'mature').length;
    expect(maturedGen0).toBeGreaterThan(N * 4);
    for (const [, count] of fg(state).resproutCounters) {
      expect(count).toBeGreaterThan(4); // each lineage spawned many successive segments
    }
  });

  it("each lineage's segments form a continuous chain: every successor's rootX/rootY ~= its predecessor's tipX/tipY", () => {
    const N = 3;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 2200, 100, () => makeParams({ speed: 0.8, expansion: 0.55, symmetry: 0.35 }));

    // Group every generation-0 segment by its lineage (rootIndex), in birth
    // order (branches is append-only), and check each hands off to the next
    // exactly at the previous segment's final tip.
    for (let lineage = 0; lineage < N; lineage++) {
      const chain = fg(state).branches.filter((b) => b.generation === 0 && b.rootIndex === lineage);
      expect(chain.length).toBeGreaterThan(3); // this lineage really is a multi-segment chain
      for (let i = 1; i < chain.length; i++) {
        const prev = chain[i - 1]!;
        const next = chain[i]!;
        expect(next.rootX).toBeCloseTo(prev.tipX, 9);
        expect(next.rootY).toBeCloseTo(prev.tipY, 9);
        expect(next.z).toBeCloseTo(prev.z, 9); // z is carried unchanged down the lineage
      }
    }
  });

  it('the N lineages occupy distinct vertical bands -- they do not collapse onto each other', () => {
    const N = 4;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N, mainBranchSpawnYSpread: 0.25 });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 2600, 100, () => makeParams({ speed: 0.8, expansion: 0.5, symmetry: 0.4 }));

    // Mean y of every generation-0 segment point, per lineage.
    const meanYByLineage: number[] = [];
    for (let lineage = 0; lineage < N; lineage++) {
      const pts = fg(state)
        .branches.filter((b) => b.generation === 0 && b.rootIndex === lineage)
        .flatMap((b) => b.segments);
      meanYByLineage.push(pts.reduce((s, p) => s + p.y, 0) / pts.length);
    }
    const sorted = [...meanYByLineage].sort((a, b) => a - b);
    // Adjacent lineage means are separated by a real margin (evenly-spaced
    // origins + the per-continuation restoring nudge keep each trunk in its
    // own lane), and the outermost pair spans a large fraction of the height.
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThan(0.05);
    }
    expect(sorted[sorted.length - 1]! - sorted[0]!).toBeGreaterThan(0.3);
  });

  it('each lineage runs the full length of the scroll: every lineage advances far to the right, not just one dominant trunk', () => {
    const N = 3;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 2600, 100, () => makeParams({ speed: 0.85, expansion: 0.6, symmetry: 0.3 }));

    const maxTipXByLineage: number[] = [];
    for (let lineage = 0; lineage < N; lineage++) {
      const xs = fg(state)
        .branches.filter((b) => b.generation === 0 && b.rootIndex === lineage)
        .flatMap((b) => b.segments.map((p) => p.x));
      maxTipXByLineage.push(Math.max(...xs));
    }
    // Every lineage has travelled a long way right (all of them are "one
    // snake running the full length"), and the laggard isn't wildly behind
    // the leader -- they advance together, criss-crossing.
    expect(Math.min(...maxTipXByLineage)).toBeGreaterThan(1.5);
    expect(Math.min(...maxTipXByLineage) / Math.max(...maxTipXByLineage)).toBeGreaterThan(0.5);
    // state.frontMaxX tracks the rightmost tip across the lineages.
    expect(state.frontMaxX).toBeCloseTo(Math.max(...maxTipXByLineage), 6);
  });

  it('trunkCount = 1 -> a single continuous persistent trunk (the "one snake", cleanly continuous)', () => {
    const { renderer, state } = createBotanicalInternal({ trunkCount: 1 });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 2500, 100, () => makeParams({ speed: 0.8, expansion: 0.55, symmetry: 0.35 }));

    expect(fg(state).roots.length).toBe(1);
    expect(growingGen0(state)).toBe(1); // always exactly one growing segment
    const chain = fg(state).branches.filter((b) => b.generation === 0);
    expect(chain.length).toBeGreaterThan(8); // a long continuous chain of segments
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.rootX).toBeCloseTo(chain[i - 1]!.tipX, 9);
      expect(chain[i]!.rootY).toBeCloseTo(chain[i - 1]!.tipY, 9);
    }
    // The single trunk has no band to separate from, so its lean is 0.
    expect(fg(state).roots[0]!.lean).toBe(0);
  });

  it('same seed + tuning + param stream, run twice, produces an identical scene (determinism)', () => {
    const tuning = { trunkCount: 3 };
    const a = createBotanicalInternal(tuning);
    const b = createBotanicalInternal(tuning);
    a.renderer.init(createWorld('c1-rework-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    b.renderer.init(createWorld('c1-rework-determinism-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.35 * Math.sin(i * 0.05), expansion: 0.6, symmetry: 0.3 });
    runTicks(a.renderer, 2500, 100, paramsAt);
    runTicks(b.renderer, 2500, 100, paramsAt);

    expect(a.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(20); // sanity: a real run with many continuations
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
    expect(a.renderer.sceneLayers?.()).toEqual(b.renderer.sceneLayers?.());
  });

  it('trunkCount is NOT scaled by density (the founder wants a small controlled number)', () => {
    const lo = createBotanicalInternal({ trunkCount: 3, density: 0 });
    const hi = createBotanicalInternal({ trunkCount: 3, density: 1 });
    lo.renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    hi.renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(lo.renderer, 800, 100, () => makeParams({ speed: 0.8 }));
    runTicks(hi.renderer, 800, 100, () => makeParams({ speed: 0.8 }));
    expect(lo.state.foregroundSystems[0]!.roots.length).toBe(3);
    expect(hi.state.foregroundSystems[0]!.roots.length).toBe(3);
  });

  it('echo systems still resprout (legacy-resprout mode) -- the C1 rework only changed the foreground', () => {
    const { renderer, state } = createBotanicalInternal({ trunkCount: 2, forkCountMin: 0, forkCountSpan: 0 });
    renderer.init(createWorld('c1-echo-resprout-seed', 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 2500, 200, () => makeParams({ speed: 0.85, expansion: 0.5, symmetry: 0.4 }));

    const echoResproutCounts = state.echoes.map((s) => s.resproutCounters.get(0) ?? 0);
    expect(Math.max(...echoResproutCounts)).toBeGreaterThan(3); // legacy resprout intact
    // Foreground lineages also advance many segments -- but via tip
    // continuation, not origin resprout: every successor starts at the
    // previous tip, never back at the fixed origin.
    for (let lineage = 0; lineage < 2; lineage++) {
      const chain = state.foregroundSystems[0]!.branches.filter((b) => b.generation === 0 && b.rootIndex === lineage);
      const origin = state.foregroundSystems[0]!.roots[lineage]!;
      expect(chain.length).toBeGreaterThan(3);
      // Only the very first segment starts at the origin.
      expect(chain[0]!.rootX).toBeCloseTo(origin.x, 9);
      expect(chain[1]!.rootX).not.toBeCloseTo(origin.x, 3);
    }
  });
});

describe('createBotanicalStyle — initial trunk-origin spread (roadmap C1 rework, repurposed mainBranchSpawn* knobs)', () => {
  const SEED = 'c1-origin-spread-seed';
  const fg = (s: ReturnType<typeof createBotanicalInternal>['state']) => s.foregroundSystems[0]!;

  /** A no-op CanvasLike stub: exercises the real draw math against out-of-[0,1] y without a DOM, asserting nothing throws / no NaN reaches a draw call. */
  function makeStubCtx(): CanvasLike & { calls: number } {
    const ctx = {
      calls: 0,
      fillStyle: '',
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineCap: 'butt' as const,
      clearRect() {},
      fillRect() {},
      beginPath() {},
      arc(x: number, y: number, r: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) throw new Error(`non-finite arc(${x},${y},${r})`);
        ctx.calls++;
      },
      moveTo(x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite moveTo(${x},${y})`);
      },
      lineTo(x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite lineTo(${x},${y})`);
        ctx.calls++;
      },
      fill() {},
      stroke() {},
    };
    return ctx;
  }

  it('all defaults 0: the N origins sit near the left edge, evenly spaced in y across the base root band, no x stagger', () => {
    const N = 4;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N });
    renderer.init(createWorld(SEED, 0));

    const origins = fg(state).roots;
    expect(origins.length).toBe(N);
    // No x stagger -> every origin at exactly ROOT_X_MIN (0.05).
    for (const o of origins) expect(o.x).toBeCloseTo(0.05, 9);
    // Evenly spaced in y within [rootYMin, rootYMin + rootYSpan] (+/- the
    // small fixed jitter), sorted by lineage index and monotonically rising.
    const ys = origins.map((o) => o.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(DEFAULT_BOTANICAL_TUNING_CONFIG.rootYMin - 0.04);
    expect(Math.max(...ys)).toBeLessThanOrEqual(
      DEFAULT_BOTANICAL_TUNING_CONFIG.rootYMin + DEFAULT_BOTANICAL_TUNING_CONFIG.rootYSpan + 0.04,
    );
  });

  it('mainBranchSpawnXSpread staggers the origins x rightward; 0 keeps them all at ROOT_X_MIN', () => {
    const noStagger = createBotanicalInternal({ trunkCount: 4, mainBranchSpawnXSpread: 0 });
    const staggered = createBotanicalInternal({ trunkCount: 4, mainBranchSpawnXSpread: 0.3 });
    noStagger.renderer.init(createWorld(SEED, 0));
    staggered.renderer.init(createWorld(SEED, 0));

    const xs = staggered.state.foregroundSystems[0]!.roots.map((r) => r.x);
    expect(new Set(xs.map((x) => x.toFixed(4))).size).toBeGreaterThan(1); // genuinely different
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(0.05 + 0.3 + 1e-9);
    // Every no-stagger origin is exactly at ROOT_X_MIN.
    for (const r of noStagger.state.foregroundSystems[0]!.roots) expect(r.x).toBeCloseTo(0.05, 9);
  });

  it('mainBranchSpawnYSpread widens the vertical band the origins spread across', () => {
    const tight = createBotanicalInternal({ trunkCount: 4, mainBranchSpawnYSpread: 0 });
    const wide = createBotanicalInternal({ trunkCount: 4, mainBranchSpawnYSpread: 0.25 });
    tight.renderer.init(createWorld(SEED, 0));
    wide.renderer.init(createWorld(SEED, 0));

    const span = (s: ReturnType<typeof createBotanicalInternal>['state']) => {
      const ys = s.foregroundSystems[0]!.roots.map((r) => r.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(wide.state)).toBeGreaterThan(span(tight.state) + 0.2);
  });

  it('mainBranchSpawnYOverscan pushes the outermost origins past y=0 / y=1 and the scene still renders (no throw, canvas height unchanged)', () => {
    const { renderer, state } = createBotanicalInternal({
      trunkCount: 5,
      mainBranchSpawnYSpread: 0.3,
      mainBranchSpawnYOverscan: 0.35, // outermost origins land well outside [0,1]
    });
    renderer.init(createWorld(SEED, 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 400, 100, () => makeParams({ speed: 0.85, expansion: 0.6, symmetry: 0.3 }));

    const ys = fg(state).roots.map((r) => r.y);
    expect(ys.some((y) => y < 0)).toBe(true); // above the top edge
    expect(ys.some((y) => y > 1)).toBe(true); // below the bottom edge

    const scene = renderer.scene();
    const size = computeCanvasSize(scene, 640);
    expect(size.height).toBe(640); // out-of-[0,1] y never inflates canvas height
    const ctx = makeStubCtx();
    expect(() => renderScene(ctx, scene, size)).not.toThrow();
    expect(ctx.calls).toBeGreaterThan(0);
  });

  it('is deterministic with the origin-spread fields engaged: same seed + tuning, run twice, identical scene', () => {
    const tuning = { trunkCount: 4, mainBranchSpawnXSpread: 0.25, mainBranchSpawnYSpread: 0.35, mainBranchSpawnYOverscan: 0.2 };
    const a = createBotanicalInternal(tuning);
    const b = createBotanicalInternal(tuning);
    a.renderer.init(createWorld('c1-origin-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    b.renderer.init(createWorld('c1-origin-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.35 * Math.sin(i * 0.05), expansion: 0.6, symmetry: 0.3 });
    runTicks(a.renderer, 2000, 100, paramsAt);
    runTicks(b.renderer, 2000, 100, paramsAt);
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

describe('createBotanicalStyle — persistent per-lineage lean (roadmap C1 rework)', () => {
  const fg = (s: ReturnType<typeof createBotanicalInternal>['state']) => s.foregroundSystems[0]!;

  it('leans are stratified across the trunks: sorted by lineage index they span -trunkLeanSpread .. +trunkLeanSpread', () => {
    const N = 5;
    const SPREAD = 0.6;
    const { renderer, state } = createBotanicalInternal({ trunkCount: N, trunkLeanSpread: SPREAD });
    renderer.init(createWorld('c1-lean-seed', 0));

    const leans = fg(state).roots.map((r) => r.lean);
    expect(leans.length).toBe(N);
    // Monotone in lineage index (stratified, only lightly jittered).
    for (let i = 1; i < leans.length; i++) expect(leans[i]!).toBeGreaterThan(leans[i - 1]!);
    // First negative, last positive, both within the configured half-range.
    expect(leans[0]!).toBeLessThan(0);
    expect(leans[N - 1]!).toBeGreaterThan(0);
    expect(Math.max(...leans.map((l) => Math.abs(l)))).toBeLessThanOrEqual(SPREAD + 1e-9);
  });

  it("the lean persists down a lineage: every segment's sweepTarget carries that lineage's lean, and the per-lineage MEAN sweepTarget ~= its lean", () => {
    const { renderer, state } = createBotanicalInternal({ trunkCount: 4, trunkLeanSpread: 0.6 });
    renderer.init(createWorld('c1-lean-persist-seed', 0, FAST_CYCLE_OVERRIDES));
    runTicks(renderer, 1600, 100, () => makeParams({ speed: 0.8, expansion: 0.5, symmetry: 0.4 }));

    const meanSweepByLineage: number[] = [];
    for (let lineage = 0; lineage < 4; lineage++) {
      const lean = fg(state).roots[lineage]!.lean;
      const chain = fg(state).branches.filter((b) => b.generation === 0 && b.rootIndex === lineage);
      expect(chain.length).toBeGreaterThan(3);
      // Per segment: sweepTarget = lean + bandRestore*w + jitter -- bounded
      // by rootBaseDirectionSpread plus the capped band-restore contribution.
      for (const seg of chain) {
        expect(Math.abs(seg.sweepTarget - lean)).toBeLessThanOrEqual(
          DEFAULT_BOTANICAL_TUNING_CONFIG.rootBaseDirectionSpread + 0.7 * 0.6 + 1e-9,
        );
      }
      const meanSweep = chain.reduce((s, b) => s + b.sweepTarget, 0) / chain.length;
      meanSweepByLineage.push(meanSweep);
      // The mean sweepTarget stays in the neighbourhood of the persistent
      // lean (a leaning trunk settles a little off its lane, so the
      // band-restore term keeps a small persistent opposite sign -- it does
      // not wander off to an unrelated angle).
      expect(Math.abs(meanSweep - lean)).toBeLessThan(0.5);
    }
    // And the per-lineage mean sweepTarget is monotone in lineage index --
    // the stratified persistent lean, visible all the way down each trunk.
    for (let i = 1; i < meanSweepByLineage.length; i++) {
      expect(meanSweepByLineage[i]!).toBeGreaterThan(meanSweepByLineage[i - 1]!);
    }
  });
});

describe('createBotanicalStyle — sceneLayers (incremental live-rendering, docs/HANDOFF.md frame-rate-collapse fix)', () => {
  it('returns one layer per active system, layerIds matching each system\'s own systemId, in the same order buildScene visits them', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('scene-layers-seed', 0));
    runTicks(renderer, 30, 16.67, () => makeParams({ speed: 0.5, expansion: 0.5, symmetry: 0.5 }));

    const layers = renderer.sceneLayers?.();
    expect(layers).toBeDefined();
    // The trunk-lineage model keeps exactly 1 foreground system (fg0) plus
    // the 2 fixed depth echoes -- 3 layers total, forever.
    expect(layers?.map((l) => l.layerId)).toEqual(['fg0', 'echo0', 'echo1']);
  });

  it('keeps exactly the fg0 + echo layers even after a long run with many lineage continuations (roadmap C1 rework: no successor foreground system)', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, branchDensity: 0 };
    const { renderer, state } = createBotanicalInternal({ trunkCount: 3 });
    renderer.init(createWorld('scene-layers-handoff-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.6, symmetry: 0.3 });
    runTicks(renderer, 3000, 200, paramsAt);

    expect(state.foregroundSystems.length).toBe(1);
    expect(state.foregroundSystems[0]!.roots.length).toBe(3); // fixed N lineage origins
    // sanity: the lineages really did continue through many segments
    expect(state.foregroundSystems[0]!.branches.filter((b) => b.generation === 0).length).toBeGreaterThan(20);
    const layers = renderer.sceneLayers?.() ?? [];
    expect(layers.map((l) => l.layerId)).toEqual(['fg0', 'echo0', 'echo1']);
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

// --- fix-cross-root-bake-order (generalized session 018 to branch-level):
// computeBakeThreats / isAncestorOrDescendant / isSafeToBake pure
// functions, plus end-to-end wiring tests. See docs/HANDOFF.md -- confirmed
// bug (original scope): a root's z is fixed by its own index
// (initGrowthSystem's `z = clamp01((i + zJitter) / rootCount)`), so within
// one growth system a higher-rootIndex root is ALWAYS farther, yet both
// roots start bunched close together near the left edge
// (ROOT_X_MIN/ROOT_X_SPAN) before the canvas has spread out -- if the
// nearer root's branch matures and bakes first, a farther root arriving
// later at the same screen position permanently overwrites it (the live
// compositor's own within-frame z-sort can't reconcile bakes across
// different frames). Session 018's real pixel-level evidence (a
// renderScene() vs live-compositor diff) showed the identical overwrite can
// happen between forked SIBLING/COUSIN branches within a single root's own
// lineage too (childZJitter gives each fork its own z, independent of fork
// maturation order) -- so the mechanism below is now branch-level, not
// root-level; the original cross-root case is just one instance of it.

function strokeFinalFlags(elements: SceneElement[]): boolean[] {
  return elements.filter((e) => e.kind === 'stroke').map((e) => e.final === true);
}

/** A `BakeSafetySystem` branch fixture with `reachX` defaulted equal to `rootX` (the common case for these tests -- a branch whose full-path reach hasn't grown past its own start) and `generation` defaulted to 0, spreadable to override just `reachX`/`generation` when a test specifically needs them to differ. */
function fixtureBranch(
  b: { id: string; rootX: number; z: number; lifecycle: 'growing' | 'mature'; reachX?: number; generation?: number },
): { id: string; rootX: number; reachX: number; z: number; lifecycle: 'growing' | 'mature'; generation: number } {
  return { reachX: b.rootX, generation: 0, ...b };
}

/**
 * A `ForkZBound` with `maxGeneration: 0` -- combined with `fixtureBranch`'s
 * own `generation: 0` default, `remainingGenerations` (computeBakeThreats'
 * effectiveThreatZ) is always exactly 0, so every growing branch's threat z
 * equals its own raw z, byte-for-byte the pre-session-020 (snapshot-only)
 * formula. Used by every test in this describe block that predates the
 * snapshot-timing-gap fix and was written to pin that original, un-inflated
 * behavior -- the inflation itself gets its own dedicated tests below.
 */
const NO_INFLATION_BOUND: ForkZBound = { maxGeneration: 0, childZJitterMax: 0.05 };

describe('computeBakeThreats — resolved live-threat list (growing + mature-but-blocked)', () => {
  it('collects {id, z, rootX} for every currently-GROWING branch across all given systems, ignoring RESOLVED-SAFE mature ones', () => {
    const systems: BakeSafetySystem[] = [
      {
        branches: [
          // mature, reach=0.3 -- fg0:root1:0's own rootX (0.5) is beyond
          // 0.3 + margin (0.15) = 0.45, so it doesn't block this one either;
          // resolves safe, excluded.
          fixtureBranch({ id: 'fg0:root0:0', rootX: 0.3, z: 0.2, lifecycle: 'mature' }),
          fixtureBranch({ id: 'fg0:root0:0/child0', rootX: 0.32, z: 0.22, lifecycle: 'growing' }),
          fixtureBranch({ id: 'fg0:root1:0', rootX: 0.5, z: 0.8, lifecycle: 'growing' }),
        ],
      },
    ];
    expect(computeBakeThreats(systems, 0.15, NO_INFLATION_BOUND)).toEqual([
      { id: 'fg0:root1:0', z: 0.8, rootX: 0.5 }, // farthest-first processing order
      { id: 'fg0:root0:0/child0', z: 0.22, rootX: 0.32 },
    ]);
  });

  it('flattens across multiple systems (no more per-system/per-root keying -- a flat, z-sorted list of every live threat)', () => {
    const systems: BakeSafetySystem[] = [
      { branches: [fixtureBranch({ id: 'fg0:root0:0', rootX: 0.1, z: 0.5, lifecycle: 'growing' })] },
      { branches: [fixtureBranch({ id: 'fg1:root0:0', rootX: 0.2, z: 0.6, lifecycle: 'growing' })] },
    ];
    expect(computeBakeThreats(systems, 0.15, NO_INFLATION_BOUND).map((e) => e.id)).toEqual(['fg1:root0:0', 'fg0:root0:0']); // farther (z=0.6) first
  });

  it('returns an empty list when there are no branches, or every branch resolves safe', () => {
    const systems: BakeSafetySystem[] = [
      { branches: [] },
      { branches: [fixtureBranch({ id: 'fg1:root0:0', rootX: 0.1, z: 0.5, lifecycle: 'mature' })] },
    ];
    expect(computeBakeThreats(systems, 0.15, NO_INFLATION_BOUND)).toEqual([]);
  });

  // --- The third correction found through this generalization's own
  // integration sweep (docs/HANDOFF.md session 018), alongside the two
  // preserved from the original root-level fix: a MATURE branch is not
  // automatically excluded just because it's mature -- it must itself
  // resolve safe first. Found via a real 5-seed/1200-tick sweep turning up
  // 5 genuine violations (one per seed) all sharing this exact shape: a
  // nearer branch baked while an unrelated, farther, MATURE-BUT-ITSELF-
  // STILL-BLOCKED sibling sat unbaked nearby, then baked later and painted
  // over it -- undetectable by the old "lifecycle === 'growing' only"
  // threat definition, since the blocking branch had already finished
  // GROWING (just not yet finished BAKING) by the time the nearer one was
  // checked.
  it('keeps a MATURE branch in the threat list when it is itself still blocked by a farther, unrelated branch, and that propagates as a real threat to a nearer branch it directly reaches', () => {
    // c (farthest, z=0.9, growing, rootX=0.68) blocks b (z=0.7, mature,
    // rootX=0.5, reachX=0.55) from resolving safe: c.rootX (0.68) <=
    // b.reachX (0.55) + margin (0.15) = 0.7. b, still unresolved/unbaked,
    // therefore stays in the threat list under its OWN rootX (0.5) --
    // exactly the "will still cover its full path once it finally bakes"
    // reasoning growing branches get, now correctly extended to a mature
    // branch that hasn't actually finished BAKING yet either (only
    // finished GROWING). Coordinates deliberately keep c FAR ENOUGH from a
    // that c never threatens a directly (c.rootX 0.68 > a.reachX 0.5 +
    // margin 0.15 = 0.65) -- isolating that a's withholding can only come
    // from b's own retained threat status, not a direct c-to-a effect.
    const systems: BakeSafetySystem[] = [
      {
        branches: [
          fixtureBranch({ id: 'b', rootX: 0.5, reachX: 0.55, z: 0.7, lifecycle: 'mature' }),
          fixtureBranch({ id: 'c', rootX: 0.68, z: 0.9, lifecycle: 'growing' }),
        ],
      },
    ];
    const threats = computeBakeThreats(systems, 0.15, NO_INFLATION_BOUND);
    expect(threats).toEqual([
      { id: 'c', z: 0.9, rootX: 0.68 },
      { id: 'b', z: 0.7, rootX: 0.5 }, // mature, but still blocked by c -- correctly retained as a threat
    ]);

    expect(isSafeToBake({ id: 'c', z: 0.9, tipX: 0.68, threats, margin: 0.15 })).toBe(true); // sanity: nothing farther than c itself
    // 'a', a nearer, unrelated branch reaching to 0.5, is not directly
    // reachable by c (0.68 > 0.65) but IS reachable by b (0.5 <= 0.65) --
    // proving b's retained threat status is what withholds a, not c.
    expect(isSafeToBake({ id: 'a', z: 0.3, tipX: 0.5, threats, margin: 0.15 })).toBe(false);
  });

  it('once the blocker clears (its own farther threat moves past), the previously-blocked mature branch resolves safe and stops being a threat itself', () => {
    const systems: BakeSafetySystem[] = [
      {
        branches: [
          fixtureBranch({ id: 'b', rootX: 0.5, reachX: 0.55, z: 0.7, lifecycle: 'mature' }),
          fixtureBranch({ id: 'c', rootX: 0.9, z: 0.9, lifecycle: 'growing' }), // c's own rootX now well past b's reach (0.55) + margin (0.15) = 0.7
        ],
      },
    ];
    const threats = computeBakeThreats(systems, 0.15, NO_INFLATION_BOUND);
    expect(threats).toEqual([{ id: 'c', z: 0.9, rootX: 0.9 }]); // b now resolves safe on its own -- no longer in the threat list
    expect(isSafeToBake({ id: 'a', z: 0.3, tipX: 0.5, threats, margin: 0.15 })).toBe(true); // and no longer withholds 'a' either
  });
});

// --- Session 020: the snapshot-timing gap -- a still-growing branch's
// threat z must be a conservative upper bound on what its not-yet-spawned
// descendants could still reach, not just its own current z (see
// computeBakeThreats' own "THE SNAPSHOT-TIMING GAP" doc comment for the
// full mechanism and the real evidence -- session 019's it.fails test --
// that motivated this).
describe('computeBakeThreats — effectiveThreatZ (snapshot-timing-gap fix, session 020)', () => {
  it("inflates a GROWING branch's threat z by (remaining generations) * childZJitterMax, not its own raw z", () => {
    const systems: BakeSafetySystem[] = [
      { branches: [fixtureBranch({ id: 'g', rootX: 0.1, z: 0.5, lifecycle: 'growing', generation: 1 })] },
    ];
    const bound: ForkZBound = { maxGeneration: 3, childZJitterMax: 0.05 };
    // remainingGenerations = 3 - 1 = 2 -> threatZ = 0.5 + 2*0.05 = 0.6
    expect(computeBakeThreats(systems, 0.15, bound)).toEqual([{ id: 'g', z: 0.6, rootX: 0.1 }]);
  });

  it('clamps the inflated threat z to 1, exactly like every other z value in this file', () => {
    const systems: BakeSafetySystem[] = [
      { branches: [fixtureBranch({ id: 'g', rootX: 0.1, z: 0.98, lifecycle: 'growing', generation: 0 })] },
    ];
    const bound: ForkZBound = { maxGeneration: 2, childZJitterMax: 0.05 };
    // remainingGenerations = 2 -> raw would be 0.98 + 0.1 = 1.08, clamped to 1.
    expect(computeBakeThreats(systems, 0.15, bound)).toEqual([{ id: 'g', z: 1, rootX: 0.1 }]);
  });

  it('never inflates a branch already at (or past) the generation cap -- remaining generations floors at 0', () => {
    const systems: BakeSafetySystem[] = [
      { branches: [fixtureBranch({ id: 'g', rootX: 0.1, z: 0.5, lifecycle: 'growing', generation: 5 })] },
    ];
    const bound: ForkZBound = { maxGeneration: 3, childZJitterMax: 0.05 }; // generation (5) > maxGeneration (3)
    expect(computeBakeThreats(systems, 0.15, bound)).toEqual([{ id: 'g', z: 0.5, rootX: 0.1 }]);
  });

  it('never inflates a MATURE branch, even one well under the generation cap -- it can no longer fork, so there is nothing left to bound', () => {
    const systems: BakeSafetySystem[] = [
      {
        branches: [
          // z=0.9 keeps this the sole (and therefore auto-resolved-safe)
          // farthest entry, so its OWN reported z is directly observable.
          fixtureBranch({ id: 'm', rootX: 0.1, z: 0.9, lifecycle: 'mature', generation: 0 }),
        ],
      },
    ];
    const bound: ForkZBound = { maxGeneration: 5, childZJitterMax: 0.05 }; // would inflate by 0.25 if this were growing
    expect(computeBakeThreats(systems, 0.15, bound)).toEqual([]); // resolves safe -- nothing farther than it, so raw z=0.9 (unlisted) is never even exposed here...
    // ...so prove it more directly: a nearer, unrelated branch is only
    // withheld if the mature one's EFFECTIVE z is compared as 0.9 (its raw
    // value), not 0.9+0.25=1.15 -- construct the nearer branch at z=0.92
    // (between the two): if 'm' were wrongly inflated past 0.92, 'm' would
    // still register as farther and withhold it; since 'm' truly stays at
    // its raw 0.9, a candidate at z=0.92 (farther than 'm') is correctly
    // UNTHREATENED by 'm' at all (0.9 <= 0.92, filtered by isSafeToBake's
    // own `entry.z <= args.z` check), proving 'm' was resolved and reported
    // using its raw z, not an inflated one.
    const systemsB: BakeSafetySystem[] = [
      {
        branches: [
          fixtureBranch({ id: 'm', rootX: 0.05, z: 0.9, lifecycle: 'mature', generation: 0 }),
          fixtureBranch({ id: 'other', rootX: 0.2, z: 0.92, lifecycle: 'mature', generation: 0 }),
        ],
      },
    ];
    expect(computeBakeThreats(systemsB, 0.15, bound)).toEqual([]); // both resolve safe -- 'm' never threatens 'other' at its true, un-inflated z
  });

  it("sorts by the uniform effective value, so a GROWING branch's inflated bound correctly lands in the threat list before a MATURE candidate whose real z falls between the growing branch's raw and inflated values", () => {
    // g: raw z=0.5, generation=0, maxGeneration=2, jitterMax=0.1 -> inflated
    // threatZ = 0.5 + 2*0.1 = 0.7. m: real z=0.6 (between g's raw 0.5 and
    // inflated 0.7) -- under the OLD (snapshot-only, un-inflated) formula, g
    // (raw 0.5) would sort AFTER m (0.6) and so would NOT yet be in
    // `threats` when m is resolved, letting m wrongly resolve safe. Under
    // the fix, g's inflated 0.7 sorts BEFORE m, so m's resolution correctly
    // sees g as a (farther, unrelated) threat and stays blocked.
    const bound: ForkZBound = { maxGeneration: 2, childZJitterMax: 0.1 };
    const systems: BakeSafetySystem[] = [
      {
        branches: [
          fixtureBranch({ id: 'm', rootX: 0.5, reachX: 0.55, z: 0.6, lifecycle: 'mature', generation: 0 }),
          fixtureBranch({ id: 'g', rootX: 0.62, z: 0.5, lifecycle: 'growing', generation: 0 }), // rootX close enough to threaten m (0.62 <= 0.55 + margin 0.15 = 0.7)
        ],
      },
    ];
    const threats = computeBakeThreats(systems, 0.15, bound);
    expect(threats).toEqual([
      { id: 'g', z: 0.7, rootX: 0.62 }, // g's inflated value, processed first
      { id: 'm', z: 0.6, rootX: 0.5 }, // m stays blocked -- g's inflated (not raw) z is what makes this correct
    ]);
  });
});

describe('isAncestorOrDescendant — fork-lineage id-prefix relationship', () => {
  it('is true for identical ids', () => {
    expect(isAncestorOrDescendant('fg0:root1:0', 'fg0:root1:0')).toBe(true);
  });

  it('is true for a direct parent/child pair, in either argument order', () => {
    expect(isAncestorOrDescendant('fg0:root1:0', 'fg0:root1:0/child0')).toBe(true);
    expect(isAncestorOrDescendant('fg0:root1:0/child0', 'fg0:root1:0')).toBe(true);
  });

  it('is true for a multi-generation descendant', () => {
    expect(isAncestorOrDescendant('fg0:root1:0', 'fg0:root1:0/child0/child1/child0')).toBe(true);
  });

  it('is false for true siblings/cousins forked from a common ancestor at different points -- the exact real-evidence shape', () => {
    // fg0:root1:0/child0/child1 vs fg0:root1:0/child0/child0/child0/child0/child0
    // (docs/HANDOFF.md session 018's own traced example): both descend from
    // fg0:root1:0/child0, but neither is an ancestor of the other.
    expect(isAncestorOrDescendant('fg0:root1:0/child0/child1', 'fg0:root1:0/child0/child0/child0/child0/child0')).toBe(false);
  });

  it('is false for ids that merely share a string prefix without a "/" boundary', () => {
    expect(isAncestorOrDescendant('fg0:root1:0', 'fg0:root10:0')).toBe(false);
  });

  it('is false for a different root of the same system', () => {
    expect(isAncestorOrDescendant('fg0:root0:0', 'fg0:root1:0')).toBe(false);
  });
});

describe('isSafeToBake — bake-order safety predicate (branch-level)', () => {
  it('withholds (false) when an unrelated farther-z branch starts at or before tipX + margin', () => {
    // The exact violation shape found via integration testing: this
    // content (nearer, z=0.2) reached far ahead (tipX=0.5); the other
    // branch (farther, z=0.8) is STILL GROWING, spawned back at its own
    // anchor (rootX=0.06) -- its eventual bake (whenever it matures) will
    // still cover that whole path from 0.06 onward, so it could still
    // arrive later and paint over this content near there.
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root1:0', z: 0.8, rootX: 0.06 }];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.2, tipX: 0.5, threats, margin: 0.15 })).toBe(false);
  });

  it("allows (true) once that farther branch's own start has moved well past tipX + margin", () => {
    // A forked child, spawned once its lineage's own growth had already
    // swept well past this content's tipX + margin (0.5 + 0.15 = 0.65) --
    // its own rootX (0.7) is already beyond that, so its future bake can
    // never retroactively cover this content's territory back at 0.5.
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root1:0/child0', z: 0.8, rootX: 0.7 }];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.2, tipX: 0.5, threats, margin: 0.15 })).toBe(true);
  });

  it('never gates against a nearer or equal-z growing branch (nearer/equal painting on top is already correct)', () => {
    const threats: BakeThreatEntry[] = [
      { id: 'fg0:root1:0', z: 0.6, rootX: 0.12 }, // equal z
      { id: 'fg0:root2:0', z: 0.1, rootX: 0.12 }, // nearer z, right nearby -- would gate if treated as farther
    ];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.6, tipX: 0.9, threats, margin: 0.15 })).toBe(true);
  });

  it('treats "no growing branches at all" as no active threat', () => {
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.2, tipX: 0.5, threats: [], margin: 0.15 })).toBe(true);
  });

  it('never gates against itself (same id can appear at most as z<=ownZ, and is excluded by ancestor/descendant anyway)', () => {
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root1:0', z: 0.8, rootX: 0.06 }];
    expect(isSafeToBake({ id: 'fg0:root1:0', z: 0.8, tipX: 0.9, threats, margin: 0.15 })).toBe(true);
  });

  // --- The ancestor-exclusion deadlock-avoidance case -- the single most
  // important behavior in this file. Without excluding a branch's own
  // still-growing descendants, a branch would ALWAYS see its own child as a
  // threat: a forked child's rootX always falls on its own parent's
  // already-grown path, by construction (spawnChildBranch's
  // `rootX: parent.tipX`), so "child.rootX <= parent's own reach + margin"
  // would always hold -- permanently blocking that branch from ever going
  // final for as long as it keeps producing children, likely forever in
  // practice.
  it('is NOT blocked by its own actively-growing, farther-z child (the deadlock case)', () => {
    // Parent 'fg0:root0:0' reached tipX=0.5; its own child forked off at
    // that exact point (rootX: parent.tipX), drew a FARTHER z via
    // childZJitter, and is still growing.
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root0:0/child0', z: 0.6, rootX: 0.5 }];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.3, tipX: 0.5, threats, margin: 0.15 })).toBe(true);
  });

  it('is NOT blocked by a farther-z multi-generation descendant either', () => {
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root0:0/child0/child1/child0', z: 0.9, rootX: 0.55 }];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.3, tipX: 0.5, threats, margin: 0.15 })).toBe(true);
  });

  it("is symmetric: a growing child is likewise not blocked by its own farther-z, still-growing ANCESTOR", () => {
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root0:0', z: 0.6, rootX: 0.1 }];
    expect(isSafeToBake({ id: 'fg0:root0:0/child0', z: 0.3, tipX: 0.6, threats, margin: 0.15 })).toBe(true);
  });

  // --- The true sibling/cousin conflict: mirrors the real pixel-level
  // evidence exactly (docs/HANDOFF.md session 018) -- two branches forked
  // from a COMMON ancestor, at different fork points, ending up with
  // different z, neither an ancestor of the other.
  it('withholds a nearer cousin when a farther, unrelated cousin is still growing nearby, then allows once it passes', () => {
    const nearerCousinId = 'fg0:root1:0/child0/child1';
    const fartherCousinId = 'fg0:root1:0/child0/child0/child0/child0/child0'; // true cousin: shares only 'fg0:root1:0/child0', neither is the other's ancestor
    expect(isAncestorOrDescendant(nearerCousinId, fartherCousinId)).toBe(false); // sanity

    const stillNearby: BakeThreatEntry[] = [{ id: fartherCousinId, z: 0.7, rootX: 0.5 }];
    expect(isSafeToBake({ id: nearerCousinId, z: 0.3, tipX: 0.5, threats: stillNearby, margin: 0.15 })).toBe(false);

    const alreadyPast: BakeThreatEntry[] = [{ id: fartherCousinId, z: 0.7, rootX: 0.7 }];
    expect(isSafeToBake({ id: nearerCousinId, z: 0.3, tipX: 0.5, threats: alreadyPast, margin: 0.15 })).toBe(true);
  });

  it('still gates correctly for the original cross-root case (a special case of the general branch-level check)', () => {
    const threats: BakeThreatEntry[] = [{ id: 'fg0:root1:0', z: 0.8, rootX: 0.06 }];
    expect(isSafeToBake({ id: 'fg0:root0:0', z: 0.2, tipX: 0.5, threats, margin: 0.15 })).toBe(false);
  });
});

describe('createBotanicalStyle — bake-order safety: single-root, no-forking regression (must be a complete no-op)', () => {
  // IMPORTANT (session 018): this describe block's title/scope narrowed
  // deliberately from the original fix's "single-root = complete no-op"
  // guarantee. The generalized, branch-level check can now legitimately
  // gate a single-root session's `final` flags too, whenever forking
  // produces a farther-z cousin close enough to conflict -- that's the
  // fix's whole point, not a regression (see the next describe block,
  // "single-root WITH forking", for a test proving that legitimate gating
  // actually happens). The bar that DOES still hold unconditionally is
  // narrower and structural: a session where NO branch ever forks at all
  // has no way to ever produce two unrelated branches with differing z
  // (spawnRootBranch's resprouts all share their root's own fixed z,
  // never jittered -- only spawnChildBranch's childZJitter introduces z
  // variation), so it genuinely can never have a real conflict to gate
  // against, at any rootCount. `forkCountMin: 0, forkCountSpan: 0` forces
  // `drawForkFractions`'s draw to always resolve to a fork count of 0
  // (botanical.ts), which computeForkFractions/checkCrossedForks (branch.ts)
  // turn into "this branch never forks, ever" -- a real, not simulated,
  // guarantee of zero forking for the whole test.
  // Roadmap C1 rework: `trunkCount: 1` -- a SINGLE trunk lineage. Its
  // continuation segments all share the lineage's own fixed z (carried from
  // the origin), so with forking off there is never a farther-z unrelated
  // branch to gate against; `final` must be exactly `lifecycle === 'mature'`.
  const NO_FORK_OVERRIDES = { forkCountMin: 0, forkCountSpan: 0, trunkCount: 1 };

  it('final is exactly `lifecycle === "mature"` for every fg0 branch in a single-trunk, no-forking session, byte-for-byte the pre-fix formula', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };
    const { renderer, state } = createBotanicalInternal(NO_FORK_OVERRIDES);
    renderer.init(createWorld('single-root-noop-seed', 0, overrides));

    runTicks(renderer, 800, 16.67, () => makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.4 }));

    expect(state.foregroundSystems[0]!.branches.some((b) => b.lifecycle === 'mature')).toBe(true); // sanity: real maturity happened
    expect(state.foregroundSystems[0]!.branches.every((b) => b.generation === 0)).toBe(true); // sanity: no forking actually occurred

    const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
    const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
    const finals = strokeFinalFlags(layer.elements);

    expect(finals.length).toBe(branches.length); // sanity: same alignment emitGrowthSystem produces
    finals.forEach((final, i) => {
      expect(final).toBe(branches[i]!.lifecycle === 'mature');
    });
  });

  it('scene() and sceneLayers() agree with each other in the single-trunk, no-forking case too (no divergence introduced by the fix)', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };
    const renderer = createBotanicalStyle(NO_FORK_OVERRIDES);
    renderer.init(createWorld('single-root-consistency-seed', 0, overrides));
    runTicks(renderer, 500, 16.67, () => makeParams({ speed: 0.7, expansion: 0.5, symmetry: 0.5 }));

    const flattened = (renderer.sceneLayers?.() ?? []).flatMap((l) => l.elements);
    expect(flattened.length).toBeGreaterThan(0);
    expect(flattened).toEqual(renderer.scene().elements);
  });
});

describe('createBotanicalStyle — bake-order safety: single-root WITH forking (new coverage, session 018; rewritten roadmap C3.5)', () => {
  // ROADMAP C3.5 (docs/HANDOFF.md Roadmap C / Session 026) -- the bake-
  // pipeline split. This block's session-018 premise (a mature forked twig's
  // `final` flag is WITHHELD while an unrelated farther-z cousin still grows
  // nearby) is now obsolete BY DESIGN for the foreground bucket: a mature
  // branch of generation >= 1 resolves `bakeResolved` immediately, skipping
  // the isSafeToBake gate and the forced-bake ceiling entirely, so the live
  // (per-frame-redrawn) set stays flat no matter how dense forking is set.
  // The founder accepted the resulting fine-twig depth-ordering imprecision
  // as the cost of that (same artifact class as the forced-bake ceiling).
  // The careful gate is preserved for generation-0 main branches -- see the
  // "forced two-root integration" block's rewritten withhold test.
  it('a mature generation>=1 forked twig in a single-root foreground session resolves bakeResolved immediately -- never withheld, ceiling counter never advances', () => {
    const overrides: WorldOverrides = { ...FAST_CYCLE_OVERRIDES, rootCount: 0 };
    const { renderer, state } = createBotanicalInternal({ ...FIXED_TRUNKS(1), crossRootBakeSafetyMargin: 0.4 }); // large margin -- the OLD gate would withhold heavily here
    renderer.init(createWorld('single-root-forking-withhold-seed', 0, overrides));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.6, symmetry: 0.4 });
    let sawMatureFork = false;
    let sawMatureForkNotYetFinal = false;
    let time = 0;
    for (let t = 0; t < 1200; t++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;

      const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
      const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
      strokeFinalFlags(layer.elements).forEach((final, i) => {
        const b = branches[i]!;
        if (b.lifecycle === 'mature' && b.generation >= 1) {
          sawMatureFork = true;
          if (!final) sawMatureForkNotYetFinal = true;
        }
      });
    }

    expect(sawMatureFork).toBe(true); // sanity: mature forked twigs really did occur
    // The C3.5 point: a mature gen>=1 twig is NEVER emitted non-final, and
    // its forced-bake ceiling counter never advances (it resolves before the
    // ceiling path is ever reached).
    expect(sawMatureForkNotYetFinal).toBe(false);
    expect(
      state.foregroundSystems[0]!.branches.every((b) => b.generation === 0 || b.matureBlockedMs === 0),
    ).toBe(true);
  });
});

describe('createBotanicalStyle — bake-order safety: forced two-root integration', () => {
  // Roadmap C1 rework: exactly two persistent trunk-lineages (was the
  // rootCount=0.75 knob). Each lineage always has one growing gen-0 segment.
  const TWO_ROOT_OVERRIDES: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };
  const TWO_ROOT_TUNING = FIXED_TRUNKS(2);

  it('no baked-order violation occurs between any two UNRELATED branches WHERE A GENERATION-0 MAIN BRANCH IS INVOLVED -- cross-root or same-root cousins alike -- across many ticks and several seeds', () => {
    // Generalized (session 018) from a cross-root-only sweep: with default
    // tuning, forking is on (forkCountMin/Span) and childZJitter is nonzero,
    // so this now also naturally exercises same-root sibling/cousin
    // conflicts, not just cross-root ones -- the same brute-force pixel-
    // proximity check now covers the whole generalized bug class in one
    // sweep. Ancestor/descendant pairs are deliberately excluded from the
    // violation count: the safety mechanism intentionally never gates a
    // branch against its own lineage (isAncestorOrDescendant's own doc
    // comment -- excluding it is required to avoid a permanent deadlock),
    // so a child baking farther-z over its own parent's territory is
    // expected, accepted behavior, not a bug this check should flag.
    //
    // ROADMAP C3.5 (docs/HANDOFF.md Roadmap C / Session 026): pairs where
    // BOTH branches are generation >= 1 are now also excluded. Foreground
    // mature gen>=1 forked twigs resolve `bakeResolved` immediately (no
    // isSafeToBake gate, no forced-bake ceiling), which is what keeps the
    // live per-frame redraw set flat regardless of forking density -- at
    // the cost of twig-vs-twig bake order no longer being guaranteed (a
    // founder-accepted fine-detail depth-ordering artifact, same class as
    // the forced-bake ceiling's). This sweep now guards exactly what still
    // matters: bake order wherever a generation-0 MAIN branch is involved.
    const CLOSE_THRESHOLD = 0.04; // world units -- roughly a branch stroke width or two
    const dt = 16.67;
    const TICKS = 1200;

    for (let seedNum = 0; seedNum < 5; seedNum++) {
      const { renderer, state } = createBotanicalInternal({ ...CEILING_EFFECTIVELY_DISABLED, ...TWO_ROOT_TUNING });
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
          if (isAncestorOrDescendant(a.id, b.id)) continue;
          // Roadmap C3.5 (docs/HANDOFF.md Roadmap C / Session 026): a mature
          // gen>=1 forked twig bakes IMMEDIATELY (no isSafeToBake gate, no
          // forced-bake ceiling) -- by design, to keep the live redraw set
          // flat under dense forking. That removes both the twig's own
          // ordering guarantee AND the indirect protection nearby content got
          // from a still-blocked twig sitting in the threat list. The
          // resulting fine-twig depth-ordering imprecision is the
          // founder-accepted artifact (same class as the forced-bake
          // ceiling's, which the sweeps already disable to test the pure
          // model). What C3.5 promises to preserve exactly is ordering
          // between generation-0 MAIN branches -- so the sweep now counts
          // only pairs where BOTH branches are generation 0.
          if (a.generation >= 1 || b.generation >= 1) continue;
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

  it("withholds a nearer, already-mature GENERATION-0 main branch's final flag until the farther main branch's frontier catches up, in the full renderer pipeline", () => {
    // ROADMAP C3.5: the careful cross-branch bake gate is PRESERVED for
    // generation-0 main branches (only mature gen>=1 twigs fast-resolve).
    // Roadmap C1 rework: 4 persistent trunk-lineages stratified across depth,
    // plus a large safety margin, guarantee that over a long run some mature
    // gen-0 segment is observed still non-final while a farther-z gen-0
    // segment of another lineage grows within the margin.
    const { renderer, state } = createBotanicalInternal({
      trunkCount: 4,
      crossRootBakeSafetyMargin: 0.4,
    });
    renderer.init(createWorld('bake-safety-withhold-seed', 0, TWO_ROOT_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.5, symmetry: 0.5 });
    let sawMatureGen0NotYetFinal = false;
    let time = 0;
    for (let t = 0; t < 2000 && !sawMatureGen0NotYetFinal; t++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;

      const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'fg0')!;
      const branches = state.foregroundSystems[0]!.branches.filter((b) => b.segments.length >= 2);
      strokeFinalFlags(layer.elements).forEach((final, i) => {
        const b = branches[i]!;
        if (b.lifecycle === 'mature' && b.generation === 0 && !final) sawMatureGen0NotYetFinal = true;
      });
    }

    expect(sawMatureGen0NotYetFinal).toBe(true);
  });

  it('same seed, forced two roots, produces identical scenes across two independent runs (determinism holds with the safety gate engaged)', () => {
    const a = createBotanicalInternal(TWO_ROOT_TUNING);
    const b = createBotanicalInternal(TWO_ROOT_TUNING);
    a.renderer.init(createWorld('bake-safety-determinism-seed', 0, TWO_ROOT_OVERRIDES));
    b.renderer.init(createWorld('bake-safety-determinism-seed', 0, TWO_ROOT_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.7, expansion: 0.6, symmetry: 0.4 });
    runTicks(a.renderer, 900, 16.67, paramsAt);
    runTicks(b.renderer, 900, 16.67, paramsAt);

    // Exactly 2 lineage origins, fixed for the whole session (the roadmap C1
    // rework: trunkCount is the exact, constant count).
    expect(a.state.foregroundSystems[0]!.roots.length).toBe(2);
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

describe('createBotanicalStyle — bake-order safety: single-root foreground, generous sweep (session 020 -- verifies the snapshot-timing-gap fix covers foreground too, not just echo)', () => {
  // Session 019's hypothesis: the snapshot-timing gap (a nearer branch
  // resolves safe and bakes before a farther, not-yet-spawned cousin
  // forks and later overwrites it) was always theoretically possible for
  // foreground, just statistically rarer there than for echo -- foreground
  // roots are z-separated by a full 1/rootCount gap, while a single-root
  // system (like every echo, or foreground forced to rootCount=1 here)
  // has every branch sharing one much tighter z band, making a same-root
  // cousin conflict more likely to actually manifest within a bounded
  // seed/tick budget. This test forces foreground into that SAME
  // maximally-analogous single-root shape (mirroring session 019's own
  // echo violation sweep almost exactly, just against `state.
  // foregroundSystems[0]` instead of `state.echoes[i]`) at a generously
  // larger budget (10 seeds, 2000 ticks vs the two-root test's 5/1200) --
  // if the snapshot-timing-gap fix genuinely closes the algorithm-level
  // hole (not just something echo-shaped), this should pass here too.
  it('no bake-order violation occurs between any two unrelated branches within a forced single-root foreground system, across many ticks and several seeds', () => {
    // Session 021: no logic changed here, but this now legitimately takes
    // longer than the default 5000ms test timeout -- decoupling blossom
    // reveal from bake-safety means many more blossoms can be concurrently
    // revealed-but-unresolved (see docs/HANDOFF.md session 021's perf
    // measurement), which is real, bounded-but-not-cheap work across 10
    // seeds x 2000 ticks of a single-root, FAST_CYCLE_OVERRIDES scenario.
    const CLOSE_THRESHOLD = 0.04; // world units -- same heuristic the other violation sweeps use ("roughly a branch stroke width or two")
    const dt = 16.67;
    const TICKS = 2000;
    const SEED_COUNT = 10;
    const SINGLE_ROOT_OVERRIDES: WorldOverrides = { ...FAST_CYCLE_OVERRIDES };

    for (let seedNum = 0; seedNum < SEED_COUNT; seedNum++) {
      const { renderer, state } = createBotanicalInternal({ ...CEILING_EFFECTIVELY_DISABLED, ...FIXED_TRUNKS(1) });
      renderer.init(createWorld(`single-root-fg-generous-sweep-seed-${seedNum}`, 0, SINGLE_ROOT_OVERRIDES));
      expect(state.foregroundSystems[0]!.roots.length).toBe(1); // sanity: genuinely single-root

      const firstFinalTick = new Map<number, number>();
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
          if (isAncestorOrDescendant(a.id, b.id)) continue;
          // Roadmap C3.5 (docs/HANDOFF.md Roadmap C / Session 026): a mature
          // gen>=1 forked twig bakes IMMEDIATELY (no isSafeToBake gate, no
          // forced-bake ceiling) -- by design, to keep the live redraw set
          // flat under dense forking -- which relaxes twig-involved bake
          // order (the founder-accepted fine-detail artifact, same class as
          // the forced-bake ceiling's that these sweeps already disable).
          // What C3.5 preserves exactly is ordering between generation-0 MAIN
          // branches, so the sweep counts only pairs where both are gen 0.
          if (a.generation >= 1 || b.generation >= 1) continue;
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
  }, 60000);
});

// --- Session 019: bake-order safety extended to echo systems --------------
// Sessions 017-018 only ever gated `state.foregroundSystems` -- resolveBake
// Threats built its threats list from foreground branches alone, and
// emitGrowthSystem's `applyBakeSafety` was hardcoded false at both echo call
// sites, on the (correct-as-far-as-it-went, but incomplete) theory that
// "echoes are their own separate compositor bucket, so they don't need this
// check." Being a separate bucket means an echo's OWN branches never
// threaten foreground or the other echo -- it does NOT mean an echo's own
// sibling/cousin forked branches (spawnChildBranch's childZJitter applies to
// echo branches exactly like foreground ones -- see ECHO_CONFIGS'
// maxGenerationCap) can't threaten each other within that same bucket.
// Session 019's pixel-diff evidence (renderScene() vs live-compositor,
// docs/HANDOFF.md) found exactly this: an echo branch baking unconditionally
// the instant it matured, permanently overwriting a farther-z unrelated
// echo cousin still growing nearby. These tests mirror the equivalent
// foreground describe blocks above (single-root-with-forking, the two-root
// violation sweep, the reveal-pacing-vs-bake-safety distinction) but scoped
// to `state.echoes` -- echoes have no "two-root" variant to mirror (each
// ECHO_CONFIGS entry fixes `rootCount: 1`, not a world knob), so only the
// forking-driven conflict applies, exactly like the foreground
// single-root-WITH-forking case.
describe('createBotanicalStyle — bake-order safety: echo systems (session 019)', () => {
  it("withholds a mature ECHO branch's final flag when its own unrelated, farther-z cousin is still growing nearby (echo0)", () => {
    const { renderer, state } = createBotanicalInternal({ crossRootBakeSafetyMargin: 0.4 }); // large margin -- easy to observe withholding within a bounded tick budget
    renderer.init(createWorld('echo-forking-withhold-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.6, expansion: 0.6, symmetry: 0.4 });
    let sawMatureNotYetFinal = false;
    let sawFork = false;
    let time = 0;
    for (let t = 0; t < 1500 && !sawMatureNotYetFinal; t++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;

      if (state.echoes[0]!.branches.some((b) => b.generation > 0)) sawFork = true;

      const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'echo0')!;
      const branches = state.echoes[0]!.branches.filter((b) => b.segments.length >= 2);
      strokeFinalFlags(layer.elements).forEach((final, i) => {
        if (branches[i]!.lifecycle === 'mature' && !final) sawMatureNotYetFinal = true;
      });
    }

    expect(sawFork).toBe(true); // sanity: forking actually happened -- this is what makes the conflict possible at all
    expect(sawMatureNotYetFinal).toBe(true);
  });

  // FIXED (session 020) -- was `it.fails` through session 019, documenting
  // a genuine, reproducible finding (2 of 5 seeds, 6 violating pairs) rather
  // than hiding it: the algorithm resolveBucketBakeThreats/computeBakeThreats
  // /isSafeToBake reused (unchanged in shape, per session 019's own
  // contract) was a SNAPSHOT check -- a branch resolved safe against
  // whichever OTHER branches already existed at the moment it was
  // evaluated, then was marked `bakeResolved` and never re-examined. If a
  // NEW farther-z sibling/cousin was spawned (forked) LATER -- after a
  // nearer branch had already resolved safe and baked -- nothing revisited
  // that earlier resolution; the new, farther branch could still legitimately
  // mature and bake later, painting over the earlier, nearer, already-baked
  // one. This was a gap in the ORIGINAL algorithm itself (sessions
  // 017-018), not something session 019's bucket-grouping change
  // introduced -- it was likely always theoretically possible for
  // foreground too, just statistically rarer there (foreground's roots are
  // z-separated by a full 1/rootCount gap; each ECHO_CONFIGS entry fixes
  // `rootCount: 1`, so every branch in one echo system -- across every
  // generation, every fork -- shares one much tighter z band, only
  // `childZJitter` ever separating them).
  //
  // Session 020's fix (computeBakeThreats' own "THE SNAPSHOT-TIMING GAP"
  // doc comment has the full mechanism): a still-GROWING branch's threat z
  // is no longer its own current z -- it's a conservative upper bound on
  // how far z could drift across every fork its lineage could still
  // produce before hitting the bucket's generation cap
  // (`z + (maxGeneration - generation) * childZJitterMax`, clamped to 1).
  // This can only ever over-estimate a real future descendant's z, so it
  // can only make the check MORE conservative, never introduce a new false
  // "safe." Investigated separately (per that fix's own contract, see
  // isAncestorOrDescendant's own investigation note): none of the 6
  // originally-violating pairs were ancestor/descendant pairs, so the
  // ancestor/descendant exclusion was never hiding anything here -- this
  // was genuinely the snapshot-timing gap, not a lineage-exclusion bug.
  it('no bake-order violation occurs between any two unrelated branches WITHIN echo0, or WITHIN echo1, across many ticks and several seeds', () => {
    const CLOSE_THRESHOLD = 0.04; // world units -- roughly a branch stroke width or two
    const dt = 16.67;
    const TICKS = 1200;
    const ECHO_LAYER_IDS = ['echo0', 'echo1'] as const;

    for (let seedNum = 0; seedNum < 5; seedNum++) {
      const { renderer, state } = createBotanicalInternal(CEILING_EFFECTIVELY_DISABLED);
      renderer.init(createWorld(`echo-bake-safety-seed-${seedNum}`, 0, FAST_CYCLE_OVERRIDES));

      const firstFinalTickByLayer: Record<(typeof ECHO_LAYER_IDS)[number], Map<number, number>> = {
        echo0: new Map(),
        echo1: new Map(),
      };
      let time = 0;
      for (let t = 0; t < TICKS; t++) {
        renderer.step({ v: 1, expansion: 0.6, speed: 0.6, symmetry: 0.6 }, INITIAL_SESSION_PARAMS, time, dt);
        time += dt;

        for (const layerId of ECHO_LAYER_IDS) {
          const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === layerId)!;
          strokeFinalFlags(layer.elements).forEach((final, i) => {
            if (final && !firstFinalTickByLayer[layerId].has(i)) firstFinalTickByLayer[layerId].set(i, t);
          });
        }
      }

      ECHO_LAYER_IDS.forEach((layerId, echoIndex) => {
        const branches = state.echoes[echoIndex]!.branches.filter((b) => b.segments.length >= 2);
        const firstFinalTick = firstFinalTickByLayer[layerId];
        let violations = 0;
        for (let j = 0; j < branches.length; j++) {
          for (let i = 0; i < branches.length; i++) {
            if (i === j) continue;
            const a = branches[i]!;
            const b = branches[j]!;
            if (isAncestorOrDescendant(a.id, b.id)) continue;
            const tickA = firstFinalTick.get(i);
            const tickB = firstFinalTick.get(j);
            if (tickA === undefined || tickB === undefined) continue;
            if (tickB <= tickA) continue; // only a LATER bake can overwrite an earlier one
            if (b.z <= a.z) continue; // only a FARTHER later bake is a violation
            if (minSegmentDistance(a.segments, b.segments) <= CLOSE_THRESHOLD) violations++;
          }
        }
        expect(violations).toBe(0);
      });
    }
  });

  it("an echo blossom is visible (emitted, final: false) the instant it's revealed even while blocked by a farther unrelated echo cousin -- reveal and bake-safety are decoupled (session 021)", () => {
    // REWRITTEN, session 021 -- this test's session-019 premise (reveal
    // itself withheld by the bake-safety gate, provable by pendingClusters
    // staying non-empty with intervalMs=0) is now false BY DESIGN: the
    // founder reported a real regression (docs/HANDOFF.md) where session
    // 020's more conservative bake-safety bound made blocked blossoms
    // invisible for long stretches, because reveal itself waited on bake
    // safety. The fix decouples them entirely -- revealPendingBlossoms no
    // longer takes a safety argument at all, so with intervalMs=0 (pacing
    // timer disabled) EVERY due blossom reveals immediately, full stop.
    // What's gated now is `bakeResolved` (and therefore the emitted
    // CircleElement's `final` flag), not reveal -- this test proves BOTH
    // halves: reveal is never held open, and a revealed blossom's `final`
    // flag genuinely can lag while it's still bake-unsafe (proving it's a
    // real gate, not a no-op), while being visible in the scene throughout.
    const { renderer, state } = createBotanicalInternal({ crossRootBakeSafetyMargin: 0.4, blossomRevealIntervalMs: 0 });
    renderer.init(createWorld('echo-blossom-visible-not-final-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.9, expansion: 0.9, symmetry: 0.5 });
    let sawHeldOpenCluster = false;
    let sawVisibleButNotFinal = false;
    let sawAnyRevealedBlossom = false;
    let time = 0;
    for (let t = 0; t < 1500; t++) {
      renderer.step(paramsAt(), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;

      if (state.echoes[0]!.pendingClusters.some((c) => c.revealedCount < c.blossoms.length)) sawHeldOpenCluster = true;

      const layer = (renderer.sceneLayers?.() ?? []).find((l) => l.layerId === 'echo0')!;
      const circles = layer.elements.filter((e) => e.kind === 'circle');
      if (circles.length > 0) sawAnyRevealedBlossom = true;
      if (circles.some((e) => e.final !== true)) sawVisibleButNotFinal = true;
    }

    expect(sawAnyRevealedBlossom).toBe(true); // sanity: clusters actually formed and revealed during the run
    // Reveal itself is NEVER held open now, even with a farther unrelated
    // branch still growing nearby -- intervalMs=0 always drains a cluster
    // the instant each blossom is due, regardless of bake-safety.
    expect(sawHeldOpenCluster).toBe(false);
    // But at least one revealed blossom was genuinely visible-yet-not-yet-
    // safe-to-bake at some point -- proving the bake-safety gate still
    // does real work (blossom.bakeResolved/CircleElement.final), just no
    // longer at the cost of hiding the blossom while it waits.
    expect(sawVisibleButNotFinal).toBe(true);
  },
  // Roadmap C3.5 (docs/HANDOFF.md Roadmap C / Session 026): the foreground
  // population now forks continuously all session (gate is the growing-branch
  // count, not the append-only total), so there is materially more permanent
  // foreground ink for this test's per-tick `sceneLayers()` call to walk
  // even though the LIVE redraw set stays flat -- ~6s wall now vs the old
  // ~0.7s. The bound this test guards is reveal/final decoupling, not speed.
  30000);

  it('same seed produces identical scenes across two independent runs with echo bake-safety gating engaged (determinism holds)', () => {
    const a = createBotanicalInternal();
    const b = createBotanicalInternal();
    a.renderer.init(createWorld('echo-bake-safety-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    b.renderer.init(createWorld('echo-bake-safety-determinism-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = () => makeParams({ speed: 0.7, expansion: 0.6, symmetry: 0.4 });
    runTicks(a.renderer, 900, 16.67, paramsAt);
    runTicks(b.renderer, 900, 16.67, paramsAt);

    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

// --- Roadmap B: forced-bake ceiling ------------------------------------
// A `mature` branch (or an already-revealed blossom) that has been blocked
// from resolving safe for longer than tuning.forcedBakeCeilingMs of
// SIMULATED time is force-marked bakeResolved anyway, regardless of what
// isSafeToBake says (resolveBucketBakeThreats in botanical.ts). This was
// originally the fix for the foreground's near-origin gen-0 resprout, which
// parked a growing branch at low x forever so mature branches behind it
// never baked. Roadmap C1 (and its rework) replaced foreground resprout
// entirely -- the persistent trunk-lineage model advances each lineage from
// its own tip, so no growing branch is ever parked at low x -- so that
// specific runaway is gone. The ceiling now stands purely as a
// belt-and-braces safety net (echo systems still resprout; C4 changes them).
// The founder approved this blunt ceiling and explicitly accepted the
// resulting rare, small depth-ordering artifact as permanent.
describe('createBotanicalStyle — forced-bake ceiling (roadmap B)', () => {
  const TWO_ROOT_FAST: WorldOverrides = { baseGrowthRate: 0.99, matureDurationMs: 0 };
  const TWO_TRUNKS = { trunkCount: 2 }; // roadmap C1 rework: exactly two persistent lineages

  function matureUnresolvedCount(state: ReturnType<typeof createBotanicalInternal>['state']): number {
    let n = 0;
    for (const system of state.foregroundSystems) {
      for (const branch of system.branches) {
        if (branch.lifecycle === 'mature' && !branch.bakeResolved) n++;
      }
    }
    return n;
  }
  function unresolvedBlossomCount(state: ReturnType<typeof createBotanicalInternal>['state']): number {
    let n = 0;
    for (const system of state.foregroundSystems) n += system.unresolvedBlossoms.length;
    return n;
  }
  const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it(
    'the mature-but-unresolved branch set (and the unresolved-blossom set) stays bounded and drains over 60+ simulated seconds -- with OR without the ceiling (roadmap C1 removed the near-origin blocker the ceiling was papering over)',
    () => {
      // ROADMAP C1 (rework) UPDATE: this test's original regression guard --
      // "without the ceiling this FAST_CYCLE + 2-root foreground scenario
      // reproduces the runaway (unresolved-blossom set into the thousands)"
      // -- no longer holds, BY DESIGN. That runaway came from the
      // foreground's near-origin gen-0 resprout permanently parking a growing
      // branch at low x, so every mature branch behind it stayed blocked
      // forever. The persistent trunk-lineage model advances each lineage
      // from its own tip (never back at the fixed origin), so no growing
      // branch is ever parked at low x and the foreground live set is bounded
      // on its own. The forced-bake ceiling stays as a belt-and-braces safety
      // net (echoes still resprout; C4 changes them) -- this test now
      // verifies it stays bounded either way and the ceiling never makes it
      // worse.
      const dt = 16.67;
      const TICKS = 3600; // 60 simulated seconds
      const SAMPLE_EVERY = 300; // once per 5 simulated seconds

      function sweep(ceilingOverride?: { forcedBakeCeilingMs: number }) {
        const { renderer, state } = createBotanicalInternal({ ...TWO_TRUNKS, ...ceilingOverride });
        renderer.init(createWorld('forced-ceiling-plateau-seed', 0, TWO_ROOT_FAST));
        const mature: number[] = [];
        const blossoms: number[] = [];
        let time = 0;
        for (let t = 0; t < TICKS; t++) {
          renderer.step({ v: 1, expansion: 0.6, speed: 0.6, symmetry: 0.6 }, INITIAL_SESSION_PARAMS, time, dt);
          time += dt;
          if ((t + 1) % SAMPLE_EVERY === 0) {
            mature.push(matureUnresolvedCount(state));
            blossoms.push(unresolvedBlossomCount(state));
          }
        }
        return { mature, blossoms };
      }

      const withCeiling = sweep(); // DEFAULT_BOTANICAL_TUNING_CONFIG.forcedBakeCeilingMs (4000ms)
      const noCeiling = sweep(CEILING_EFFECTIVELY_DISABLED);

      const postWarmup = (xs: number[]) => xs.slice(2, 6);
      const lateThird = (xs: number[]) => xs.slice(-4);

      // --- Roadmap C1 rework note: two PERSISTENT trunk-lineages always keep
      // a growing gen-0 segment near each lineage's path, so a gen-0 blossom
      // spatially behind the OTHER trunk can stay isSafeToBake-blocked
      // indefinitely -- WITHOUT the ceiling this genuinely drifts upward
      // (that's exactly what the ceiling is for). So the plateau / no-drift
      // guarantee is asserted for the WITH-ceiling run; the no-ceiling run is
      // only required to stay under the hard cap and to be no smaller than
      // the ceiling run (the ceiling can only ever force MORE content to
      // resolve). ---
      for (const run of [withCeiling, noCeiling]) {
        expect(Math.max(...run.mature)).toBeLessThan(200);
        expect(Math.max(...run.blossoms)).toBeLessThan(2000);
      }
      expect(average(lateThird(withCeiling.blossoms))).toBeLessThanOrEqual(
        average(postWarmup(withCeiling.blossoms)) * 2.2 + 60,
      );
      expect(average(lateThird(withCeiling.mature))).toBeLessThanOrEqual(average(postWarmup(withCeiling.mature)) * 2 + 15);

      // --- The ceiling never makes the unresolved set larger; it can only
      // ever force MORE content to resolve, so its maxima are <= the
      // no-ceiling run's. ---
      expect(Math.max(...withCeiling.blossoms)).toBeLessThanOrEqual(Math.max(...noCeiling.blossoms) + 1);
      expect(Math.max(...withCeiling.mature)).toBeLessThanOrEqual(Math.max(...noCeiling.mature) + 1);
    },
    60000,
  );

  it('does NOT fire in the common fast-resolve case: a branch that resolves safe within a tick or few never advances its counter or gets force-resolved', () => {
    // Roadmap C1: the foreground is no longer a single-root, one-z shape
    // (the population model gives concurrent main branches stratified across
    // depth), so the clean "no farther-z threat can ever exist" scenario now
    // lives on an ECHO system -- one root, resprout forever (legacy mode),
    // and with forking off (forkCountMin/Span = 0) every echo0 branch shares
    // echo0's single root z EXACTLY. isSafeToBake only gates against a
    // strictly FARTHER-z threat, so nothing here is ever blocked; every
    // mature echo branch resolves safe the normal way, immediately. The
    // forced-ceiling counter path must be a complete no-op: matureBlockedMs
    // stays 0 for every echo0 branch, for the whole run.
    // DEFAULT ceiling (not disabled) -- it simply must never engage here.
    const { renderer, state } = createBotanicalInternal({ forkCountMin: 0, forkCountSpan: 0 });
    renderer.init(createWorld('forced-ceiling-fast-resolve-seed', 0, FAST_CYCLE_OVERRIDES));

    let sawForcedCounterAdvance = false;
    let time = 0;
    for (let t = 0; t < 900; t++) {
      renderer.step(makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.4 }), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;
      for (const branch of state.echoes[0]!.branches) {
        if (branch.matureBlockedMs !== 0) sawForcedCounterAdvance = true;
      }
    }

    const echo0 = state.echoes[0]!.branches;
    expect(echo0.every((b) => b.generation === 0)).toBe(true); // sanity: forking really was off
    expect(echo0.length).toBeGreaterThan(1); // sanity: the echo resprouted (legacy mode) -- multiple branches over the run
    expect(echo0.some((b) => b.lifecycle === 'mature' && b.bakeResolved)).toBe(true); // sanity: branches did mature and resolve...
    expect(sawForcedCounterAdvance).toBe(false); // ...the normal safe way -- the ceiling counter never advanced for any branch
    expect(echo0.every((b) => b.matureBlockedMs === 0)).toBe(true);
  });

  it('never force-resolves a still-growing branch, no matter how long it has been growing while blocked', () => {
    // Constraint 2: freezing a still-growing stroke mid-taper (its taper
    // depends on its final point count) would visibly stop its growth, so
    // the ceiling must only ever touch `mature` branches. Ceiling forced to
    // 1ms (fires on the very next tick a mature element is blocked) and a
    // 2-root FAST_CYCLE scenario that always has both growing branches and
    // blocked mature branches present -- the growing set must stay
    // untouched every single tick regardless.
    const { renderer, state } = createBotanicalInternal({ ...TWO_TRUNKS, forcedBakeCeilingMs: 1, crossRootBakeSafetyMargin: 0.4 });
    renderer.init(createWorld('forced-ceiling-growing-immune-seed', 0, TWO_ROOT_FAST));

    let sawGrowingBranch = false;
    let sawForcedMatureBake = false;
    let growingEverResolvedOrCounted = false;
    let time = 0;
    for (let t = 0; t < 1500; t++) {
      renderer.step(makeParams({ speed: 0.6, expansion: 0.6, symmetry: 0.6 }), INITIAL_SESSION_PARAMS, time, 16.67);
      time += 16.67;
      for (const system of state.foregroundSystems) {
        for (const branch of system.branches) {
          if (branch.lifecycle === 'growing') {
            sawGrowingBranch = true;
            if (branch.bakeResolved || branch.matureBlockedMs !== 0) growingEverResolvedOrCounted = true;
          } else if (branch.matureBlockedMs >= 1 && branch.bakeResolved) {
            sawForcedMatureBake = true;
          }
        }
      }
    }

    expect(sawGrowingBranch).toBe(true); // sanity: there really were growing branches throughout
    expect(sawForcedMatureBake).toBe(true); // sanity: the 1ms ceiling really was force-baking blocked MATURE branches
    expect(growingEverResolvedOrCounted).toBe(false); // the point: no growing branch was ever force-resolved or even counted
  });

  it('is deterministic: same seed + tuning produces identical scenes across two runs with the ceiling engaged', () => {
    const a = createBotanicalInternal({ ...TWO_TRUNKS, forcedBakeCeilingMs: 2000, crossRootBakeSafetyMargin: 0.4 });
    const b = createBotanicalInternal({ ...TWO_TRUNKS, forcedBakeCeilingMs: 2000, crossRootBakeSafetyMargin: 0.4 });
    a.renderer.init(createWorld('forced-ceiling-determinism-seed', 0, TWO_ROOT_FAST));
    b.renderer.init(createWorld('forced-ceiling-determinism-seed', 0, TWO_ROOT_FAST));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.3 * Math.sin(i * 0.1), expansion: 0.5, symmetry: 0.4 });
    runTicks(a.renderer, 1400, 16.67, paramsAt);
    runTicks(b.renderer, 1400, 16.67, paramsAt);

    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

// --- Roadmap C3.5, Commit 1: bake-pipeline split + growing-count fork gate ---
// docs/HANDOFF.md Roadmap C / Session 026. Two structural changes that TOGETHER
// keep the live (per-frame-redrawn) set flat regardless of how dense the
// `density` knob (Commit 2) is turned up:
//  (a) a mature FOREGROUND branch of generation >= 1 -- a forked twig --
//      resolves `bakeResolved` immediately on the tick it matures, skipping
//      the isSafeToBake gate and the forced-bake ceiling; ditto a revealed
//      blossom on a gen>=1 branch. Generation-0 main branches keep the full
//      careful path.
//  (b) foreground forking is gated on the count of currently-GROWING branches
//      (< maxConcurrentBranches), not the append-only `system.branches` total,
//      so forking continues all session instead of stopping once the total
//      passes the cap.
describe('createBotanicalStyle — bake-pipeline split + growing-count fork gate (roadmap C3.5, Commit 1)', () => {
  const matureUnresolved = (state: ReturnType<typeof createBotanicalInternal>['state']): number => {
    let n = 0;
    for (const system of state.foregroundSystems)
      for (const b of system.branches) if (b.lifecycle === 'mature' && !b.bakeResolved) n++;
    return n;
  };
  const unresolvedBlossoms = (state: ReturnType<typeof createBotanicalInternal>['state']): number => {
    let n = 0;
    for (const system of state.foregroundSystems) n += system.unresolvedBlossoms.length;
    return n;
  };
  const growingForeground = (state: ReturnType<typeof createBotanicalInternal>['state']): number =>
    state.foregroundSystems[0]!.branches.filter((b) => b.lifecycle === 'growing').length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it(
    'the foreground live set (mature-unresolved branches + unresolved blossoms) stays bounded with no upward drift over 60+ simulated seconds at default tuning',
    () => {
      const dt = 16.67;
      const TICKS = 3600; // 60 simulated seconds
      const SAMPLE_EVERY = 300;
      const { renderer, state } = createBotanicalInternal(); // DEFAULT tuning
      renderer.init(createWorld('c3.5-bound-seed', 0, FAST_CYCLE_OVERRIDES));

      const mature: number[] = [];
      const blossoms: number[] = [];
      let time = 0;
      for (let t = 0; t < TICKS; t++) {
        renderer.step({ v: 1, expansion: 0.6, speed: 0.7, symmetry: 0.4 }, INITIAL_SESSION_PARAMS, time, dt);
        time += dt;
        if ((t + 1) % SAMPLE_EVERY === 0) {
          mature.push(matureUnresolved(state));
          blossoms.push(unresolvedBlossoms(state));
        }
      }

      // Well under 200 mature-unresolved (the brief's regression bound) --
      // the gen>=1 fast-resolve drains the bulk immediately, leaving only the
      // handful of generation-0 main branches still in the careful path.
      expect(Math.max(...mature)).toBeLessThan(200);
      expect(Math.max(...blossoms)).toBeLessThan(2000);

      // No upward drift: the late-run average is not materially above the
      // post-warmup average (it drains, it does not accumulate).
      const postWarmup = (xs: number[]) => xs.slice(2, 6);
      const lateThird = (xs: number[]) => xs.slice(-4);
      expect(avg(lateThird(mature))).toBeLessThanOrEqual(avg(postWarmup(mature)) * 2 + 15);
      expect(avg(lateThird(blossoms))).toBeLessThanOrEqual(avg(postWarmup(blossoms)) * 1.8 + 40);
    },
    60000,
  );

  it('a mature generation>=1 twig resolves bakeResolved within one tick of maturity even with farther-z growing threats present; a mature generation-0 main still respects isSafeToBake', () => {
    // 4 persistent trunk-lineages stratified across depth + a large safety
    // margin guarantee farther-z growing gen-0 segments are present
    // throughout, so the gen>=1 fast-resolve is genuinely being exercised
    // against real threats (not a degenerate no-threat scenario).
    const { renderer, state } = createBotanicalInternal({
      trunkCount: 4,
      crossRootBakeSafetyMargin: 0.4,
    });
    renderer.init(createWorld('c3.5-gen-split-seed', 0, FAST_CYCLE_OVERRIDES));

    let sawMatureGen1 = false;
    let matureGen1EverUnresolved = false;
    let sawMatureGen0Blocked = false;
    let time = 0;
    for (let t = 0; t < 2500; t++) {
      renderer.step(makeParams({ speed: 0.8, expansion: 0.6, symmetry: 0.3 }), INITIAL_SESSION_PARAMS, time, 100);
      time += 100;
      for (const b of state.foregroundSystems[0]!.branches) {
        if (b.lifecycle !== 'mature') continue;
        if (b.generation >= 1) {
          sawMatureGen1 = true;
          if (!b.bakeResolved) matureGen1EverUnresolved = true; // must NEVER happen (resolved same tick as maturity)
          if (b.matureBlockedMs !== 0) matureGen1EverUnresolved = true; // ceiling counter must never advance for a twig
        } else if (!b.bakeResolved) {
          sawMatureGen0Blocked = true; // gen-0 still goes through the gate and CAN be withheld
        }
      }
    }

    expect(sawMatureGen1).toBe(true); // sanity: mature twigs really occurred
    expect(matureGen1EverUnresolved).toBe(false); // (a): twigs resolve immediately, ceiling never touches them
    expect(sawMatureGen0Blocked).toBe(true); // gen-0 mains still respect isSafeToBake
  });

  it('the concurrently-growing foreground branch count stays bounded by maxConcurrentBranches (small margin) every tick over a long, dense run', () => {
    // Dense: max trunk count, heavy forking, and a LOW branchDensity world
    // knob so maxConcurrentBranches is small (~15) and the gate is under real
    // pressure. Pre-C3.5 this either froze forking mid-run (old total-count
    // gate) or -- with raised fork counts -- let the growing set balloon.
    const { renderer, state } = createBotanicalInternal({
      trunkCount: 6,
      forkCountMin: 5,
      forkCountSpan: 3,
    });
    renderer.init(createWorld('c3.5-growing-bound-seed', 0, { ...FAST_CYCLE_OVERRIDES, branchDensity: 0 }));

    let maxGrowing = 0;
    let time = 0;
    for (let t = 0; t < 4000; t++) {
      renderer.step(makeParams({ speed: 0.9, expansion: 0.6, symmetry: 0.3 }), INITIAL_SESSION_PARAMS, time, 100);
      time += 100;
      maxGrowing = Math.max(maxGrowing, growingForeground(state));
    }

    // The gate caps forks at maxConcurrentBranches within a tick; the only
    // overshoot is the (mandatory, ungated) trunk-lineage continuations --
    // at most `trunkCount` per tick -- plus that tick's forks not yet
    // reflected in the next reseed. A small, bounded margin.
    expect(maxGrowing).toBeLessThanOrEqual(state.maxConcurrentBranches + 15);
    // Sanity: forking really did continue late (the growing set is genuinely
    // being kept near the cap, not frozen well below it).
    expect(maxGrowing).toBeGreaterThan(state.maxConcurrentBranches * 0.6);
  });

  it('same seed + tuning, run twice, produces an identical scene (determinism holds with both C3.5 changes engaged)', () => {
    const tuning = { trunkCount: 4, forkCountMin: 4, forkCountSpan: 3 };
    const a = createBotanicalInternal(tuning);
    const b = createBotanicalInternal(tuning);
    a.renderer.init(createWorld('c3.5-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    b.renderer.init(createWorld('c3.5-determinism-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.35 * Math.sin(i * 0.05), expansion: 0.6, symmetry: 0.3 });
    runTicks(a.renderer, 2500, 100, paramsAt);
    runTicks(b.renderer, 2500, 100, paramsAt);

    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

// --- Roadmap C3.5, Commit 2: the `density` tuning knob ---
// docs/HANDOFF.md Roadmap C / Session 026. `density` (default 0.5) maps to
// f = 2 ** ((density - 0.5) * 2) and is applied once at init() to
// forkCountMin/forkCountSpan (round(base*f)) and the already-mapped
// blossomsPerCluster (round(base*f)). Roadmap C1 rework: `trunkCount` is NOT
// density-scaled anymore (a small controlled number of trunks; density is
// lushness ALONG them). maxGeneration is left alone. density 0.5 -> f = 1 ->
// every effective value equals its base -> true no-op.
describe('createBotanicalStyle — density tuning knob (roadmap C3.5, Commit 2)', () => {
  const foregroundVolume = (state: ReturnType<typeof createBotanicalInternal>['state']) => {
    const fg = state.foregroundSystems[0]!;
    return {
      branches: fg.branches.length,
      forks: fg.branches.filter((b) => b.generation >= 1).length,
      blossoms: fg.blossoms.length,
      roots: fg.roots.length, // roadmap C1 rework: always === trunkCount, density-independent
    };
  };

  it('density = 0.5 is a true no-op: scene byte-identical to the Commit-1 default over a long run', () => {
    const explicit = createBotanicalInternal({ density: 0.5 });
    const def = createBotanicalInternal(); // DEFAULT_BOTANICAL_TUNING_CONFIG.density === 0.5
    explicit.renderer.init(createWorld('c3.5-density-noop-seed', 0, FAST_CYCLE_OVERRIDES));
    def.renderer.init(createWorld('c3.5-density-noop-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.35 * Math.sin(i * 0.03), expansion: 0.6, symmetry: 0.35 });
    runTicks(explicit.renderer, 2600, 100, paramsAt);
    runTicks(def.renderer, 2600, 100, paramsAt);

    expect(explicit.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(20); // sanity: a real run with many continuations
    expect(explicit.renderer.scene()).toEqual(def.renderer.scene());
    expect(explicit.renderer.sceneLayers?.()).toEqual(def.renderer.sceneLayers?.());
  });

  it('density = 1.0 yields measurably more branches / forks / blossoms than 0.5, and density = 0.0 measurably fewer, over the same run', () => {
    const paramsAt = (i: number) => makeParams({ speed: 0.7 + 0.2 * Math.sin(i * 0.03), expansion: 0.6, symmetry: 0.3 });
    const runAt = (density: number) => {
      const { renderer, state } = createBotanicalInternal({ density });
      renderer.init(createWorld('c3.5-density-scale-seed', 0, FAST_CYCLE_OVERRIDES));
      runTicks(renderer, 2600, 100, paramsAt);
      return foregroundVolume(state);
    };

    const lo = runAt(0.0);
    const mid = runAt(0.5);
    const hi = runAt(1.0);

    expect(hi.branches).toBeGreaterThan(mid.branches);
    expect(hi.forks).toBeGreaterThan(mid.forks);
    expect(hi.blossoms).toBeGreaterThan(mid.blossoms);

    expect(lo.branches).toBeLessThan(mid.branches);
    expect(lo.forks).toBeLessThan(mid.forks);
    expect(lo.blossoms).toBeLessThan(mid.blossoms);

    // Roadmap C1 rework: density does NOT change the trunk count.
    expect(lo.roots).toBe(mid.roots);
    expect(hi.roots).toBe(mid.roots);
  });

  it(
    'the foreground live set stays bounded with no upward drift over 60+ simulated seconds at density = 1.0 (Commit 1 split holds under max volume)',
    () => {
      const dt = 16.67;
      const TICKS = 3600; // 60 simulated seconds
      const SAMPLE_EVERY = 300;
      const { renderer, state } = createBotanicalInternal({ density: 1.0 });
      renderer.init(createWorld('c3.5-density-bound-seed', 0, FAST_CYCLE_OVERRIDES));

      const matureUnresolved = () => {
        let n = 0;
        for (const b of state.foregroundSystems[0]!.branches) if (b.lifecycle === 'mature' && !b.bakeResolved) n++;
        return n;
      };
      const unresolvedBlossoms = () => state.foregroundSystems[0]!.unresolvedBlossoms.length;

      const mature: number[] = [];
      const blossoms: number[] = [];
      let time = 0;
      for (let t = 0; t < TICKS; t++) {
        renderer.step({ v: 1, expansion: 0.6, speed: 0.7, symmetry: 0.4 }, INITIAL_SESSION_PARAMS, time, dt);
        time += dt;
        if ((t + 1) % SAMPLE_EVERY === 0) {
          mature.push(matureUnresolved());
          blossoms.push(unresolvedBlossoms());
        }
      }

      // The whole point of Commit 1: even with volume cranked to max, the
      // live set is still bounded and drains (does not accumulate).
      expect(Math.max(...mature)).toBeLessThan(200);
      expect(Math.max(...blossoms)).toBeLessThan(2000);
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const postWarmup = (xs: number[]) => xs.slice(2, 6);
      const lateThird = (xs: number[]) => xs.slice(-4);
      expect(avg(lateThird(mature))).toBeLessThanOrEqual(avg(postWarmup(mature)) * 2 + 15);
      expect(avg(lateThird(blossoms))).toBeLessThanOrEqual(avg(postWarmup(blossoms)) * 1.8 + 40);
    },
    60000,
  );

  it('is deterministic with density set to a non-default value: same seed + tuning, run twice, identical scene', () => {
    const a = createBotanicalInternal({ density: 0.82 });
    const b = createBotanicalInternal({ density: 0.82 });
    a.renderer.init(createWorld('c3.5-density-determinism-seed', 0, FAST_CYCLE_OVERRIDES));
    b.renderer.init(createWorld('c3.5-density-determinism-seed', 0, FAST_CYCLE_OVERRIDES));

    const paramsAt = (i: number) => makeParams({ speed: 0.5 + 0.35 * Math.sin(i * 0.05), expansion: 0.6, symmetry: 0.3 });
    runTicks(a.renderer, 2400, 100, paramsAt);
    runTicks(b.renderer, 2400, 100, paramsAt);

    expect(a.state.foregroundSystems[0]!.branches.length).toBeGreaterThan(20);
    expect(a.renderer.scene()).toEqual(b.renderer.scene());
  });
});

describe('createBotanicalStyle — latestMechanismSample ("Show the magic" plumbing, UX Stage 2)', () => {
  it('is null immediately after init(), before any step()', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('magic-seed', 0));
    expect(renderer.latestMechanismSample?.()).toBeNull();
  });

  it('after stepping, returns two entries with the specified labels, function names, module id, and arg keys', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('magic-seed', 0));
    runTicks(renderer, 5, 16.67, () => makeParams({ speed: 0.4, expansion: 0.7, symmetry: 0.2 }));

    const sample = renderer.latestMechanismSample?.();
    expect(sample).not.toBeNull();
    expect(sample!.functions).toHaveLength(2);

    const [growth, wander] = sample!.functions;
    expect(growth).toMatchObject({
      tabLabel: 'speed → growth',
      sourceFunctionName: 'growthStepFor',
      sourceModule: 'branch.ts',
    });
    expect(Object.keys(growth!.args).sort()).toEqual(['baseGrowthPerTick', 'dt', 'speed']);

    expect(wander).toMatchObject({
      tabLabel: 'expansion + symmetry → wander',
      sourceFunctionName: 'wanderDeltaFor',
      sourceModule: 'branch.ts',
    });
    expect(Object.keys(wander!.args).sort()).toEqual(
      [
        'currentDirection',
        'dt',
        'expansion',
        'noise01',
        'sweepTarget',
        'symmetry',
        'wanderAmplitudeBase',
        'windAngle',
      ].sort(),
    );
  });

  it('each entry’s result equals its pure branch.ts function re-invoked independently with the reported args', () => {
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('magic-seed-2', 0));
    runTicks(renderer, 8, 16.67, () => makeParams({ speed: 0.55, expansion: 0.33, symmetry: 0.66 }));

    const sample = renderer.latestMechanismSample?.();
    expect(sample).not.toBeNull();
    const growth = sample!.functions[0]!;
    const wander = sample!.functions[1]!;
    const g = growth.args;
    const w = wander.args;

    expect(growth.result).toBe(
      growthStepFor({
        dt: g.dt!,
        speed: g.speed!,
        baseGrowthPerTick: g.baseGrowthPerTick!,
        tuning: state.tuning,
      }),
    );
    expect(wander.result).toBe(
      wanderDeltaFor({
        noise01: w.noise01!,
        wanderAmplitudeBase: w.wanderAmplitudeBase!,
        symmetry: w.symmetry!,
        expansion: w.expansion!,
        dt: w.dt!,
        windAngle: w.windAngle!,
        currentDirection: w.currentDirection!,
        sweepTarget: w.sweepTarget!,
        tuning: state.tuning,
      }),
    );
  });

  it('captures from the newest growing generation-0 branch of the newest foreground system', () => {
    const { renderer, state } = createBotanicalInternal();
    renderer.init(createWorld('magic-seed-3', 0));
    runTicks(renderer, 3, 16.67, () => makeParams({ speed: 0.5, expansion: 0.5, symmetry: 0.5 }));

    const frontSystem = state.foregroundSystems[state.foregroundSystems.length - 1]!;
    const growingGen0 = frontSystem.branches.filter((b) => b.lifecycle === 'growing' && b.generation === 0);
    const representative = growingGen0[growingGen0.length - 1]!;

    const sample = renderer.latestMechanismSample?.();
    expect(sample).not.toBeNull();
    // sweepTarget is fixed at spawn and never mutated by tickGrowing, so it
    // uniquely fingerprints which branch the sample was taken from.
    expect(sample!.functions[1]!.args.sweepTarget).toBe(representative.sweepTarget);
  });

  it('retains the previous sample rather than nulling it once a sample has been captured', () => {
    const { renderer } = createBotanicalInternal();
    renderer.init(createWorld('magic-seed-4', 0));
    runTicks(renderer, 4, 16.67, () => makeParams({ speed: 0.5, expansion: 0.5, symmetry: 0.5 }));
    const first = renderer.latestMechanismSample!();
    expect(first).not.toBeNull();

    // Many more ticks: whatever the growth front looks like later, the getter
    // must still return a non-null sample.
    runTicks(renderer, 200, 16.67, () => makeParams({ speed: 0.6, expansion: 0.4, symmetry: 0.5 }));
    expect(renderer.latestMechanismSample!()).not.toBeNull();
  });

  it('a fresh init() resets the sample back to null', () => {
    const renderer = createBotanicalStyle();
    renderer.init(createWorld('magic-seed-5', 0));
    runTicks(renderer, 5, 16.67, () => makeParams());
    expect(renderer.latestMechanismSample?.()).not.toBeNull();

    renderer.init(createWorld('magic-seed-5', 0));
    expect(renderer.latestMechanismSample?.()).toBeNull();
  });
});
