import { describe, expect, it } from 'vitest';
import type { CircleElement, SceneLayer, StrokeElement } from '../styles/style-renderer';
import { createLiveCompositor, type OffscreenBuffer, type OffscreenBufferFactory } from './live-compositor';
import { drawStrokeSegment, type CanvasLike, type CanvasSize } from './render-scene';

// Same house style as render-scene.test.ts: a single ordered trace of every
// CanvasLike interaction, so tests can assert both "what was drawn" and "in
// what order" without a real canvas. 'blitTo' is this file's own addition
// (see createFakeBufferFactory below): the fake buffer pushes it directly
// onto whatever destCtx it was handed, so a single dest.calls trace can
// interleave "a bucket got blitted" with "destCtx got drawn on directly" in
// one true chronological order -- needed for the paint-order tests below.
type RecordedCall =
  | { method: 'fillRect'; args: [number, number, number, number] }
  | { method: 'setFillStyle'; args: [string] }
  | { method: 'setStrokeStyle'; args: [string] }
  | { method: 'setLineWidth'; args: [number] }
  | { method: 'beginPath'; args: [] }
  | { method: 'arc'; args: [number, number, number, number, number] }
  | { method: 'moveTo'; args: [number, number] }
  | { method: 'lineTo'; args: [number, number] }
  | { method: 'fill'; args: [] }
  | { method: 'stroke'; args: [] }
  | { method: 'blitTo'; args: [number] };

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
      calls.push({ method: 'setStrokeStyle', args: [value] });
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
      calls.push({ method: 'setLineWidth', args: [value] });
    },
    get lineCap() {
      return lineCap;
    },
    set lineCap(value: 'butt' | 'round' | 'square') {
      lineCap = value;
    },
    clearRect() {},
    fillRect(x, y, w, h) {
      calls.push({ method: 'fillRect', args: [x, y, w, h] });
    },
    beginPath() {
      calls.push({ method: 'beginPath', args: [] });
    },
    arc(x, y, radius, startAngle, endAngle) {
      calls.push({ method: 'arc', args: [x, y, radius, startAngle, endAngle] });
    },
    moveTo(x, y) {
      calls.push({ method: 'moveTo', args: [x, y] });
    },
    lineTo(x, y) {
      calls.push({ method: 'lineTo', args: [x, y] });
    },
    fill() {
      calls.push({ method: 'fill', args: [] });
    },
    stroke() {
      calls.push({ method: 'stroke', args: [] });
    },
  };
}

/**
 * A hand-written fake OffscreenBufferFactory: `create()` hands back a fresh
 * mock canvas (see above) wrapped in a real OffscreenBuffer, and every
 * buffer/grow/blit is recorded so tests can inspect exactly what the
 * compositor asked of its buffers -- no real canvas involved anywhere.
 * `blitTo` additionally pushes a `blitTo` record directly onto whatever
 * `dest` it's given (when `dest` is one of this file's own mock canvases),
 * so a single dest.calls trace captures true relative ordering between
 * "bucket N got blitted" and "destCtx got drawn on directly" (the live,
 * still-growing-stroke pass) -- see the paint-order describe block below.
 */
