/**
 * M4 acceptance criterion (mirrors pixel-determinism.test.ts, using the real
 * Botanical style instead of the M3 placeholder): replaying the identical
 * recipe and compositing it through the real renderScene() produces
 * bit-identical pixels, not just bit-identical geometry.
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { CanvasLike, CanvasSize } from '../compositor/render-scene';
import { renderScene } from '../compositor/render-scene';
import { cyrb53Bytes } from '../shared/hash';
import type { MovementRecording } from './recording';
import { advanceTicks, replay, SIMULATION_TICK_MS } from './replay';
import { createBotanicalStyle } from '../styles/botanical/botanical';
import type { Scene } from '../styles/style-renderer';
import { createWorld, type WorldOverrides } from '../world/world';

// Same self-contained fixture pattern as botanical-geometry-determinism.test.ts.
const RECORDING: MovementRecording = [
  { t: 0, params: { v: 1, expansion: 0.3, speed: 1, symmetry: 0.5 } },
  { t: 500, params: { v: 1, expansion: 0.6, speed: 1, symmetry: 0.3 } },
  { t: 2000, params: { v: 1, expansion: 0.2, speed: 1, symmetry: 0.8 } },
  { t: 5000, params: { v: 1, expansion: 0.8, speed: 1, symmetry: 0.2 } },
  { t: 9000, params: { v: 1, expansion: 0.5, speed: 1, symmetry: 0.5 } },
];

const FAST_LIFECYCLE_OVERRIDES: WorldOverrides = {
  baseGrowthRate: 1,
  matureDurationMs: 0,
  rootCount: 0,
};

const DURATION_MS = 15000;
const WORLD_SEED = 'botanical-determinism-test-seed';
const CANVAS_SIZE: CanvasSize = { width: 200, height: 200 };

function renderToPixelHash(scene: Scene): number {
  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext('2d');
  renderScene(ctx as unknown as CanvasLike, scene, CANVAS_SIZE);
  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  return cyrb53Bytes(imageData.data);
}

function replayChunked(worldSeed: string): Scene {
  const world = createWorld(worldSeed, 0, FAST_LIFECYCLE_OVERRIDES);
  const style = createBotanicalStyle();
  style.init(world);

  const totalTicks = Math.ceil(DURATION_MS / SIMULATION_TICK_MS);
  let sampleIndex = advanceTicks(style, RECORDING, 0, 37, 0);
  sampleIndex = advanceTicks(style, RECORDING, 37, 211, sampleIndex);
  sampleIndex = advanceTicks(style, RECORDING, 211, 500, sampleIndex);
  advanceTicks(style, RECORDING, 500, totalTicks, sampleIndex);
  return style.finish();
}

describe('Botanical pixel determinism — same recipe, different tick batching', () => {
  it('renders identical pixels whether replayed in one call or across uneven tick chunks', () => {
    const worldA = createWorld(WORLD_SEED, 0, FAST_LIFECYCLE_OVERRIDES);
    const styleA = createBotanicalStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const sceneB = replayChunked(WORLD_SEED);

    const hashA = renderToPixelHash(sceneA);
    const hashB = renderToPixelHash(sceneB);

    expect(hashB).toBe(hashA);
  });

  it('sensitivity guard: a different world seed produces a different pixel hash', () => {
    const worldA = createWorld(WORLD_SEED, 0, FAST_LIFECYCLE_OVERRIDES);
    const styleA = createBotanicalStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const worldDifferent = createWorld('different-seed', 0, FAST_LIFECYCLE_OVERRIDES);
    const styleDifferent = createBotanicalStyle();
    const sceneDifferent = replay(styleDifferent, worldDifferent, RECORDING, DURATION_MS);

    const hashA = renderToPixelHash(sceneA);
    const hashDifferent = renderToPixelHash(sceneDifferent);

    expect(hashDifferent).not.toBe(hashA);
  });
});
