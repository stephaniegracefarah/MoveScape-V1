/**
 * SCRATCH, NOT COMMITTED (delete after use) -- Task 2 measurement per the
 * session brief: measure live-circle (and live-stroke) counts over long
 * simulated sessions to see whether they plateau or grow unbounded. Drives
 * the REAL createBotanicalStyle() + REAL LiveCompositor every tick, at
 * DEFAULT tuning, constant moderate movement params (expansion 0.5, speed
 * 0.4, symmetry 0.6 -- per the brief, "constant is fine"). Samples counts
 * every 30 simulated seconds via the onDebug hook (only invoked on sample
 * ticks, to avoid its bookkeeping overhead on every one of ~18000 ticks).
 *
 * Run one seed per process (multi-thousand-tick canvas runs crash vitest
 * workers when bundled together -- see docs/HANDOFF.md dev-machine notes):
 *
 *   $env:SCRATCH_SEED='live-circle-1'; npx vitest run src/compositor/live-circle-measurement.scratch.test.ts
 */
import { describe, it } from 'vitest';
import { SIMULATION_TICK_MS } from '../engine/replay';
import { createSessionParamsAccumulator } from '../engine/session-params';
import { createLiveCompositor, type LiveCompositorDebugFrameInfo } from './live-compositor';
import { createNodeCanvasBufferFactory } from './render-divergence-harness';
import { computeCanvasSize } from './render-scene';
import { createBotanicalStyle } from '../styles/botanical/botanical';
import { createWorld } from '../world/world';

declare const process: { env: Record<string, string | undefined> };

const SEED = process.env.SCRATCH_SEED ?? 'live-circle-default';
const TICKS_PER_SECOND = Math.round(1000 / SIMULATION_TICK_MS);
const TOTAL_SECONDS = 300; // 5 simulated minutes
const TOTAL_TICKS = TOTAL_SECONDS * TICKS_PER_SECOND;
const SAMPLE_INTERVAL_TICKS = 30 * TICKS_PER_SECOND; // every 30 simulated seconds
const FIXED_HEIGHT_PX = 240;

describe(`live-circle measurement (scratch, seed=${SEED})`, () => {
  it(
    'samples live circle/stroke counts every 30s over a 5-minute session',
    () => {
      const world = createWorld(SEED, 0);
      const renderer = createBotanicalStyle(); // DEFAULT tuning
      renderer.init(world);

      const bufferFactory = createNodeCanvasBufferFactory();
      const compositor = createLiveCompositor(bufferFactory);
      const accumulator = createSessionParamsAccumulator();

      const sceneLayersFn = renderer.sceneLayers;
      if (!sceneLayersFn) throw new Error('expected botanical to implement sceneLayers()');

      const params = { v: 1 as const, expansion: 0.5, speed: 0.4, symmetry: 0.6 };

      const rows: {
        t: number;
        liveCircles: number;
        liveStrokes: number;
        totalCircles: number;
        totalStrokes: number;
        canvasWidthPx: number;
      }[] = [];

      let canvas: { width: number; height: number } = { width: FIXED_HEIGHT_PX, height: FIXED_HEIGHT_PX };

      // A SINGLE persistent destination buffer, grown in place via growTo()
      // exactly like main.ts's real resizeCanvas does -- NOT recreated every
      // tick. An earlier version of this script called
      // bufferFactory.create(canvasSize) fresh every one of 18000 ticks,
      // which crashed the vitest worker at ~660s (a real, measured finding,
      // not a guess): allocating a brand-new native @napi-rs/canvas Canvas
      // every tick for 5 simulated minutes exhausts native handles/memory
      // well before a real session (which reuses one <canvas> element) ever
      // would. Reusing one buffer matches the real app's own behavior and
      // fixes the crash.
      let destBuffer = bufferFactory.create(canvas);
      let destBufferSize = canvas;

      for (let tick = 0; tick < TOTAL_TICKS; tick++) {
        const time = tick * SIMULATION_TICK_MS;
        accumulator.update(params.speed, time);
        renderer.step(params, accumulator.current(), time, SIMULATION_TICK_MS);

        const layers = sceneLayersFn();
        const canvasSize = computeCanvasSize({ elements: layers.flatMap((l) => l.elements) }, FIXED_HEIGHT_PX);
        canvas = canvasSize;
        if (canvasSize.width > destBufferSize.width || canvasSize.height > destBufferSize.height) {
          destBuffer.growTo(canvasSize);
          destBufferSize = canvasSize;
        }
        const dest = destBuffer;

        const isSample = (tick + 1) % SAMPLE_INTERVAL_TICKS === 0;

        if (!isSample) {
          compositor.renderFrame(layers, dest.ctx, canvasSize, world.worldSeed);
          continue;
        }

        let debugInfo: LiveCompositorDebugFrameInfo | undefined;
        compositor.renderFrame(layers, dest.ctx, canvasSize, world.worldSeed, (info) => {
          debugInfo = info;
        });

        const debugByLayer = new Map(debugInfo!.layers.map((l) => [l.layerId, l]));
        let liveCircles = 0;
        let liveStrokes = 0;
        let totalCircles = 0;
        let totalStrokes = 0;
        for (const layer of layers) {
          const layerCircles = layer.elements.filter((e) => e.kind === 'circle').length;
          const layerStrokes = layer.elements.filter((e) => e.kind === 'stroke').length;
          totalCircles += layerCircles;
          totalStrokes += layerStrokes;
          const d = debugByLayer.get(layer.layerId);
          const circlesBaked = d?.circlesBaked ?? 0;
          const bakedStrokes = d?.bakedStrokeIndices.length ?? 0;
          liveCircles += Math.max(0, layerCircles - circlesBaked);
          liveStrokes += Math.max(0, layerStrokes - bakedStrokes);
        }

        rows.push({
          t: (tick + 1) / TICKS_PER_SECOND,
          liveCircles,
          liveStrokes,
          totalCircles,
          totalStrokes,
          canvasWidthPx: canvasSize.width,
        });
      }

      // eslint-disable-next-line no-console
      console.log(`\n=== SEED ${SEED} (canvas ${canvas.width}x${canvas.height} at end) ===`);
      // eslint-disable-next-line no-console
      console.log('t(s)\tliveCircles\tliveStrokes\ttotalCircles\ttotalStrokes\tcanvasWidthPx');
      for (const row of rows) {
        // eslint-disable-next-line no-console
        console.log(
          `${row.t}\t${row.liveCircles}\t${row.liveStrokes}\t${row.totalCircles}\t${row.totalStrokes}\t${row.canvasWidthPx}`,
        );
      }
    },
    600000,
  );
});