function createFakeBufferFactory(): OffscreenBufferFactory & {
  createdBuffers: (CanvasLike & { calls: RecordedCall[] })[];
  growCalls: { bufferIndex: number; size: CanvasSize }[];
  blitOrder: number[];
  /** `dest.globalAlpha` as observed AT THE MOMENT each blitTo call fired, same index alignment as blitOrder -- session 024's globalAlpha-leak regression test reads this directly (a real `drawImage`-based blitTo, like main.ts's or the harness's, would composite using exactly this value, so recording it here is what lets a test assert "this blit would have landed opaque" without needing a real canvas). */
  blitAlphas: number[];
} {
  const createdBuffers: (CanvasLike & { calls: RecordedCall[] })[] = [];
  const growCalls: { bufferIndex: number; size: CanvasSize }[] = [];
  const blitOrder: number[] = [];
  const blitAlphas: number[] = [];

  return {
    createdBuffers,
    growCalls,
    blitOrder,
    blitAlphas,
    create(size: CanvasSize): OffscreenBuffer {
      const bufferIndex = createdBuffers.length;
      const canvas = createMockCanvas();
      createdBuffers.push(canvas);
      void size; // recorded implicitly via growCalls/creation order, not needed here
      return {
        ctx: canvas,
        blitTo(dest: CanvasLike) {
          blitOrder.push(bufferIndex);
          blitAlphas.push(dest.globalAlpha);
          const target = dest as CanvasLike & { calls?: RecordedCall[] };
          target.calls?.push({ method: 'blitTo', args: [bufferIndex] });
        },
        growTo(newSize: CanvasSize) {
          growCalls.push({ bufferIndex, size: newSize });
          // Deliberately does NOT touch canvas.calls -- growTo's own
          // contract is "preserve existing content," and this fake's
          // bookkeeping models that by simply never clearing it.
        },
      };
    },
  };
}

function makeStroke(points: { x: number; y: number }[], overrides: Partial<StrokeElement> = {}): StrokeElement {
  return { kind: 'stroke', z: 0, points, baseWidth: 0.05, taperExponent: 1, color: 'blue', opacity: 1, ...overrides };
}

/** Defaults `final: true` -- most tests in this file that use makeCircle() are exercising bake-exactly-once behavior, unaffected by session 021's new "a circle can be revealed but not yet safe to bake" state (see the dedicated describe block below for that). Override `final: false` explicitly to opt into the new live-redraw path instead. */
function makeCircle(overrides: Partial<CircleElement> = {}): CircleElement {
  return { kind: 'circle', z: 0, x: 0.5, y: 0.5, radius: 0.1, color: 'red', opacity: 1, final: true, ...overrides };
}

const CANVAS_SIZE: CanvasSize = { width: 200, height: 100 };
const DEST = (): CanvasLike & { calls: RecordedCall[] } => createMockCanvas();

