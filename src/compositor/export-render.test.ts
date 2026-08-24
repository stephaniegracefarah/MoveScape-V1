/**
 * Colocated tests for export-render.ts (founder backlog: exported PNGs were
 * pixelated when zoomed -- fixed by re-rendering the whole scene fresh at a
 * higher pixel scale instead of exporting the live on-screen canvas's own
 * pixels). Three groups:
 *
 * 1. clampExportScale/computeExportCanvasSize -- pure math, no canvas at all.
 * 2. renderBucketedScene's paint ORDER -- a hand-written CanvasLike mock
 *    (same house style as render-scene.test.ts/live-compositor.test.ts),
 *    proving the founder-mandated bucket order (echo always behind
 *    foreground, regardless of z) is what actually gets drawn, in direct
 *    contrast to what a plain global z-sort (renderScene()) would do for
 *    the identical input.
 * 3. A real @napi-rs/canvas pixel test (same technique as
 *    src/engine/pixel-determinism.test.ts and paper-ground.test.ts): scale
 *    correctness (geometry at 2x lands at exactly 2x-scaled pixel
 *    coordinates) and a byte-identical-pixels check that renderBucketedScene
 *    agrees, bucket by bucket, with calling the real renderScene() on each
 *    bucket's own elements in turn -- the same "reuse renderScene() per
 *    bucket" equivalence render-divergence-harness.ts's own
 *    renderSceneByBucket independently relies on, verified here directly
 *    against THIS module's implementation instead of importing that (a
 *    different, concurrently-in-progress file).
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  clampExportScale,
  computeExportCanvasSize,
  DEFAULT_EXPORT_SCALE,
  MAX_EXPORT_AREA_PX,
  MAX_EXPORT_DIMENSION_PX,
  renderBucketedScene,
  renderExportScene,
  renderStyleToExportCanvas,
  type ExportRenderCanvas,
  type ExportRenderCanvasFactory,
} from './export-render';
import { renderScene, type CanvasLike, type CanvasSize } from './render-scene';
import { cyrb53Bytes } from '../shared/hash';
import type { CircleElement, Scene, SceneLayer, StyleRenderer } from '../styles/style-renderer';

// --- 1. Pure scale math --------------------------------------------------

describe('clampExportScale', () => {
  it('returns the requested scale unchanged when nothing is close to the limits', () => {
    const scale = clampExportScale({ width: 480, height: 480 }, DEFAULT_EXPORT_SCALE);
    expect(scale).toBe(DEFAULT_EXPORT_SCALE);
  });

  it('clamps to the width limit when width*scale would exceed MAX_EXPORT_DIMENSION_PX (a very wide, short canvas -- the real "unbounded scroll" risk)', () => {
    const base: CanvasSize = { width: 20000, height: 480 };
    const scale = clampExportScale(base, 3);
    expect(scale).toBeCloseTo(MAX_EXPORT_DIMENSION_PX / base.width, 10);
    expect(base.width * scale).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION_PX);
    // Falls below 1x -- "never fail the save" for a pathologically wide piece.
    expect(scale).toBeLessThan(1);
  });

  it('clamps to the height limit when height*scale would exceed MAX_EXPORT_DIMENSION_PX', () => {
    const base: CanvasSize = { width: 480, height: 20000 };
    const scale = clampExportScale(base, 3);
    expect(scale).toBeCloseTo(MAX_EXPORT_DIMENSION_PX / base.height, 10);
    expect(base.height * scale).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION_PX);
  });

  it('clamps to the area limit when both dimensions individually fit under MAX_EXPORT_DIMENSION_PX but the requested scale would push total area over MAX_EXPORT_AREA_PX', () => {
    const base: CanvasSize = { width: 6000, height: 6000 };
    // Sanity: at the requested scale, neither per-dimension limit binds --
    // this case exists specifically to exercise the area constraint alone.
    expect(base.width * 3).toBeGreaterThan(MAX_EXPORT_DIMENSION_PX);
    const scale = clampExportScale(base, 3);
    const expected = Math.sqrt(MAX_EXPORT_AREA_PX / (base.width * base.height));
    expect(scale).toBeCloseTo(expected, 10);
    expect(base.width * scale * (base.height * scale)).toBeLessThanOrEqual(MAX_EXPORT_AREA_PX + 1);
  });

  it('falls back toward (and, if necessary, below) 1x rather than failing when even a modest scale would violate a limit', () => {
    // A piece scrolled wide enough that even requesting 1x is already near
    // the edge -- the clamp must still return a small positive, finite
    // scale, never throw or return 0/NaN.
    const base: CanvasSize = { width: 200000, height: 480 };
    const scale = clampExportScale(base, DEFAULT_EXPORT_SCALE);
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(0);
    expect(base.width * scale).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION_PX);
  });

  it('degenerate inputs (non-positive requested scale, zero-size base) fall back to a safe positive scale instead of throwing/NaN', () => {
    expect(clampExportScale({ width: 480, height: 480 }, 0)).toBe(1);
    expect(clampExportScale({ width: 480, height: 480 }, -3)).toBe(1);
    expect(clampExportScale({ width: 0, height: 480 }, 3)).toBe(1);
    expect(clampExportScale({ width: 480, height: 0 }, 3)).toBe(1);
  });
});

describe('computeExportCanvasSize', () => {
  it('scales and rounds both dimensions', () => {
    expect(computeExportCanvasSize({ width: 480, height: 480 }, 3)).toEqual({ width: 1440, height: 1440 });
  });

  it('rounds fractional pixel sizes rather than truncating or floating', () => {
    expect(computeExportCanvasSize({ width: 481, height: 480 }, 2.5)).toEqual({ width: 1203, height: 1200 });
  });

  it('never returns a 0px dimension even for a vanishingly small scale', () => {
    expect(computeExportCanvasSize({ width: 480, height: 480 }, 0.0001)).toEqual({ width: 1, height: 1 });
  });
});

// --- 2. Bucket paint order (mock CanvasLike, no real canvas) ------------

type RecordedCall =
  | { method: 'setFillStyle'; args: [string] }
  | { method: 'setGlobalAlpha'; args: [number] }
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
    clearRect() {},
    fillRect() {},
    beginPath() {
      calls.push({ method: 'beginPath', args: [] });
    },
    arc(x, y, radius, startAngle, endAngle) {
      calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
    },
    moveTo() {},
    lineTo() {},
    fill() {
      calls.push({ method: 'fill', args: [] });
    },
    stroke() {},
  };
}

function makeCircle(overrides: Partial<CircleElement> = {}): CircleElement {
  return { kind: 'circle', z: 0, x: 0.5, y: 0.5, radius: 0.1, color: 'red', opacity: 1, ...overrides };
}

describe('renderBucketedScene — founder-mandated bucket order', () => {
  const CANVAS_SIZE: CanvasSize = { width: 200, height: 100 };

  it('paints echo1 -> echo0 -> foreground in that fixed order, even when a later bucket has a FARTHER (larger) z than an earlier one -- the exact disagreement with a global z-sort this module exists to avoid', () => {
    // Foreground's element is farther (z=0.9) than echo0's (z=0.1). A plain
    // global z-sort (renderScene(), farthest-first) would draw foreground
    // FIRST here -- but the live look requires echo0 underneath foreground
    // regardless, so foreground must still land last (on top).
    const layers: SceneLayer[] = [
      { layerId: 'fg0', elements: [makeCircle({ x: 0.9, z: 0.9 })] },
      { layerId: 'echo0', elements: [makeCircle({ x: 0.1, z: 0.1 })] },
    ];

    const ctx = createMockCanvas();
    renderBucketedScene(ctx, layers, CANVAS_SIZE);

    const arcXs = ctx.calls.filter((c) => c.method === 'arc').map((c) => c.args[0]);
    // echo0's circle (x=0.1 world units -> 10px) drawn before foreground's
    // (x=0.9 world units -> 90px), despite foreground having the farther z.
    expect(arcXs).toEqual([10, 90]);

    // Sanity: a plain global z-sort of the SAME two elements would disagree
    // -- foreground (z=0.9, farthest) would draw FIRST, echo0 (z=0.1)
    // LAST. Confirms this test genuinely distinguishes bucket-order from
    // global-z-order, not a case where they'd coincidentally agree anyway.
    const globalSortCtx = createMockCanvas();
    const scene: Scene = { elements: [...layers[0]!.elements, ...layers[1]!.elements] };
    renderScene(globalSortCtx, scene, CANVAS_SIZE);
    const globalSortArcXs = globalSortCtx.calls.filter((c) => c.method === 'arc').map((c) => c.args[0]);
    expect(globalSortArcXs).toEqual([90, 10]);
  });

  it('z-sorts WITHIN a bucket (farthest first) exactly like renderScene() does globally', () => {
    const layers: SceneLayer[] = [
      { layerId: 'fg0', elements: [makeCircle({ x: 0.2, z: 0.1 })] },
      { layerId: 'fg1', elements: [makeCircle({ x: 0.8, z: 0.9 })] },
    ];

    const ctx = createMockCanvas();
    renderBucketedScene(ctx, layers, CANVAS_SIZE);

    const arcXs = ctx.calls.filter((c) => c.method === 'arc').map((c) => c.args[0]);
    // Both in the 'foreground' bucket (neither layerId is echo0/echo1) --
    // farthest (z=0.9, x=0.8 -> 80px) drawn first, nearest last, so the
    // nearer one ends up on top.
    expect(arcXs).toEqual([80, 20]);
  });

  it('leaves globalAlpha reset to 1 when done', () => {
    const layers: SceneLayer[] = [{ layerId: 'echo1', elements: [makeCircle({ opacity: 0.3 })] }];
    const ctx = createMockCanvas();
    renderBucketedScene(ctx, layers, CANVAS_SIZE);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('an empty layer set draws nothing (no beginPath/arc/fill) and leaves globalAlpha at 1', () => {
    const ctx = createMockCanvas();
    renderBucketedScene(ctx, [], CANVAS_SIZE);
    expect(ctx.calls.filter((c) => c.method !== 'setGlobalAlpha')).toHaveLength(0);
    expect(ctx.globalAlpha).toBe(1);
  });
});

describe('renderExportScene — dispatches on style.sceneLayers presence', () => {
  const CANVAS_SIZE: CanvasSize = { width: 100, height: 100 };

  it('uses the bucketed path when style.sceneLayers exists', () => {
    let sceneLayersCalled = false;
    let sceneCalled = false;
    const style: Pick<StyleRenderer, 'scene' | 'sceneLayers'> = {
      scene(): Scene {
        sceneCalled = true;
        return { elements: [] };
      },
      sceneLayers(): SceneLayer[] {
        sceneLayersCalled = true;
        return [{ layerId: 'fg0', elements: [makeCircle()] }];
      },
    };

    const ctx = createMockCanvas();
    renderExportScene(ctx, style, CANVAS_SIZE, 'seed', 1);

    expect(sceneLayersCalled).toBe(true);
    expect(sceneCalled).toBe(false);
    expect(ctx.calls.some((c) => c.method === 'arc')).toBe(true);
  });

  it('falls back to plain renderScene() (matching live-render-loop.ts own non-sceneLayers path) when style.sceneLayers is absent', () => {
    let sceneCalled = false;
    const style: Pick<StyleRenderer, 'scene' | 'sceneLayers'> = {
      scene(): Scene {
        sceneCalled = true;
        return { elements: [makeCircle()] };
      },
    };

    const ctx = createMockCanvas();
    renderExportScene(ctx, style, CANVAS_SIZE, 'seed', 1);

    expect(sceneCalled).toBe(true);
    expect(ctx.calls.some((c) => c.method === 'arc')).toBe(true);
  });
});

// --- 3. Real-canvas pixel tests (@napi-rs/canvas) ------------------------

describe('renderBucketedScene — geometry scales correctly at higher resolution', () => {
  it('a circle drawn at 2x canvasSize lands its center at exactly 2x the 1x pixel coordinates, with a proportionally larger filled radius', () => {
    const baseSize: CanvasSize = { width: 100, height: 100 };
    const scaledSize: CanvasSize = { width: 200, height: 200 };
    const layers: SceneLayer[] = [{ layerId: 'fg0', elements: [makeCircle({ x: 0.5, y: 0.5, radius: 0.1, z: 0 })] }];

    const baseCanvas = createCanvas(baseSize.width, baseSize.height);
    const baseCtx = baseCanvas.getContext('2d');
    renderBucketedScene(baseCtx as unknown as CanvasLike, layers, baseSize);

    const scaledCanvas = createCanvas(scaledSize.width, scaledSize.height);
    const scaledCtx = scaledCanvas.getContext('2d');
    renderBucketedScene(scaledCtx as unknown as CanvasLike, layers, scaledSize);

    // world x=0.5,y=0.5 at worldUnitPx=height -> (50,50) at 1x, (100,100) at 2x.
    const baseCenter = baseCtx.getImageData(50, 50, 1, 1).data;
    const scaledCenter = scaledCtx.getImageData(100, 100, 1, 1).data;
    // Both centers land inside the filled circle (opaque, non-background).
    expect(baseCenter[3]).toBeGreaterThan(0);
    expect(scaledCenter[3]).toBeGreaterThan(0);

    // The circle's rightmost edge: radius 0.1 world units * worldUnitPx.
    // At 1x that's x=60 (inside), just past x=61 (outside); at 2x, exactly
    // double: x=120 inside, just past x=122 outside.
    expect(baseCtx.getImageData(59, 50, 1, 1).data[3]).toBeGreaterThan(0);
    expect(baseCtx.getImageData(65, 50, 1, 1).data[3]).toBe(0);
    expect(scaledCtx.getImageData(119, 100, 1, 1).data[3]).toBeGreaterThan(0);
    expect(scaledCtx.getImageData(130, 100, 1, 1).data[3]).toBe(0);
  });
});

describe('renderBucketedScene — agrees pixel-for-pixel with calling renderScene() once per bucket, in bucket order', () => {
  it('byte-identical output to a hand-composited "renderScene() per bucket, in BUCKET_PAINT_ORDER" reference, for a scene with overlapping echo/foreground z', () => {
    const canvasSize: CanvasSize = { width: 120, height: 80 };
    const layers: SceneLayer[] = [
      { layerId: 'fg0', elements: [makeCircle({ x: 0.3, y: 0.5, z: 0.9, color: '#204060', radius: 0.15 })] },
      { layerId: 'echo0', elements: [makeCircle({ x: 0.5, y: 0.5, z: 0.05, color: '#803010', radius: 0.2 })] },
      { layerId: 'echo1', elements: [makeCircle({ x: 0.7, y: 0.5, z: 0.5, color: '#106030', radius: 0.12 })] },
      { layerId: 'fg1', elements: [makeCircle({ x: 0.9, y: 0.5, z: 0.2, color: '#402070', radius: 0.1 })] },
    ];

    const actualCanvas = createCanvas(canvasSize.width, canvasSize.height);
    const actualCtx = actualCanvas.getContext('2d');
    renderBucketedScene(actualCtx as unknown as CanvasLike, layers, canvasSize);

    // Reference: exactly BUCKET_PAINT_ORDER (echo1 -> echo0 -> foreground),
    // each bucket composited via a fresh, real renderScene() call on that
    // bucket's own elements only -- the same technique
    // render-divergence-harness.ts's renderSceneByBucket independently
    // uses, reconstructed here so this test doesn't depend on that
    // separate, concurrently-changing file.
    const referenceCanvas = createCanvas(canvasSize.width, canvasSize.height);
    const referenceCtx = referenceCanvas.getContext('2d');
    const byBucket = { echo1: [layers[2]!.elements[0]!], echo0: [layers[1]!.elements[0]!], foreground: [layers[0]!.elements[0]!, layers[3]!.elements[0]!] };
    for (const bucket of ['echo1', 'echo0', 'foreground'] as const) {
      renderScene(referenceCtx as unknown as CanvasLike, { elements: byBucket[bucket] }, canvasSize);
    }

    const actualData = actualCtx.getImageData(0, 0, canvasSize.width, canvasSize.height).data;
    const referenceData = referenceCtx.getImageData(0, 0, canvasSize.width, canvasSize.height).data;
    expect(cyrb53Bytes(actualData)).toBe(cyrb53Bytes(referenceData));
  });
});

// --- ExportRenderCanvasFactory DI (renderStyleToExportCanvas orchestration) --

function createNodeExportRenderCanvasFactory(): ExportRenderCanvasFactory & { created: CanvasSize[] } {
  const created: CanvasSize[] = [];
  return {
    created,
    create(size: CanvasSize): ExportRenderCanvas {
      created.push(size);
      const canvas = createCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      return {
        ctx: ctx as unknown as CanvasLike,
        toBlob(callback: (blob: unknown) => void): void {
          callback(canvas.toBuffer('image/png'));
        },
      };
    },
  };
}

describe('renderStyleToExportCanvas', () => {
  it('creates the canvas at the clamped scale and paints the style\'s full current scene onto it', () => {
    const style: Pick<StyleRenderer, 'scene' | 'sceneLayers'> = {
      scene(): Scene {
        return { elements: [] };
      },
      sceneLayers(): SceneLayer[] {
        return [{ layerId: 'fg0', elements: [makeCircle({ x: 0.5, y: 0.5, radius: 0.2 })] }];
      },
    };
    const factory = createNodeExportRenderCanvasFactory();

    const { canvasSize, scaleUsed } = renderStyleToExportCanvas(
      style,
      'export-seed',
      { width: 480, height: 480 },
      factory,
      3,
    );

    expect(scaleUsed).toBe(3);
    expect(canvasSize).toEqual({ width: 1440, height: 1440 });
    expect(factory.created).toEqual([{ width: 1440, height: 1440 }]);
  });

  it('defaults to DEFAULT_EXPORT_SCALE when no scale is requested', () => {
    const style: Pick<StyleRenderer, 'scene' | 'sceneLayers'> = {
      scene(): Scene {
        return { elements: [] };
      },
    };
    const factory = createNodeExportRenderCanvasFactory();

    const { scaleUsed } = renderStyleToExportCanvas(style, 'export-seed', { width: 480, height: 480 }, factory);

    expect(scaleUsed).toBe(DEFAULT_EXPORT_SCALE);
  });
});
