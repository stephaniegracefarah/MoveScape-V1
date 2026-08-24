/**
 * Determinism acceptance criterion for the paper-ground texture, mirrored
 * from src/engine/pixel-determinism.test.ts's @napi-rs/canvas + cyrb53Bytes
 * pattern: same seed must paint byte-identical pixels (invariant 3), and a
 * different seed must paint different pixels (the sensitivity guard every
 * other determinism test in this repo uses). Plus a plain mock-canvas test
 * (no real canvas needed) asserting renderPaperGround only calls documented
 * CanvasLike methods on the ctx/canvasSize it's given.
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { CanvasLike, CanvasSize } from './render-scene';
import { renderPaperGround } from './paper-ground';
import { cyrb53Bytes } from '../shared/hash';

const CANVAS_SIZE: CanvasSize = { width: 64, height: 64 };

/**
 * Renders the paper ground via the real function and returns a hash of the
 * resulting pixel buffer. @napi-rs/canvas's 2D context structurally
 * satisfies CanvasLike except that its `fillStyle`/`strokeStyle` are typed
 * as `string | CanvasGradient | CanvasPattern` rather than a bare `string`,
 * so a local cast is needed here -- same pattern as pixel-determinism.test.ts.
 */
function renderToPixelHash(seed: string): number {
  const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
  const ctx = canvas.getContext('2d');
  renderPaperGround(ctx as unknown as CanvasLike, CANVAS_SIZE, seed);
  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  return cyrb53Bytes(imageData.data);
}

describe('renderPaperGround — pixel determinism', () => {
  it('paints byte-identical pixels for the same seed, twice', () => {
    const hashA = renderToPixelHash('paper-seed-a');
    const hashB = renderToPixelHash('paper-seed-a');

    expect(hashB).toBe(hashA);
  });

  it('sensitivity guard: a different seed produces a different pixel hash', () => {
    const hashA = renderToPixelHash('paper-seed-a');
    const hashDifferent = renderToPixelHash('paper-seed-different');

    expect(hashDifferent).not.toBe(hashA);
  });
});

describe('renderPaperGround — CanvasLike call surface', () => {
  type RecordedCall =
    | { method: 'setFillStyle'; args: [string] }
    | { method: 'setGlobalAlpha'; args: [number] }
    | { method: 'fillRect'; args: [number, number, number, number] }
    | { method: 'beginPath'; args: [] }
    | { method: 'arc'; args: [number, number, number, number, number] }
    | { method: 'fill'; args: [] };

  function createMockCanvas(): CanvasLike & { calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    let fillStyle = '';
    let strokeStyle = '';
    let globalAlpha = 1;
    let lineWidth = 1;
    let lineCap: 'butt' | 'round' | 'square' = 'butt';

    return {
      calls,
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
        calls.push({ method: 'setFillStyle', args: [value] });
      },
      get strokeStyle() {
        return strokeStyle;
      },
      set strokeStyle(value: string) {
        strokeStyle = value;
      },
      get globalAlpha() {
        return globalAlpha;
      },
      set globalAlpha(value: number) {
        globalAlpha = value;
        calls.push({ method: 'setGlobalAlpha', args: [value] });
      },
      get lineWidth() {
        return lineWidth;
      },
      set lineWidth(value: number) {
        lineWidth = value;
      },
      get lineCap() {
        return lineCap;
      },
      set lineCap(value: 'butt' | 'round' | 'square') {
        lineCap = value;
      },
      clearRect() {
        throw new Error('renderPaperGround must not call clearRect');
      },
      fillRect(x, y, w, h) {
        calls.push({ method: 'fillRect', args: [x, y, w, h] });
      },
      beginPath() {
        calls.push({ method: 'beginPath', args: [] });
      },
      arc(x, y, radius, startAngle, endAngle) {
        calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
      },
      moveTo() {
        throw new Error('renderPaperGround must not call moveTo');
      },
      lineTo() {
        throw new Error('renderPaperGround must not call lineTo');
      },
      fill() {
        calls.push({ method: 'fill', args: [] });
      },
      stroke() {
        throw new Error('renderPaperGround must not call stroke');
      },
    };
  }

  it('only calls fillRect/beginPath/arc/fill plus fillStyle/globalAlpha setters', () => {
    const canvas = createMockCanvas();

    renderPaperGround(canvas, CANVAS_SIZE, 'call-surface-seed');

    const methods = new Set(canvas.calls.map((c) => c.method));
    expect(methods).toEqual(new Set(['setFillStyle', 'setGlobalAlpha', 'fillRect', 'beginPath', 'arc', 'fill']));
  });

  it('fills the full canvas bounds exactly once, before any circle is drawn', () => {
    const canvas = createMockCanvas();

    renderPaperGround(canvas, CANVAS_SIZE, 'call-surface-seed');

    const fillRectCalls = canvas.calls.filter((c) => c.method === 'fillRect');
    expect(fillRectCalls).toHaveLength(1);
    expect(fillRectCalls[0]).toEqual({ method: 'fillRect', args: [0, 0, 64, 64] });

    const fillRectIndex = canvas.calls.indexOf(fillRectCalls[0]!);
    const firstArcIndex = canvas.calls.findIndex((c) => c.method === 'arc');
    expect(fillRectIndex).toBeLessThan(firstArcIndex);
  });

  it('leaves globalAlpha reset to 1 at the end', () => {
    const canvas = createMockCanvas();

    renderPaperGround(canvas, CANVAS_SIZE, 'call-surface-seed');

    expect(canvas.globalAlpha).toBe(1);
  });
});

