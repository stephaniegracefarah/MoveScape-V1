/**
 * Roadmap item A ("Finish preview"): unit tests for the pure fit-geometry
 * helper. computeFitDimensions is the only side-effect-free part of the
 * feature -- setCanvasDisplayMode and the finish/keep-moving wiring touch
 * the DOM and are covered by manual QA, not here.
 */
import { describe, expect, it } from 'vitest';
import { computeFitDimensions } from './main';

describe('computeFitDimensions', () => {
  it('long skinny piece uses the floor height and scrolls from the left', () => {
    // 9600x640 is 15:1 (~ a long session). Fit-to-width height would be
    // 1440/15 = 96px, far below the 360px floor.
    const fit = computeFitDimensions(9600, 640, 1440, 900, 0.4);
    expect(fit.displayHeight).toBe(360); // 0.4 * 900
    expect(fit.displayWidth).toBe(5400); // 360 * 15
    expect(fit.scrollable).toBe(true);
    expect(fit.startAtLeft).toBe(true);
  });

  it('moderate piece fits comfortably: fit to width, no scroll', () => {
    // 2400x640 is 3.75:1. Fit-to-width height = 1440/3.75 = 384px, which is
    // >= the 360px floor and <= the 900px viewport.
    const fit = computeFitDimensions(2400, 640, 1440, 900, 0.4);
    expect(fit.displayWidth).toBe(1440);
    expect(fit.displayHeight).toBe(384);
    expect(fit.scrollable).toBe(false);
    expect(fit.startAtLeft).toBe(false);
  });

  it('tall / near-square piece fits to height, staying within the viewport width', () => {
    // 640x640 is 1:1. Fit-to-width height would be 1440px, taller than the
    // 900px viewport, so it fits to height instead.
    const fit = computeFitDimensions(640, 640, 1440, 900, 0.4);
    expect(fit.displayHeight).toBe(900);
    expect(fit.displayWidth).toBe(900); // 900 * aspect(1)
    expect(fit.displayWidth).toBeLessThanOrEqual(1440);
    expect(fit.scrollable).toBe(false);
    expect(fit.startAtLeft).toBe(false);
  });

  it('boundary: fit-to-width height landing exactly on the 40% floor is not scrollable', () => {
    // 2560x640 is 4:1. Fit-to-width height = 1440/4 = 360px == 0.4 * 900.
    // The >= floor comparison is inclusive, so this is a comfortable fit.
    const fit = computeFitDimensions(2560, 640, 1440, 900, 0.4);
    expect(fit.displayHeight).toBe(360);
    expect(fit.displayWidth).toBe(1440);
    expect(fit.scrollable).toBe(false);
    expect(fit.startAtLeft).toBe(false);
  });

  it('guards against a zero / non-finite canvas height', () => {
    const zero = computeFitDimensions(1000, 0, 1440, 900, 0.4);
    expect(zero.displayWidth).toBe(900);
    expect(zero.displayHeight).toBe(900);
    expect(zero.scrollable).toBe(false);

    const nan = computeFitDimensions(Number.NaN, 640, 1440, 900, 0.4);
    expect(Number.isFinite(nan.displayWidth)).toBe(true);
    expect(Number.isFinite(nan.displayHeight)).toBe(true);
  });
});
