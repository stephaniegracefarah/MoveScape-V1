/**
 * M3 acceptance criterion: replaying the identical recipe and compositing it
 * through the real renderScene() produces bit-identical pixels, not just
 * bit-identical geometry -- closes the gap between "the Scene objects are
 * equal" (geometry-determinism.test.ts) and "what actually lands on the
 * canvas is equal". Uses @napi-rs/canvas so pixel rendering is testable in
 * plain-Node Vitest; that package is a devDependency imported only from
 * this test file, never from src/compositor/ or src/styles/ production code.
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { CanvasLike, CanvasSize } from '../compositor/render-scene';
import { renderScene } from '../compositor/render-scene';
import { cyrb53Bytes } from '../shared/hash';
import type { MovementRecording } from './recording';
import { advanceTicks, replay, SIMULATION_TICK_MS } from './replay';
import { createSessionParamsAccumulator } from './session-params';
import { createDriftingCirclesStyle } from '../styles/placeholder/drifting-circles';
import type { Scene } from '../styles/style-renderer';
import { createWorld } from '../world/world';

// Same self-contained fixture pattern as geometry-determinism.test.ts --
// duplicated rather than shared, matching this repo's convention of
// self-contained test files.
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
const CANVAS_SIZE: CanvasSize = { width: 200, height: 200 };

/**
 * Renders `scene` via the real compositor and returns a hash of the
 * resulting pixel buffer. @napi-rs/canvas's 2D context structurally
 * satisfies CanvasLike (same fillStyle/globalAlpha/clearRect/beginPath/
 * arc/fill surface) except that its `fillStyle` is typed as
 * `string | CanvasGradient | CanvasPattern` rather than a bare `string`, so
 * a local cast is needed here -- render-scene.ts's CanvasLike interface is
 * not touched to accommodate this.
 */
function renderToPixelHash(scene: Scene): number {
  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext('2d');
  renderScene(ctx as unknown as CanvasLike, scene, CANVAS_SIZE);
  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  return cyrb53Bytes(imageData.data);
}

function replayChunked(worldSeed: string): Scene {
  const world = createWorld(worldSeed, 0);
  const style = createDriftingCirclesStyle();
  style.init(world);

  const totalTicks = Math.ceil(DURATION_MS / SIMULATION_TICK_MS);
  const accumulator = createSessionParamsAccumulator();
  let sampleIndex = advanceTicks(style, RECORDING, 0, 7, 0, accumulator);
  sampleIndex = advanceTicks(style, RECORDING, 7, 13, sampleIndex, accumulator);
  sampleIndex = advanceTicks(style, RECORDING, 13, 22, sampleIndex, accumulator);
  advanceTicks(style, RECORDING, 22, totalTicks, sampleIndex, accumulator);
  return style.finish();
}

describe('pixel determinism — same recipe, different tick batching', () => {
  it('renders identical pixels whether replayed in one call or across uneven tick chunks', () => {
    const worldA = createWorld(WORLD_SEED, 0);
    const styleA = createDriftingCirclesStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const sceneB = replayChunked(WORLD_SEED);

    const hashA = renderToPixelHash(sceneA);
    const hashB = renderToPixelHash(sceneB);

    expect(hashB).toBe(hashA);
  });

  it('sensitivity guard: a different world seed produces a different pixel hash', () => {
    const worldA = createWorld(WORLD_SEED, 0);
    const styleA = createDriftingCirclesStyle();
    const sceneA = replay(styleA, worldA, RECORDING, DURATION_MS);

    const worldDifferent = createWorld('different-seed', 0);
    const styleDifferent = createDriftingCirclesStyle();
    const sceneDifferent = replay(styleDifferent, worldDifferent, RECORDING, DURATION_MS);

    const hashA = renderToPixelHash(sceneA);
    const hashDifferent = renderToPixelHash(sceneDifferent);

    expect(hashDifferent).not.toBe(hashA);
  });
});