describe('createLiveCompositor — the taper-freezing fix: strokes bake only once final', () => {
  it('a still-growing (non-final) stroke is never baked into the persistent buffer, however many frames it grows across', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const allPoints = Array.from({ length: 21 }, (_, i) => ({ x: i * 0.1, y: 0.5 }));
    for (let n = 2; n <= allPoints.length; n++) {
      compositor.renderFrame(
        [{ layerId: 'fg0', elements: [makeStroke(allPoints.slice(0, n), { final: false })] }],
        dest,
        CANVAS_SIZE,
        'seed-growing',
      );
    }

    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(0);
  });

  it('a still-growing stroke is instead redrawn fully, fresh, directly onto destCtx every single frame (proportional to its current segment count each time)', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    // Frames with 2, 3, 4, 5 points -> 1, 2, 3, 4 segments redrawn each
    // frame -> 10 total stroke() calls on dest across the 4 frames.
    for (let n = 2; n <= 5; n++) {
      const points = Array.from({ length: n }, (_, i) => ({ x: i * 0.1, y: 0.5 }));
      compositor.renderFrame(
        [{ layerId: 'fg0', elements: [makeStroke(points, { final: false })] }],
        dest,
        CANVAS_SIZE,
        'seed-live-redraw',
      );
    }

    expect(dest.calls.filter((c) => c.method === 'stroke')).toHaveLength(1 + 2 + 3 + 4);
  });

  it('a stroke baked at maturity uses its true final points.length -- taper widths match a direct full-redraw of the same final element exactly (the taper-freezing bug this fixes)', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const finalPoints = Array.from({ length: 21 }, (_, i) => ({ x: i * 0.1, y: 0.5 }));

    // Several frames of it still growing first -- these must have zero
    // effect on the eventual bake (proving the bug -- baking progressively
    // at each frame's then-current, too-short points.length -- is gone).
    for (let n = 2; n <= 10; n++) {
      compositor.renderFrame(
        [{ layerId: 'fg0', elements: [makeStroke(finalPoints.slice(0, n), { final: false })] }],
        dest,
        CANVAS_SIZE,
        'seed-taper',
      );
    }

    // Now it matures: full point count, final: true, in one call.
    const finalStroke = makeStroke(finalPoints, { final: true });
    compositor.renderFrame([{ layerId: 'fg0', elements: [finalStroke] }], dest, CANVAS_SIZE, 'seed-taper');

    const foregroundBuffer = factory.createdBuffers[2]!;
    const bakedLineWidths = foregroundBuffer.calls.filter((c) => c.method === 'setLineWidth').map((c) => c.args[0]);

    // Reference: call drawStrokeSegment directly against the SAME final
    // element for every segment, onto a fresh canvas -- exactly what
    // renderScene() would compute for this one (mature, unchanging)
    // element. If baking matches this, the taper is correct.
    const reference = createMockCanvas();
    for (let i = 0; i < finalPoints.length - 1; i++) {
      drawStrokeSegment(reference, finalStroke, i, CANVAS_SIZE.height);
    }
    const referenceLineWidths = reference.calls.filter((c) => c.method === 'setLineWidth').map((c) => c.args[0]);

    expect(bakedLineWidths).toEqual(referenceLineWidths);
    // Sanity: this element genuinely tapers (baseWidth 0.05, taperExponent
    // 1) -- the first segment must be measurably wider than the last, so
    // this isn't a vacuous all-equal-width comparison.
    expect(bakedLineWidths[0]).toBeGreaterThan(bakedLineWidths[bakedLineWidths.length - 1]!);
  });

  it('a non-final stroke is redrawn every frame (not baked); it gets baked exactly once the frame it turns final, and zero times after', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const allPoints = Array.from({ length: 6 }, (_, i) => ({ x: i * 0.1, y: 0.5 })); // 6 points -> 5 segments once final

    for (let n = 2; n <= 5; n++) {
      compositor.renderFrame(
        [{ layerId: 'fg0', elements: [makeStroke(allPoints.slice(0, n), { final: false })] }],
        dest,
        CANVAS_SIZE,
        'seed-lifecycle',
      );
    }
    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(0); // never baked while growing

    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [makeStroke(allPoints, { final: true })] }],
      dest,
      CANVAS_SIZE,
      'seed-lifecycle',
    );
    expect(foregroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(5); // baked once, in full

    for (let i = 0; i < 3; i++) {
      compositor.renderFrame(
        [{ layerId: 'fg0', elements: [makeStroke(allPoints, { final: true })] }],
        dest,
        CANVAS_SIZE,
        'seed-lifecycle',
      );
    }
    expect(foregroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(5); // never rebaked
  });
});

