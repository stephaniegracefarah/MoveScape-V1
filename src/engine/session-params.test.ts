import { describe, expect, it } from 'vitest';
import {
  createSessionParamsAccumulator,
  INITIAL_SESSION_PARAMS,
  STILLNESS_SPEED_THRESHOLD,
} from './session-params';

describe('createSessionParamsAccumulator — before any update()', () => {
  it('current() returns exactly INITIAL_SESSION_PARAMS on a freshly-created accumulator', () => {
    const accumulator = createSessionParamsAccumulator();
    expect(accumulator.current()).toEqual(INITIAL_SESSION_PARAMS);
  });
});

describe('createSessionParamsAccumulator — averageEnergy / movementVariance', () => {
  it('matches the hand-computed arithmetic mean and population variance of a known speed sequence', () => {
    const speeds = [0.2, 0.4, 0.6, 0.8, 1.0];
    const accumulator = createSessionParamsAccumulator();
    speeds.forEach((speed, i) => accumulator.update(speed, i * 16.67));

    const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
    const variance = speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length;

    const { averageEnergy, movementVariance } = accumulator.current();
    expect(averageEnergy).toBeCloseTo(mean, 10);
    expect(movementVariance).toBeCloseTo(variance, 10);
  });

  it('a single sample has averageEnergy equal to that sample and zero variance', () => {
    const accumulator = createSessionParamsAccumulator();
    accumulator.update(0.37, 100);

    const { averageEnergy, movementVariance } = accumulator.current();
    expect(averageEnergy).toBeCloseTo(0.37, 10);
    expect(movementVariance).toBe(0);
  });
});

describe('createSessionParamsAccumulator — stillnessRatio', () => {
  it('reflects the fraction of ticks below STILLNESS_SPEED_THRESHOLD in a mixed sequence', () => {
    // 2 of 5 speeds are below the 0.05 dead-zone threshold.
    const speeds = [0.01, 0.5, 0.03, 0.9, 0.2];
    const accumulator = createSessionParamsAccumulator();
    speeds.forEach((speed, i) => accumulator.update(speed, i * 16.67));

    expect(accumulator.current().stillnessRatio).toBeCloseTo(2 / 5, 10);
  });

  it('a speed exactly at the threshold does not count as still (strictly-below comparison)', () => {
    const accumulator = createSessionParamsAccumulator();
    accumulator.update(STILLNESS_SPEED_THRESHOLD, 16.67);
    accumulator.update(1, 33.33);

    expect(accumulator.current().stillnessRatio).toBe(0);
  });

  it('all-still and all-moving sequences produce stillnessRatio 1 and 0 respectively', () => {
    const allStill = createSessionParamsAccumulator();
    [0.0, 0.01, 0.02].forEach((speed, i) => allStill.update(speed, i * 16.67));
    expect(allStill.current().stillnessRatio).toBe(1);

    const allMoving = createSessionParamsAccumulator();
    [0.5, 0.6, 0.7].forEach((speed, i) => allMoving.update(speed, i * 16.67));
    expect(allMoving.current().stillnessRatio).toBe(0);
  });
});

describe('createSessionParamsAccumulator — duration', () => {
  it('reflects the last elapsedMs passed to update(), not a sum or a tick count', () => {
    const accumulator = createSessionParamsAccumulator();
    accumulator.update(0.5, 16.67);
    accumulator.update(0.5, 33.34);
    accumulator.update(0.5, 5000);

    expect(accumulator.current().duration).toBe(5000);
  });
});

describe('createSessionParamsAccumulator — current() is a cheap pure read', () => {
  it('calling current() repeatedly without an intervening update() does not change the result', () => {
    const accumulator = createSessionParamsAccumulator();
    accumulator.update(0.4, 100);
    accumulator.update(0.6, 200);

    const first = accumulator.current();
    const second = accumulator.current();
    const third = accumulator.current();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