/**
 * grainScale (added for src/compositor/export-render.ts's high-resolution
 * export path -- see renderPaperGround's own grainScale doc comment):
 * scales only the fine-grain pass's device-pixel radius, never the
 * mottling pass (which already self-scales via shorterSide), and never
 * changes the seeded stream's draw order/count.
 */
describe('renderPaperGround — grainScale', () => {
  // A minimal, local CanvasLike mock -- only the arc() radius/position is
  // inspected below, so this deliberately doesn't need the full call-trace
  // surface the "CanvasLike call surface" describe block's own
  // createMockCanvas has (that one is scoped to its own describe block, not
  // reachable from here).
  type ArcCall = { method: 'arc'; args: [number, number, number, number, number] };
  function createMockCanvas(): CanvasLike & { calls: ArcCall[] } {
    const calls: ArcCall[] = [];
    let fillStyle = '';
    let strokeStyle = '';
    let globalAlpha = 1;
    let lineWidth = 1;
    let lineCap: 'butt' | 'round' | 'square' = 'butt';
    return {
      calls,
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      get strokeStyle() {
        return strokeStyle;
      },
      set strokeStyle(value: string) {
        strokeStyle = value;
      },
      get globalAlpha() {
        return globalAlpha;
      },
      set globalAlpha(value: number) {
        globalAlpha = value;
      },
      get lineWidth() {
        return lineWidth;
      },
      set lineWidth(value: number) {
        lineWidth = value;
      },
      get lineCap() {
        return lineCap;
      },
      set lineCap(value: 'butt' | 'round' | 'square') {
        lineCap = value;
      },
      clearRect() {},
      fillRect() {},
      beginPath() {},
      arc(x, y, radius, startAngle, endAngle) {
        calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
      },
      moveTo() {},
      lineTo() {},
      fill() {},
      stroke() {},
    };
  }

  it('defaulting to 1 leaves byte-identical output to the pre-existing signature (backward compatible)', () => {
    const withDefault = createMockCanvas();
    renderPaperGround(withDefault, CANVAS_SIZE, 'grain-scale-seed');
    const withExplicit1 = createMockCanvas();
    renderPaperGround(withExplicit1, CANVAS_SIZE, 'grain-scale-seed', 1);
    expect(withExplicit1.calls).toEqual(withDefault.calls);
  });

  it('leaves the FIRST arc (the mottling pass\'s first circle) at an unchanged radius across grainScale values -- only the grain pass scales', () => {
    const scale1 = createMockCanvas();
    renderPaperGround(scale1, CANVAS_SIZE, 'grain-scale-seed', 1);
    const scale3 = createMockCanvas();
    renderPaperGround(scale3, CANVAS_SIZE, 'grain-scale-seed', 3);

    const firstArc1 = scale1.calls.find((c) => c.method === 'arc')!;
    const firstArc3 = scale3.calls.find((c) => c.method === 'arc')!;
    expect(firstArc3.args[2]).toBeCloseTo(firstArc1.args[2] as number, 10);
  });

  it('scales the LAST arc (the grain pass\'s last circle) radius exactly proportionally to grainScale', () => {
    const scale1 = createMockCanvas();
    renderPaperGround(scale1, CANVAS_SIZE, 'grain-scale-seed', 1);
    const scale3 = createMockCanvas();
    renderPaperGround(scale3, CANVAS_SIZE, 'grain-scale-seed', 3);

    const arcs1 = scale1.calls.filter((c) => c.method === 'arc');
    const arcs3 = scale3.calls.filter((c) => c.method === 'arc');
    expect(arcs3).toHaveLength(arcs1.length);

    const lastArc1 = arcs1[arcs1.length - 1]!;
    const lastArc3 = arcs3[arcs3.length - 1]!;
    // Same center position (grainScale never touches x/y draws).
    expect(lastArc3.args[0]).toBeCloseTo(lastArc1.args[0] as number, 10);
    expect(lastArc3.args[1]).toBeCloseTo(lastArc1.args[1] as number, 10);
    // Radius exactly 3x.
    expect(lastArc3.args[2]).toBeCloseTo((lastArc1.args[2] as number) * 3, 10);
  });

  it('preserves pixel determinism: same seed + same grainScale paints byte-identical real-canvas pixels, twice', () => {
    function renderToPixelHash(scale: number): number {
      const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
      const ctx = canvas.getContext('2d');
      renderPaperGround(ctx as unknown as CanvasLike, CANVAS_SIZE, 'grain-scale-determinism-seed', scale);
      const imageData = ctx.getImageData(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
      return cyrb53Bytes(imageData.data);
    }

    expect(renderToPixelHash(2.5)).toBe(renderToPixelHash(2.5));
  });
});