describe('createLiveCompositor — bake-exactly-once for circles (unaffected by the taper fix)', () => {
  it('blossom (circle) elements are each drawn exactly once total, even as more are appended over many frames', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const TOTAL_BLOSSOMS = 15;
    for (let frame = 1; frame <= TOTAL_BLOSSOMS; frame++) {
      const circles = Array.from({ length: frame }, (_, i) => makeCircle({ x: i * 0.05 }));
      const layers: SceneLayer[] = [{ layerId: 'fg0', elements: circles }];
      compositor.renderFrame(layers, dest, CANVAS_SIZE, 'seed-b');
    }

    const foregroundBuffer = factory.createdBuffers[2]!;
    const fillCalls = foregroundBuffer.calls.filter((c) => c.method === 'fill');
    expect(fillCalls).toHaveLength(TOTAL_BLOSSOMS);
  });

  it('an unchanged circle element costs zero further draw calls across many frames', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();
    const layers: SceneLayer[] = [{ layerId: 'fg0', elements: [makeCircle()] }];

    compositor.renderFrame(layers, dest, CANVAS_SIZE, 'seed-c');
    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      compositor.renderFrame(layers, dest, CANVAS_SIZE, 'seed-c');
    }
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1);
  });

  it('mixed strokes-then-circles emission order (Botanical\'s own shape) still bakes every final stroke and every circle exactly once, even once a new final stroke keeps appending after circles already exist', () => {
    // Reproduces the real Botanical shape this fix targets: a layer whose
    // elements array is [stroke, stroke, circle, circle, ...], where a NEW
    // final stroke can be appended well after some circles already exist --
    // i.e. the new stroke's raw array position does NOT land after all
    // existing circles. Per-kind index tracking (see live-compositor.ts's
    // own doc comment) must still bake everything exactly once.
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const strokeA = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
        { x: 0.2, y: 0.5 },
      ],
      { final: true },
    );
    const circle1 = makeCircle({ x: 0.15 });
    const circle2 = makeCircle({ x: 0.16 });

    compositor.renderFrame([{ layerId: 'fg0', elements: [strokeA, circle1, circle2] }], dest, CANVAS_SIZE, 'seed-d');

    const strokeB = makeStroke(
      [
        { x: 0.2, y: 0.5 },
        { x: 0.3, y: 0.5 },
      ],
      { final: true },
    );
    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [strokeA, strokeB, circle1, circle2] }],
      dest,
      CANVAS_SIZE,
      'seed-d',
    );

    const foregroundBuffer = factory.createdBuffers[2]!;
    // strokeA: 2 segments, strokeB: 1 segment => 3 stroke() calls total.
    expect(foregroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(3);
    // circle1 + circle2 => exactly 2 fill() calls total, not re-baked.
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(2);
  });
});

describe('createLiveCompositor — revealed-but-not-yet-safe circles are drawn live, not invisible (session 021)', () => {
  // Session 021 (docs/HANDOFF.md): before this, a circle had no `final`
  // concept at all -- it was baked unconditionally the instant it appeared,
  // because reveal itself was gated on bake-order safety (so a "revealed"
  // circle was already known-safe by construction). That coupling caused a
  // real founder-reported regression (blossoms invisible until their area
  // scrolled off-screen) once session 020's more conservative bake-safety
  // bound made the invisibility window large. Reveal and bake-safety are
  // now decoupled: a circle can be `final: false` (revealed, visible,
  // not yet safe to permanently bake) exactly like a still-growing stroke.

  it('a non-final circle is drawn fresh on destCtx every frame (never baked) -- visible immediately, exactly like a blocked stroke', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();
    const layers: SceneLayer[] = [{ layerId: 'fg0', elements: [makeCircle({ final: false, color: 'blocked-circle' })] }];

    for (let i = 0; i < 5; i++) {
      compositor.renderFrame(layers, dest, CANVAS_SIZE, 'seed-live-circle');
    }

    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(0); // never baked
    // Drawn fresh onto destCtx every single frame it stays non-final.
    expect(dest.calls.filter((c) => c.method === 'setFillStyle' && c.args[0] === 'blocked-circle')).toHaveLength(5);
  });

  it('once a circle flips to final: true, it bakes exactly once and stops being drawn live', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();
    const circle = makeCircle({ final: false, color: 'now-safe' });

    compositor.renderFrame([{ layerId: 'fg0', elements: [circle] }], dest, CANVAS_SIZE, 'seed-flip');
    compositor.renderFrame([{ layerId: 'fg0', elements: [circle] }], dest, CANVAS_SIZE, 'seed-flip');
    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(0);

    circle.final = true; // mirrors botanical.ts flipping blossom.bakeResolved -> emitGrowthSystem's `final`
    compositor.renderFrame([{ layerId: 'fg0', elements: [circle] }], dest, CANVAS_SIZE, 'seed-flip');
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1); // baked exactly once

    for (let i = 0; i < 3; i++) {
      compositor.renderFrame([{ layerId: 'fg0', elements: [circle] }], dest, CANVAS_SIZE, 'seed-flip');
    }
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1); // never rebaked
  });

  it('non-final circles are z-sorted together with non-final strokes when drawn live (mixed kinds, one bucket)', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const nearCircle = makeCircle({ final: false, z: 0.1, color: 'near-live-circle' });
    const farStroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      { final: false, z: 0.9, color: 'far-live-stroke' },
    );

    // Circle listed first, on purpose -- the farther stroke must still draw
    // first (i.e. underneath) regardless of array order.
    compositor.renderFrame([{ layerId: 'fg0', elements: [nearCircle, farStroke] }], dest, CANVAS_SIZE, 'seed-live-z');

    const paintEvents = dest.calls
      .filter((c) => c.method === 'setStrokeStyle' || c.method === 'setFillStyle')
      .map((c) => c.args[0]);
    expect(paintEvents).toContain('far-live-stroke');
    expect(paintEvents).toContain('near-live-circle');
    expect(paintEvents.indexOf('far-live-stroke')).toBeLessThan(paintEvents.indexOf('near-live-circle'));
  });

  it('the in-order bake constraint (LayerBakeState.circlesBaked): a later circle that is already final cannot bake ahead of an earlier, still-blocked one in the same layer', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const blockedFirst = makeCircle({ final: false, color: 'blocked-first' });
    const safeSecond = makeCircle({ final: true, color: 'safe-second' });

    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [blockedFirst, safeSecond] }],
      dest,
      CANVAS_SIZE,
      'seed-in-order',
    );

    const foregroundBuffer = factory.createdBuffers[2]!;
    // Neither bakes: circlesBaked stays 0 (blockedFirst, index 0, isn't
    // final), so index 1 (safeSecond) -- despite itself being final -- is
    // not the "next in the contiguous prefix" and is correctly withheld
    // too. Both are still visible, though: drawn live via drawLiveElements.
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(0);
    expect(dest.calls.filter((c) => c.method === 'setFillStyle' && c.args[0] === 'blocked-first')).toHaveLength(1);
    expect(dest.calls.filter((c) => c.method === 'setFillStyle' && c.args[0] === 'safe-second')).toHaveLength(1);

    // Once the first one also resolves safe, BOTH bake in one pass (in
    // z-order among themselves, same as any other same-frame batch).
    blockedFirst.final = true;
    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [blockedFirst, safeSecond] }],
      dest,
      CANVAS_SIZE,
      'seed-in-order',
    );
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(2);
  });
});

