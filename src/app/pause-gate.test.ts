import { describe, expect, it } from 'vitest';
import { createPauseGate } from './pause-gate';
import { MOVEMENT_PARAMS_VERSION, type MovementParams } from '../adapters/movement-params';

function sample(expansion: number): MovementParams {
  return { v: MOVEMENT_PARAMS_VERSION, expansion, speed: 0, symmetry: 0 };
}

describe('createPauseGate', () => {
  it('forwards samples while not paused', () => {
    const received: MovementParams[] = [];
    const gate = createPauseGate((params) => received.push(params));

    gate.listener(sample(0.1), 0);
    gate.listener(sample(0.2), 10);

    expect(received).toHaveLength(2);
    expect(received[0]?.expansion).toBe(0.1);
    expect(received[1]?.expansion).toBe(0.2);
  });

  it('stops forwarding once paused', () => {
    const received: MovementParams[] = [];
    const gate = createPauseGate((params) => received.push(params));

    gate.listener(sample(0.1), 0);
    gate.pause();
    expect(gate.isPaused()).toBe(true);
    gate.listener(sample(0.2), 10);
    gate.listener(sample(0.3), 20);

    expect(received).toHaveLength(1);
    expect(received[0]?.expansion).toBe(0.1);
  });

  it('resumes forwarding after resume()', () => {
    const received: MovementParams[] = [];
    const gate = createPauseGate((params) => received.push(params));

    gate.pause();
    gate.listener(sample(0.1), 0);
    gate.resume();
    expect(gate.isPaused()).toBe(false);
    gate.listener(sample(0.2), 10);

    expect(received).toHaveLength(1);
    expect(received[0]?.expansion).toBe(0.2);
  });

  it('reset() clears paused state', () => {
    const received: MovementParams[] = [];
    const gate = createPauseGate((params) => received.push(params));

    gate.pause();
    gate.reset();
    expect(gate.isPaused()).toBe(false);
    gate.listener(sample(0.5), 0);

    expect(received).toHaveLength(1);
  });
});
