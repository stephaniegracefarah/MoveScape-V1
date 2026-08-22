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
 */
import type { MovementParams, MovementSample } from '../adapters/movement-params';
import { renderPaperGround } from '../compositor/paper-ground';
import { renderScene, type CanvasLike, type CanvasSize } from '../compositor/render-scene';
import { recordSample } from '../engine/recording';
import { advanceTicks, SIMULATION_TICK_MS } from '../engine/replay';
import type { StyleRenderer } from '../styles/style-renderer';
import type { World } from '../world/world';

export interface LiveRenderLoop {
  /** Feed one new movement sample into the running session. */
  feed(params: MovementParams): void;
  /** Cancel the render loop. Does not touch the style, world, or canvas contents. */
  stop(): void;
}

export function createLiveRenderLoop(
  style: StyleRenderer,
  world: World,
  ctx: CanvasLike,
  canvasSize: CanvasSize,
  isPaused: () => boolean,
): LiveRenderLoop {
  style.init(world);

  const recording: MovementSample[] = [];
  let sessionElapsedMs = 0;
  let lastFrameTimestamp: number | null = null;
  let fromTick = 0;
  let fromSampleIndex = 0;
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
        fromSampleIndex = advanceTicks(style, recording, fromTick, toTick, fromSampleIndex);
        fromTick = toTick;
      }
    }

    renderPaperGround(ctx, canvasSize, world.worldSeed);
    renderScene(ctx, style.scene(), canvasSize);
    rafHandle = requestAnimationFrame(frame);
  }

  rafHandle = requestAnimationFrame(frame);

  return {
    feed,
    stop(): void {
      stopped = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    },
  };
}