describe('createLiveCompositor — canvas growth', () => {
  it('grows every persistent buffer (echo1, echo0, foreground) when canvasSize widens, before baking that frame\'s content', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame([], dest, { width: 200, height: 100 }, 'seed-e');
    expect(factory.growCalls).toHaveLength(0); // first frame creates buffers, doesn't grow them

    compositor.renderFrame([], dest, { width: 400, height: 100 }, 'seed-e');
    expect(factory.growCalls).toHaveLength(3); // all 3 buffers grown, even though no layer touched them
    expect(factory.growCalls.map((c) => c.size)).toEqual([
      { width: 400, height: 100 },
      { width: 400, height: 100 },
      { width: 400, height: 100 },
    ]);
  });

  it('does not call growTo when canvasSize is unchanged or narrower', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame([], dest, { width: 400, height: 100 }, 'seed-f');
    compositor.renderFrame([], dest, { width: 400, height: 100 }, 'seed-f');
    compositor.renderFrame([], dest, { width: 300, height: 100 }, 'seed-f');
    expect(factory.growCalls).toHaveLength(0);
  });

  it('previously-baked draw-call history on a buffer survives a growTo call (old content is not lost)', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [makeCircle()] }],
      dest,
      { width: 200, height: 100 },
      'seed-g',
    );
    const foregroundBuffer = factory.createdBuffers[2]!;
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1);

    // Canvas widens -- growTo fires, but the fake's own bookkeeping never
    // clears `calls`, modeling growTo's "preserve existing content" contract.
    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [makeCircle()] }],
      dest,
      { width: 500, height: 100 },
      'seed-g',
    );
    expect(factory.growCalls.some((c) => c.bufferIndex === 2)).toBe(true);
    expect(foregroundBuffer.calls.filter((c) => c.method === 'fill')).toHaveLength(1); // still there, not re-baked, not lost
  });
});

