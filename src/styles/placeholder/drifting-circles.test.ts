import { describe, expect, it } from 'vitest';
import type { MovementParams } from '../../adapters/movement-params';
import { createWorld } from '../../world/world';
import { createDriftingCirclesStyle } from './drifting-circles';

function makeParams(overrides: Partial<MovementParams> = {}): MovementParams {
  return { v: 1, expansion: 0.5, speed: 0.5, symmetry: 0.5, ...overrides };
}

// A representative sequence of (params, time, dt) calls, shared across
// determinism tests so both instances see the exact same driving sequence.
function runSequence(style: ReturnType<typeof createDriftingCirclesStyle>, params: MovementParams): void {
  style.step(params, 0, 16);
  style.step(params, 16, 16);
  style.step(params, 32.5, 16.5);
  style.step(params, 500, 16);
}

describe('createDriftingCirclesStyle — worldKnobs', () => {
  it('declares exactly the two placeholder knobs', () => {
    const style = createDriftingCirclesStyle();
    expect(style.worldKnobs()).toEqual(['placeholderCircleCount', 'placeholderDriftSpeed']);
  });
});

describe('createDriftingCirclesStyle — determinism (invariant 4)', () => {
  it('two instances with the same world seed and identical step() sequences produce identical scenes', () => {
    const styleA = createDriftingCirclesStyle();
    const styleB = createDriftingCirclesStyle();
    styleA.init(createWorld('same-seed', 0));
    styleB.init(createWorld('same-seed', 0));

    const params = makeParams();
    runSequence(styleA, params);
    runSequence(styleB, params);

    expect(styleA.scene()).toEqual(styleB.scene());
  });

  it('finish() matches scene() called right after the same step() sequence', () => {
    const style = createDriftingCirclesStyle();
    style.init(createWorld('same-seed', 0));
    runSequence(style, makeParams());

    expect(style.finish()).toEqual(style.scene());
  });

  it('scene() returns a fresh array each call, not a shared mutable reference', () => {
    const style = createDriftingCirclesStyle();
    style.init(createWorld('same-seed', 0));
    style.step(makeParams(), 0, 16);

    const first = style.scene();
    first.elements.pop();

    expect(style.scene().elements.length).toBe(first.elements.length + 1);
  });
});

describe('createDriftingCirclesStyle — seed variation', () => {
  it('different worldSeeds produce different initial circle layouts', () => {
    const styleA = createDriftingCirclesStyle();
    const styleB = createDriftingCirclesStyle();
    styleA.init(createWorld('world-seed-a', 0));
    styleB.init(createWorld('world-seed-b', 0));

    const params = makeParams();
    styleA.step(params, 0, 16);
    styleB.step(params, 0, 16);

    expect(styleA.scene()).not.toEqual(styleB.scene());
  });
});

describe('createDriftingCirclesStyle — movement responsiveness', () => {
  it('a higher params.expansion measurably changes circle output at the same time/dt', () => {
    const styleLow = createDriftingCirclesStyle();
    const styleHigh = createDriftingCirclesStyle();
    const world = createWorld('same-seed', 0);
    styleLow.init(world);
    styleHigh.init(createWorld('same-seed', 0));

    // A time offset where sin/cos aren't at a degenerate zero, so a change
    // in amplitude (driven by expansion) actually moves the circle.
    styleLow.step(makeParams({ expansion: 0.1 }), 1234, 16);
    styleHigh.step(makeParams({ expansion: 0.9 }), 1234, 16);

    // drifting-circles.ts's step() only ever produces 'circle' elements, so
    // this cast is safe -- narrows the widened SceneElement union back to
    // the shape this test actually reads (.x/.y).
    const low = styleLow.scene().elements as { x: number; y: number }[];
    const high = styleHigh.scene().elements as { x: number; y: number }[];
    expect(low.length).toBe(high.length);

    const anyDifferent = low.some((element, i) => {
      const other = high[i];
      return other !== undefined && (element.x !== other.x || element.y !== other.y);
    });
    expect(anyDifferent).toBe(true);
  });
});
