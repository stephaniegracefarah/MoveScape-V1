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