describe('createLiveCompositor — layer-to-bucket mapping and paint order', () => {
  it('all non-echo layerIds (fg0, fg1, ...) share one foreground buffer; echo0/echo1 each get their own', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame(
      [
        { layerId: 'fg0', elements: [makeCircle({ color: 'fg0-color' })] },
        { layerId: 'fg1', elements: [makeCircle({ color: 'fg1-color' })] },
        { layerId: 'echo0', elements: [makeCircle({ color: 'echo0-color' })] },
        { layerId: 'echo1', elements: [makeCircle({ color: 'echo1-color' })] },
      ],
      dest,
      CANVAS_SIZE,
      'seed-h',
    );

    expect(factory.createdBuffers).toHaveLength(3); // echo1, echo0, foreground -- always exactly 3
    const [echo1Buffer, echo0Buffer, foregroundBuffer] = factory.createdBuffers;
    const fillStylesOf = (buf: CanvasLike & { calls: RecordedCall[] }) =>
      buf.calls.filter((c) => c.method === 'setFillStyle').map((c) => c.args[0]);

    expect(fillStylesOf(echo1Buffer!)).toEqual(['echo1-color']);
    expect(fillStylesOf(echo0Buffer!)).toEqual(['echo0-color']);
    // fg0 and fg1 both land on the SAME shared foreground buffer.
    expect(fillStylesOf(foregroundBuffer!)).toEqual(['fg0-color', 'fg1-color']);
  });

  it('blits back-to-front in echo1, echo0, foreground order, after painting the paper ground', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame([{ layerId: 'fg0', elements: [] }], dest, CANVAS_SIZE, 'seed-i');

    expect(factory.blitOrder).toEqual([0, 1, 2]); // echo1, echo0, foreground -- creation-order indices
    // Paper ground paints directly onto destCtx before any blit -- its base
    // fillRect must appear before every recorded call on dest that isn't
    // itself part of paper-ground's own texture passes. Cheapest check:
    // dest received at least one fillRect (paper-ground's base fill) at all.
    expect(dest.calls.some((c) => c.method === 'fillRect')).toBe(true);
  });

  it('a still-growing (non-final) stroke in echo0 is drawn onto destCtx after echo0\'s own blit but before the foreground bucket is blitted -- not lumped together at the very end', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    compositor.renderFrame(
      [
        {
          layerId: 'echo0',
          elements: [
            makeStroke(
              [
                { x: 0, y: 0.5 },
                { x: 0.1, y: 0.5 },
              ],
              { final: false, color: 'echo0-growing' },
            ),
          ],
        },
        { layerId: 'fg0', elements: [] },
      ],
      dest,
      CANVAS_SIZE,
      'seed-order',
    );

    const orderedEvents = dest.calls
      .filter((c) => c.method === 'blitTo' || (c.method === 'setStrokeStyle' && c.args[0] === 'echo0-growing'))
      .map((c) => (c.method === 'blitTo' ? `blit:${c.args[0]}` : 'echo0-live-stroke'));

    // blit:0 = echo1, blit:1 = echo0, then echo0's own still-growing stroke
    // paints on top of echo0's freshly-blitted content, and only THEN does
    // foreground (blit:2) get composited over both.
    expect(orderedEvents).toEqual(['blit:0', 'blit:1', 'echo0-live-stroke', 'blit:2']);
  });
});

