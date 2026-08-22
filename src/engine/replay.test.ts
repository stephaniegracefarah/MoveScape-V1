import { describe, expect, it } from 'vitest';
import type { MovementParams, MovementSample } from '../adapters/movement-params';
import type { Scene, StyleRenderer } from '../styles/style-renderer';
import type { World } from '../world/world';
import { createWorld } from '../world/world';
import type { MovementRecording } from './recording';
import { advanceTicks, replay, SIMULATION_TICK_MS } from './replay';
import { createSessionParamsAccumulator, type SessionParams } from './session-params';

interface StepCall {
  params: MovementParams;
  sessionParams: SessionParams;
  time: number;
  dt: number;
}

/**
 * A minimal hand-written stub, not a real style -- the placeholder style is
 * being built by a different builder in parallel and won't exist when these
 * tests run. Records every step() call's args for exact-sequence assertions,
 * and tracks call order via a shared log so init/step/finish ordering can be
 * verified too.
 */
class StubStyle implements StyleRenderer {
  id = 'stub';
  name = 'Stub';
  aestheticFamily = 'organic' as const;
  steps: StepCall[] = [];
  calls: string[] = [];
  initWorld: World | undefined;

  worldKnobs(): string[] {
    return [];
  }

  init(world: World): void {
    this.calls.push('init');
    this.initWorld = world;
  }

  step(params: MovementParams, sessionParams: SessionParams, time: number, dt: number): void {
    this.calls.push('step');
    this.steps.push({ params, sessionParams, time, dt });
  }

  scene(): Scene {
    return { elements: [] };
  }

  finish(): Scene {
    this.calls.push('finish');
    return { elements: [] };
  }
}

function params(seed: number): MovementParams {
  return { v: 1, expansion: seed, speed: seed, symmetry: seed };
}

function sample(t: number, seed: number): MovementSample {
  return { t, params: params(seed) };
}

describe('advanceTicks — call count and args', () => {
  it('calls step exactly toTick - fromTick times, with time = tick * tickMs', () => {
    const recording: MovementRecording = [sample(0, 0)];
    const style = new StubStyle();

    advanceTicks(style, recording, 0, 5, 0, createSessionParamsAccumulator());

    expect(style.steps).toHaveLength(5);
    style.steps.forEach((call, i) => {
      expect(call.time).toBe(i * SIMULATION_TICK_MS);
    });
  });

  it('passes dt as exactly tickMs on every call, regardless of sample spacing', () => {
    const recording: MovementRecording = [sample(0, 0), sample(7, 1), sample(8, 2)];
    const style = new StubStyle();
    const tickMs = 16.5;

    advanceTicks(style, recording, 0, 10, 0, createSessionParamsAccumulator(), tickMs);

    for (const call of style.steps) {
      expect(call.dt).toBe(tickMs);
    }
  });

  it('uses sample-and-hold: each tick gets the most recent sample at or before its time', () => {
    const recording: MovementRecording = [sample(0, 0), sample(20, 1), sample(40, 2)];
    const style = new StubStyle();
    const tickMs = 10;

    // Ticks land at t = 0, 10, 20, 30, 40 -> sample indices 0, 0, 1, 1, 2.
    advanceTicks(style, recording, 0, 5, 0, createSessionParamsAccumulator(), tickMs);

    expect(style.steps.map((c) => c.params.expansion)).toEqual([0, 0, 1, 1, 2]);
  });
});

describe('advanceTicks — chunking invariance', () => {
  it('one big range and two consecutive smaller ranges produce the identical step() sequence', () => {
    const recording: MovementRecording = [sample(0, 0), sample(25, 1), sample(60, 2)];
    const tickMs = 10;

    const whole = new StubStyle();
    advanceTicks(whole, recording, 0, 10, 0, createSessionParamsAccumulator(), tickMs);

    const chunked = new StubStyle();
    const chunkedAccumulator = createSessionParamsAccumulator();
    const midIndex = advanceTicks(chunked, recording, 0, 4, 0, chunkedAccumulator, tickMs);
    advanceTicks(chunked, recording, 4, 10, midIndex, chunkedAccumulator, tickMs);

    expect(chunked.steps).toEqual(whole.steps);
  });

  it('the returned sample index matches between whole and chunked runs', () => {
    const recording: MovementRecording = [sample(0, 0), sample(25, 1), sample(60, 2)];
    const tickMs = 10;

    const wholeFinal = advanceTicks(new StubStyle(), recording, 0, 10, 0, createSessionParamsAccumulator(), tickMs);

    const chunked = new StubStyle();
    const chunkedAccumulator = createSessionParamsAccumulator();
    const midIndex = advanceTicks(chunked, recording, 0, 4, 0, chunkedAccumulator, tickMs);
    const chunkedFinal = advanceTicks(chunked, recording, 4, 10, midIndex, chunkedAccumulator, tickMs);

    expect(chunkedFinal).toBe(wholeFinal);
  });
});

describe('replay — orchestration', () => {
  it('calls init once, step the expected number of times, and finish once, in that order', () => {
    const recording: MovementRecording = [sample(0, 0), sample(10, 1)];
    const style = new StubStyle();
    const world = createWorld('worldSeed-1', 0);
    const tickMs = 10;
    const durationMs = 55;

    const scene = replay(style, world, recording, durationMs, tickMs);

    expect(style.calls[0]).toBe('init');
    expect(style.calls[style.calls.length - 1]).toBe('finish');
    expect(style.calls.filter((c) => c === 'step')).toHaveLength(
      Math.ceil(durationMs / tickMs),
    );
    expect(style.initWorld).toBe(world);
    expect(scene).toEqual({ elements: [] });
  });
});
