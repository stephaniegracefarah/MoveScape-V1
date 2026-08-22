import { describe, expect, it, vi } from 'vitest';
import type { MovementParams } from '../adapters/movement-params';
import type { CanvasLike } from '../compositor/render-scene';
import { SIMULATION_TICK_MS } from '../engine/replay';
import type { Scene, StyleRenderer } from '../styles/style-renderer';
import type { World } from '../world/world';
import { createLiveRenderLoop } from './live-render-loop';

const PARAMS: MovementParams = { v: 1, expansion: 0.5, speed: 0.5, symmetry: 0.5 };

function createStubWorld(): World {
  return { worldSeed: 'seed', sessionSeed: 'seed::0', sessionIndex: 0, knob: () => 0.5 };
}

function createStubStyle(): { style: StyleRenderer; stepCalls: number[] } {
  const stepCalls: number[] = [];
  const style: StyleRenderer = {
    id: 'stub',
    name: 'Stub',
    aestheticFamily: 'organic',
    worldKnobs: () => [],
    init: () => {},
    step: (_params, time) => {
      stepCalls.push(time);
    },
    scene: (): Scene => ({ elements: [] }),
    finish: (): Scene => ({ elements: [] }),
  };
  return { style, stepCalls };
}

function createStubCanvas(): CanvasLike {
  return {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {},
    stroke: () => {},
  };
}

/** Stubs requestAnimationFrame/cancelAnimationFrame so a test can drive frames manually by calling the captured callback with a chosen timestamp. */
function stubRaf(): { fireNextFrame: (now: number) => void; cancelled: boolean } {
  let pendingCallback: ((now: number) => void) | null = null;
  const state = { cancelled: false };

  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    pendingCallback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    state.cancelled = true;
  });

  function fireNextFrame(now: number): void {
    const cb = pendingCallback;
    pendingCallback = null;
    cb?.(now);
  }

  return { fireNextFrame, get cancelled() { return state.cancelled; } };
}

describe('createLiveRenderLoop — feed', () => {
  it('drops a sample whose elapsed time does not exceed the last recorded sample', () => {
    const raf = stubRaf();
    const { style } = createStubStyle();
    const loop = createLiveRenderLoop(style, createStubWorld(), createStubCanvas(), { width: 10, height: 10 }, () => false);

    // First frame establishes lastFrameTimestamp with no elapsed delta yet.
    raf.fireNextFrame(0);
    loop.feed(PARAMS);
    // A second feed with no frame in between has the same sessionElapsedMs (0) --
    // must be dropped, not thrown.
    expect(() => loop.feed(PARAMS)).not.toThrow();

    loop.stop();
  });
});

describe('createLiveRenderLoop — pause freezes tick advancement', () => {
  it('does not advance ticks while isPaused() is true, even as animation frames keep firing', () => {
    const raf = stubRaf();
    const { style, stepCalls } = createStubStyle();
    let paused = false;
    const loop = createLiveRenderLoop(
      style,
      createStubWorld(),
      createStubCanvas(),
      { width: 10, height: 10 },
      () => paused,
    );

    raf.fireNextFrame(0);
    loop.feed(PARAMS);

    // Advance past several tick boundaries while unpaused -- ticks should fire.
    raf.fireNextFrame(SIMULATION_TICK_MS * 5);
    const callsAfterUnpaused = stepCalls.length;
    expect(callsAfterUnpaused).toBeGreaterThan(0);

    // Pause, then advance wall-clock time further -- no new ticks should fire,
    // since sessionElapsedMs must not advance while paused.
    paused = true;
    raf.fireNextFrame(SIMULATION_TICK_MS * 50);
    expect(stepCalls.length).toBe(callsAfterUnpaused);

    loop.stop();
    expect(raf.cancelled).toBe(true);
  });
});