describe('createLiveCompositor — z-order paint fix (docs/HANDOFF.md: "branches poof disappear" / "blossoms burst all at once")', () => {
  // Order-of-drawing is inferred from `setStrokeStyle`/`setFillStyle` calls
  // recorded on the shared foreground buffer -- each element below uses a
  // distinct color/tag so the trace unambiguously shows which element's
  // paint calls happened first.

  it('two elements from DIFFERENT layers sharing the foreground bucket, with different z, newly-bakeable in the same frame, are baked farthest-z-first regardless of which layer is listed first', () => {
    const nearStroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      { final: true, z: 0.1, color: 'near' },
    );
    const farStroke = makeStroke(
      [
        { x: 0, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
      { final: true, z: 0.9, color: 'far' },
    );

    // Pass 1: far-z layer listed FIRST.
    {
      const factory = createFakeBufferFactory();
      const compositor = createLiveCompositor(factory);
      compositor.renderFrame(
        [
          { layerId: 'fg1', elements: [farStroke] },
          { layerId: 'fg0', elements: [nearStroke] },
        ],
        DEST(),
        CANVAS_SIZE,
        'seed-z-order-a',
      );
      const foregroundBuffer = factory.createdBuffers[2]!;
      const strokeStyles = foregroundBuffer.calls
        .filter((c) => c.method === 'setStrokeStyle')
        .map((c) => c.args[0]);
      expect(strokeStyles).toEqual(['far', 'near']);
    }

    // Pass 2: near-z layer listed FIRST -- must draw in the same z-order
    // regardless, proving it's not an array-order coincidence.
    {
      const factory = createFakeBufferFactory();
      const compositor = createLiveCompositor(factory);
      compositor.renderFrame(
        [
          { layerId: 'fg0', elements: [nearStroke] },
          { layerId: 'fg1', elements: [farStroke] },
        ],
        DEST(),
        CANVAS_SIZE,
        'seed-z-order-b',
      );
      const foregroundBuffer = factory.createdBuffers[2]!;
      const strokeStyles = foregroundBuffer.calls
        .filter((c) => c.method === 'setStrokeStyle')
        .map((c) => c.args[0]);
      expect(strokeStyles).toEqual(['far', 'near']);
    }
  });

  it('two elements WITHIN the same layer (e.g. two forked strokes with different childZJitter), newly-bakeable in the same frame, are baked farthest-z-first', () => {
    const nearStroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      { final: true, z: 0.2, color: 'near-child' },
    );
    const farStroke = makeStroke(
      [
        { x: 0, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
      { final: true, z: 0.8, color: 'far-child' },
    );

    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    // near-child listed FIRST in the layer's own elements array -- if paint
    // order still followed raw iteration order, 'near-child' would draw
    // before 'far-child', which would be wrong (near should paint LAST/on
    // top of far, i.e. far must draw first).
    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [nearStroke, farStroke] }],
      DEST(),
      CANVAS_SIZE,
      'seed-z-order-same-layer',
    );

    const foregroundBuffer = factory.createdBuffers[2]!;
    const strokeStyles = foregroundBuffer.calls.filter((c) => c.method === 'setStrokeStyle').map((c) => c.args[0]);
    expect(strokeStyles).toEqual(['far-child', 'near-child']);
  });

  it('a stroke and a circle newly-bakeable in the same frame with different z are baked together in z-order, not strokes-then-circles or circles-then-strokes', () => {
    const nearCircle = makeCircle({ z: 0.1, color: 'near-circle' });
    const farStroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      { final: true, z: 0.9, color: 'far-stroke' },
    );

    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    // Circle listed first in the layer's elements array (Botanical's own
    // stroke-then-circle emission shape is inverted here on purpose) -- the
    // farther stroke must still draw before the nearer circle.
    compositor.renderFrame(
      [{ layerId: 'fg0', elements: [nearCircle, farStroke] }],
      DEST(),
      CANVAS_SIZE,
      'seed-z-order-mixed',
    );

    const foregroundBuffer = factory.createdBuffers[2]!;
    const paintEvents = foregroundBuffer.calls
      .filter((c) => c.method === 'setStrokeStyle' || c.method === 'setFillStyle')
      .map((c) => c.args[0]);
    expect(paintEvents).toEqual(['far-stroke', 'near-circle']);
  });
});

