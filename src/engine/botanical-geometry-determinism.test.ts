/**
 * M4 acceptance criterion (mirrors geometry-determinism.test.ts, using the
 * real Botanical style instead of the M3 placeholder): replaying the
 * identical recipe (world seed + recording) produces bit-identical scene
 * geometry regardless of how the simulation ticks are batched. World
 * overrides force a fast growing->mature->shrinking->resprout cycle within a
 * reasonable test duration (see the constants below), so this test actually
 * exercises the full lifecycle, not just the growing phase.
 */
import { describe, expect, it } from 'vitest';
import type { MovementRecording } from './recording';
import { advanceTicks, replay, SIMULATION_TICK_MS } from './replay';
import { createBotanicalStyle } from '../styles/botanical/botanical';
import { createWorld, type WorldOverrides } from '../world/world';
import { cyrb53 } from '../shared/hash';

// speed=1 throughout so growth proceeds at the fastest honest rate; a few
// samples with varying expansion/symmetry so wander/spread are exercised too.
const RECORDING: MovementRecording = [
  { t: 0, params: { v: 1, expansion: 0.3, speed: 1, symmetry: 0.5 } },
  { t: 500, params: { v: 1, expansion: 0.6, speed: 1, symmetry: 0.3 } },
  { t: 2000, params: { v: 1, expansion: 0.2, speed: 1, symmetry: 0.8 } },
  { t: 5000, params: { v: 1, expansion: 0.8, speed: 1, symmetry: 0.2 } },
  { t: 9000, params: { v: 1, expansion: 0.5, speed: 1, symmetry: 0.5 } },
];

// baseGrowthRate=1 (raw) -> the fastest mapped growth rate; matureDurationMs=0
// (raw) -> the shortest mapped mature duration; rootCount=0 (raw) -> the
// fewest root points (keeps element count, and therefore this test's
// runtime, manageable while still covering a full lifecycle for several
// branches within DURATION_MS).
const FAST_LIFECYCLE_OVERRIDES: WorldOverrides = {
  baseGrowthRate: 1,
  matureDurationMs: 0,
  rootCount: 0,
};

const DURATION_MS = 15000;
const WORLD_SEED = 'botanical-determinism-test-seed';

describe('Botanical geometry determinism — same recipe, different tick batching', () => {
  it('produces an identical Scene whether replayed in one call or across uneven tick chunks', () => {
    const worldA = createWorld(WORLD_SEED, 0, FAST_LIFECYCLE_OVERRIDES);
    const styleA = createBotanicalStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const worldB = createWorld(WORLD_SEED, 0, FAST_LIFECYCLE_OVERRIDES);
    const styleB = createBotanicalStyle();
    styleB.init(worldB);

    const totalTicks = Math.ceil(DURATION_MS / SIMULATION_TICK_MS);
    let sampleIndex = advanceTicks(styleB, RECORDING, 0, 37, 0);
    sampleIndex = advanceTicks(styleB, RECORDING, 37, 211, sampleIndex);
    sampleIndex = advanceTicks(styleB, RECORDING, 211, 500, sampleIndex);
    advanceTicks(styleB, RECORDING, 500, totalTicks, sampleIndex);
    const sceneB = styleB.finish();

    expect(sceneB).toEqual(sceneA);
    expect(cyrb53(JSON.stringify(sceneB))).toBe(cyrb53(JSON.stringify(sceneA)));

    // Sanity: the fast-lifecycle overrides actually produced a non-trivial
    // scene (branches + at least one blossom cluster), not an empty one.
    expect(sceneA.elements.length).toBeGreaterThan(10);
  });

  it('sensitivity guard: a different world seed produces a different geometry hash', () => {
    const worldA = createWorld(WORLD_SEED, 0, FAST_LIFECYCLE_OVERRIDES);
    const styleA = createBotanicalStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const worldDifferent = createWorld('different-seed', 0, FAST_LIFECYCLE_OVERRIDES);
    const styleDifferent = createBotanicalStyle();
    const sceneDifferent = replay(styleDifferent, worldDifferent, RECORDING, DURATION_MS);

    expect(cyrb53(JSON.stringify(sceneDifferent))).not.toBe(cyrb53(JSON.stringify(sceneA)));
  });
});
