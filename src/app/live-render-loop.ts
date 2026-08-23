/**
 * The M4 live-preview harness: turns a running InputAdapter's params stream
 * into a rendered Botanical (or any StyleRenderer) session, on-screen, in
 * real time. This is the invariant-4-compliant "a live session is just a
 * replay of a recording being written in real time" unification — built now
 * because M4 needs it to demo, not a separate ad-hoc rAF hack. Proper
 * session start/end UI polish, save/export, and a style picker are M5's job;
 * this module deliberately stays minimal (feed params in, watch it render).
 *
 * Pause-awareness: `isPaused` is checked once per animation frame, and the
 * loop's own notion of elapsed time (`sessionElapsedMs`) simply stops
 * advancing while paused — ticks freeze along with it, so a paused session
 * doesn't keep quietly growing from stale held params.
 *
 * The Scroll (M5 Stage 2, spec Part 3 "Composition and canvas"): the canvas
 * has a fixed height and grows rightward as the piece grows. This module
 * owns that growth -- every frame, it asks the style for its current scene,
 * computes the canvas size needed to fit it (compositor/render-scene.ts's
 * computeCanvasSize), and calls the caller-supplied `resizeCanvas` before
 * painting. `resizeCanvas` is injected (rather than this module reaching
 * into a real HTMLCanvasElement directly) so it stays testable without a
 * DOM, the same reasoning `ctx: CanvasLike` already uses.
 */
import type { MovementParams, MovementSample } from '../adapters/movement-params';
import { renderPaperGround } from '../compositor/paper-ground';
import { computeCanvasSize, renderScene, type CanvasLike, type CanvasSize } from '../compositor/render-scene';
import { recordSample, type MovementRecording } from '../engine/recording';
import { advanceTicks, SIMULATION_TICK_MS } from '../engine/replay';
import { createSessionParamsAccumulator } from '../engine/session-params';
import type { StyleRenderer } from '../styles/style-renderer';
import type { World } from '../world/world';

export interface LiveRenderLoop {
  /** Feed one new movement sample into the running session. */
  feed(params: MovementParams): void;
  /** Cancel the render loop. Does not touch the style, world, or canvas contents. */
  stop(): void;
  /** The session's recording so far -- read by the caller at session end (M5) to build a PieceRecipe. Never mutated externally. */
  getRecording(): MovementRecording;
}

export function createLiveRenderLoop(
  style: StyleRenderer,
  world: World,
  ctx: CanvasLike,
  /** The canvas's fixed height in pixels -- also the world-to-pixel scale (render-scene.ts's worldUnitPx). Never changes for the life of a session. */
  fixedHeightPx: number,
  /** Called every frame with the size the canvas needs to be to fit the current scene, before painting. The caller applies it to the real canvas (e.g. setting canvas.width/height). */
  resizeCanvas: (size: CanvasSize) => void,
  isPaused: () => boolean,
): LiveRenderLoop {
  style.init(world);

  const recording: MovementSample[] = [];
  let sessionElapsedMs = 0;
  let lastFrameTimestamp: number | null = null;
  let fromTick = 0;
  let fromSampleIndex = 0;
  const accumulator = createSessionParamsAccumulator();
  let stopped = false;
  let rafHandle: number | null = null;

  function feed(params: MovementParams): void {
    const last = recording[recording.length - 1];
    if (last !== undefined && sessionElapsedMs <= last.t) {
      // Two samples landed at the same elapsed millisecond (adapter jitter) --
      // drop the later one rather than throwing; this only affects a live
      // capture's timestamp granularity, never a saved recording's replay.
      return;
    }
    recordSample(recording, sessionElapsedMs, params);
  }

  function frame(now: number): void {
    if (stopped) return;

    if (lastFrameTimestamp !== null && !isPaused()) {
      sessionElapsedMs += now - lastFrameTimestamp;
    }
    lastFrameTimestamp = now;

    if (recording.length > 0) {
      const toTick = Math.floor(sessionElapsedMs / SIMULATION_TICK_MS);
      if (toTick > fromTick) {
        fromSampleIndex = advanceTicks(style, recording, fromTick, toTick, fromSampleIndex, accumulator);
        fromTick = toTick;
      }
    }

    const scene = style.scene();
    const canvasSize = computeCanvasSize(scene, fixedHeightPx);
    resizeCanvas(canvasSize);
    renderPaperGround(ctx, canvasSize, world.worldSeed);
    renderScene(ctx, scene, canvasSize);
    rafHandle = requestAnimationFrame(frame);
  }

  rafHandle = requestAnimationFrame(frame);

  return {
    feed,
    stop(): void {
      stopped = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    },
    getRecording(): MovementRecording {
      return recording;
    },
  };
}
