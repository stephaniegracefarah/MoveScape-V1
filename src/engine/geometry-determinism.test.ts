/**
 * M3 acceptance criterion: replaying the identical recipe (world seed +
 * recording) produces bit-identical scene geometry regardless of how the
 * simulation ticks are batched -- invariant 3's "same recipe yields an
 * identical geometry hash", exercised with "different render frame rates"
 * operationalized as different tick-batching granularity (invariant 4: the
 * simulation itself is wall-clock-independent, so only the batching should
 * vary between runs, never the simulation).
 */
import { describe, expect, it } from 'vitest';
import type { MovementRecording } from './recording';
import { advanceTicks, replay, SIMULATION_TICK_MS } from './replay';
import { createSessionParamsAccumulator } from './session-params';
import { createDriftingCirclesStyle } from '../styles/placeholder/drifting-circles';
import { createWorld } from '../world/world';
import { cyrb53 } from '../shared/hash';

// A small, hand-written fixture -- explicit t/params values, not randomly
// generated, so the fixture itself is obviously deterministic and readable.
// Comfortably covers several ticks past the last sample within durationMs.
const RECORDING: MovementRecording = [
  { t: 0, params: { v: 1, expansion: 0.2, speed: 0.5, symmetry: 0.8 } },
  { t: 50, params: { v: 1, expansion: 0.35, speed: 0.6, symmetry: 0.75 } },
  { t: 120, params: { v: 1, expansion: 0.5, speed: 0.4, symmetry: 0.9 } },
  { t: 200, params: { v: 1, expansion: 0.65, speed: 0.7, symmetry: 0.6 } },
  { t: 280, params: { v: 1, expansion: 0.3, speed: 0.55, symmetry: 0.85 } },
  { t: 350, params: { v: 1, expansion: 0.45, speed: 0.65, symmetry: 0.7 } },
  { t: 420, params: { v: 1, expansion: 0.2, speed: 0.5, symmetry: 0.95 } },
];

const DURATION_MS = 500;
const WORLD_SEED = 'determinism-test-seed';

describe('geometry determinism — same recipe, different tick batching', () => {
  it('produces an identical Scene whether replayed in one call or across uneven tick chunks', () => {
    // Run A: the replay() convenience function, one call, ticks 0..N straight
    // through -- this is what "runs at one frame rate" looks like.
    const worldA = createWorld(WORLD_SEED, 0);
    const styleA = createDriftingCirclesStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    // Run B: a fresh style/world, pumped forward via advanceTicks in uneven
    // chunks that don't evenly divide the total tick count -- this is what
    // "runs at a different frame rate" looks like, per invariant 4: only the
    // batching of ticks varies, never the simulation itself.
    const worldB = createWorld(WORLD_SEED, 0);
    const styleB = createDriftingCirclesStyle();
    styleB.init(worldB);

    const totalTicks = Math.ceil(DURATION_MS / SIMULATION_TICK_MS);
    const accumulator = createSessionParamsAccumulator();
    let sampleIndex = advanceTicks(styleB, RECORDING, 0, 7, 0, accumulator);
    sampleIndex = advanceTicks(styleB, RECORDING, 7, 13, sampleIndex, accumulator);
    sampleIndex = advanceTicks(styleB, RECORDING, 13, 22, sampleIndex, accumulator);
    advanceTicks(styleB, RECORDING, 22, totalTicks, sampleIndex, accumulator);
    const sceneB = styleB.finish();

    expect(sceneB).toEqual(sceneA);
    expect(cyrb53(JSON.stringify(sceneB))).toBe(cyrb53(JSON.stringify(sceneA)));
  });

  it('sensitivity guard: a different world seed produces a different geometry hash', () => {
    const worldA = createWorld(WORLD_SEED, 0);
    const styleA = createDriftingCirclesStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const worldDifferent = createWorld('different-seed', 0);
    const styleDifferent = createDriftingCirclesStyle();
    const sceneDifferent = replay(styleDifferent, worldDifferent, RECORDING, DURATION_MS);

    expect(cyrb53(JSON.stringify(sceneDifferent))).not.toBe(cyrb53(JSON.stringify(sceneA)));
  });
});