describe('createLiveCompositor — reset', () => {
  it('clears tracked bake-state and persistent buffers, so a re-appearing final stroke gets baked again (simulating a fresh session)', () => {
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const stroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
        { x: 0.2, y: 0.5 },
      ],
      { final: true },
    );
    compositor.renderFrame([{ layerId: 'fg0', elements: [stroke] }], dest, CANVAS_SIZE, 'seed-j');
    expect(factory.createdBuffers).toHaveLength(3);
    const firstForegroundBuffer = factory.createdBuffers[2]!;
    expect(firstForegroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(2);

    compositor.reset();

    // Same exact final stroke, same layerId, "reappearing" after reset -- a
    // fresh session's own first frame would look exactly like this.
    compositor.renderFrame([{ layerId: 'fg0', elements: [stroke] }], dest, CANVAS_SIZE, 'seed-j');

    // reset() discarded the old buffers entirely: 3 more got created.
    expect(factory.createdBuffers).toHaveLength(6);
    const secondForegroundBuffer = factory.createdBuffers[5]!;
    // The same 2 segments get baked again onto the brand-new buffer -- proof
    // reset() actually cleared the tracked "already baked" state, not just
    // the buffers.
    expect(secondForegroundBuffer.calls.filter((c) => c.method === 'stroke')).toHaveLength(2);
  });
});

describe('createLiveCompositor — globalAlpha invariant (session 024, docs/HANDOFF.md)', () => {
  it("a low-alpha live element in an EARLIER bucket does not leak its globalAlpha into a LATER bucket's blitTo call -- the exact mechanism behind the founder-reported 'whole branch segments vanish in a single step' bug", () => {
    // Reproduces session 024's forensic trace precisely: echo1 draws a
    // still-growing (non-final) element with a very low opacity --
    // drawCircleElement/drawStrokeSegment (render-scene.ts) set
    // `ctx.globalAlpha` to exactly that value and, pre-fix, nothing ever
    // reset it afterward. A real `blitTo` (main.ts's DOM implementation,
    // render-divergence-harness.ts's Node one) is a bare `drawImage` that
    // composites using WHATEVER `globalAlpha` its target already holds --
    // this fake's blitAlphas records exactly that value, so this test can
    // assert what a real blit would have done without needing a real
    // canvas (this file's own established convention -- see its top
    // comment).
    const factory = createFakeBufferFactory();
    const compositor = createLiveCompositor(factory);
    const dest = DEST();

    const fadedLiveCircle = makeCircle({ final: false, opacity: 0.05, color: 'faded-echo-circle' });
    const bakedStroke = makeStroke(
      [
        { x: 0, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      { final: true, color: 'baked-foreground-stroke' },
    );

    compositor.renderFrame(
      [
        { layerId: 'echo1', elements: [fadedLiveCircle] },
        { layerId: 'fg0', elements: [bakedStroke] },
      ],
      dest,
      CANVAS_SIZE,
      'seed-alpha-leak',
    );

    // Sanity: the leak precondition genuinely existed this frame -- echo1's
    // own low-opacity live circle really was drawn onto `dest` (otherwise
    // this test would trivially pass for the wrong reason).
    expect(dest.calls.some((c) => c.method === 'setFillStyle' && c.args[0] === 'faded-echo-circle')).toBe(true);

    // blitOrder/blitAlphas are index-aligned, in creation order (echo1=0,
    // echo0=1, foreground=2 -- see createFakeBufferFactory's own doc
    // comment); the foreground bucket's own blit is what composites
    // `bakedStroke` onto `dest`. Pre-fix, this read 0.05 (the leaked echo1
    // circle's own alpha) -- a real blitTo would have rendered the whole
    // foreground buffer at 5% opacity, visually indistinguishable from
    // "vanished" against a light paper background.
    const foregroundBlitIndex = factory.blitOrder.indexOf(2);
    expect(foregroundBlitIndex).toBeGreaterThanOrEqual(0);
    expect(factory.blitAlphas[foregroundBlitIndex]).toBe(1);
  });
});
