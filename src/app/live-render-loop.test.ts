import { describe, expect, it, vi } from 'vitest';
import type { MovementParams } from '../adapters/movement-params';
import type { OffscreenBuffer, OffscreenBufferFactory } from '../compositor/live-compositor';
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
    step: (_params, _sessionParams, time) => {
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

/**
 * A buffer factory that throws if `create` is ever called -- every style
 * used in this file omits `sceneLayers`, so the live render loop must never
 * touch the buffer factory at all (it should stay on the plain full-redraw
 * path). Using a throwing stub (rather than a working fake) turns "the loop
 * incorrectly went down the incremental path" into an immediate test
 * failure instead of a silent pass.
 */
function createUnusedBufferFactory(): OffscreenBufferFactory {
  return {
    create(): OffscreenBuffer {
      throw new Error('bufferFactory.create() should never be called for a style without sceneLayers');
    },
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
    const loop = createLiveRenderLoop(
      style,
      createStubWorld(),
      createStubCanvas(),
      10,
      () => {},
      () => false,
      createUnusedBufferFactory(),
    );

    // First frame establishes lastFrameTimestamp with no elapsed delta yet.
    raf.fireNextFrame(0);
    loop.feed(PARAMS);
    // A second feed with no frame in between has the same sessionElapsedMs (0) --
    // must be dropped, not thrown.
    expect(() => loop.feed(PARAMS)).not.toThrow();

    loop.stop();
  });
});

describe('createLiveRenderLoop — the Scroll: dynamic canvas resizing', () => {
  it('calls resizeCanvas every frame with a size that fits the style\'s current scene at the fixed height', () => {
    const raf = stubRaf();
    const resizeCalls: { width: number; height: number }[] = [];
    const style: StyleRenderer = {
      id: 'stub',
      name: 'Stub',
      aestheticFamily: 'organic',
      worldKnobs: () => [],
      init: () => {},
      step: () => {},
      scene: (): Scene => ({
        elements: [{ kind: 'circle', z: 0, x: 2, y: 0.5, radius: 0.1, color: 'red', opacity: 1 }],
      }),
      finish: (): Scene => ({ elements: [] }),
    };
    const loop = createLiveRenderLoop(
      style,
      createStubWorld(),
      createStubCanvas(),
      100,
      (size) => resizeCalls.push(size),
      () => false,
      createUnusedBufferFactory(),
    );

    raf.fireNextFrame(0);

    expect(resizeCalls).toHaveLength(1);
    // height is always the fixed 100; width fits x=2 + radius=0.1 + the
    // 0.3-world-unit padding computeCanvasSize adds, i.e. (2.1 + 0.3) * 100.
    expect(resizeCalls[0]).toEqual({ width: 240, height: 100 });

    loop.stop();
  });
});

describe('createLiveRenderLoop — sceneLayers wiring', () => {
  it('a style with sceneLayers renders via the LiveCompositor (bufferFactory.create gets called), still resizing the canvas correctly', () => {
    const raf = stubRaf();
    const resizeCalls: { width: number; height: number }[] = [];
    const style: StyleRenderer = {
      id: 'stub-incremental',
      name: 'Stub Incremental',
      aestheticFamily: 'organic',
      worldKnobs: () => [],
      init: () => {},
      step: () => {},
      scene: (): Scene => ({ elements: [] }),
      finish: (): Scene => ({ elements: [] }),
      sceneLayers: () => [
        {
          layerId: 'fg0',
          elements: [{ kind: 'circle', z: 0, x: 1, y: 0.5, radius: 0.1, color: 'red', opacity: 1 }],
        },
      ],
    };

    let createCalls = 0;
    const bufferFactory: OffscreenBufferFactory = {
      create(): OffscreenBuffer {
        createCalls++;
        return {
          ctx: createStubCanvas(),
          blitTo: () => {},
          growTo: () => {},
        };
      },
    };

    const loop = createLiveRenderLoop(
      style,
      createStubWorld(),
      createStubCanvas(),
      100,
      (size) => resizeCalls.push(size),
      () => false,
      bufferFactory,
    );

    raf.fireNextFrame(0);

    expect(createCalls).toBeGreaterThan(0); // the compositor path was actually taken
    expect(resizeCalls).toHaveLength(1);
    // Sized from sceneLayers' own elements (x=1 + radius=0.1 + 0.3 padding) * height(100).
    expect(resizeCalls[0]).toEqual({ width: 140, height: 100 });

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
      10,
      () => {},
      () => paused,
      createUnusedBufferFactory(),
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
