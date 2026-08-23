/**
 * The compositor (spec Part 3, invariant 8): a depth-sort-fade-composite
 * loop, nothing fancier. No scene graphs, no per-layer accumulate/redraw
 * architecture -- that's deferred to whichever future milestone (Botanical)
 * actually needs it.
 *
 * Coordinate convention (spec Part 3, "Composition and canvas" -- "the
 * Scroll"): a SceneElement's `y` is normalized 0-1, a fraction of the
 * canvas's fixed height. Its `x` is different: it is in *world units*,
 * where 1 world unit = 1 canvas height in pixels. `x` is unbounded
 * rightward as a piece grows (0, 2, 20, whatever) and is NOT related to
 * canvasSize.width at all -- the canvas is expected to be resized (by the
 * caller, via computeCanvasSize below) to fit however far content has
 * grown, not the other way around.
 */
import { clamp01 } from '../shared/math';
import type { CircleElement, Scene, StrokeElement } from '../styles/style-renderer';

/**
 * A hand-written structural interface, not a DOM type -- this module never
 * imports lib.dom's CanvasRenderingContext2D or any canvas library. Mirrors
 * the WorkerScope pattern in src/adapters/webcam/pose-worker.ts: a real
 * CanvasRenderingContext2D satisfies this shape with zero casting, and so
 * does any test-time canvas mock or library, without this file depending on
 * either.
 */
export interface CanvasLike {
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  lineWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fill(): void;
  stroke(): void;
}

/**
 * The pixel dimensions renderScene paints into.
 *
 * `height` is the fixed, permanent world-to-pixel scale (1 world unit = 1
 * canvas height in pixels, see the coordinate-convention note above) -- it
 * does not change as a piece grows, which is exactly what makes "permanent
 * ink" (docs/styles/botanical.md section 7) possible: a mark's pixel
 * position, once drawn, never moves.
 *
 * `width` is derived from content and unbounded: it is however wide the
 * canvas currently needs to be to fit everything drawn so far, typically
 * computed by computeCanvasSize below and grown by the caller as the piece
 * expands rightward. It never participates in position or size scaling.
 */
export interface CanvasSize {
  width: number;
  height: number;
}

// The entire "atmospheric depth" effect for this placeholder-grade
// compositor: two independent linear fades from z=0 (full opacity/radius)
// to z=1 (15% opacity, 40% radius). Nothing fancier than that.
const DEPTH_OPACITY_FALLOFF = 0.85;
const DEPTH_RADIUS_FALLOFF = 0.6;

/** A stroke element's width never renders thinner than this, so tapered tips stay visible hairlines rather than vanishing at exactly 0. */
const MIN_STROKE_WIDTH_PX = 0.5;

/**
 * Draws one circle element (fill plus its optional ring-outline detail) onto
 * `ctx`, at `worldUnitPx` (the world-to-pixel scale -- always
 * canvasSize.height, see the coordinate-convention doc comment above).
 * Extracted so both renderScene (a full-redraw of every element, every
 * call) and src/compositor/live-compositor.ts (which bakes a circle exactly
 * once, the first frame it appears) share the identical depth/ring math --
 * neither reimplements it. Pure with respect to `element`/`worldUnitPx`;
 * only `ctx` is mutated.
 */
export function drawCircleElement(ctx: CanvasLike, element: CircleElement, worldUnitPx: number): void {
  const displayOpacity = clamp01(element.opacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));
  const displayRadiusPx = element.radius * (1 - element.z * DEPTH_RADIUS_FALLOFF) * worldUnitPx;

  ctx.globalAlpha = displayOpacity;
  ctx.fillStyle = element.color;
  ctx.beginPath();
  ctx.arc(element.x * worldUnitPx, element.y * worldUnitPx, displayRadiusPx, 0, 2 * Math.PI);
  ctx.fill();

  if (element.ringColor !== undefined) {
    const ringBaseOpacity = element.ringOpacity ?? element.opacity;
    const ringDisplayOpacity = clamp01(ringBaseOpacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));
    ctx.globalAlpha = ringDisplayOpacity;
    ctx.strokeStyle = element.ringColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(element.x * worldUnitPx, element.y * worldUnitPx, displayRadiusPx, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

/**
 * Draws one stroke element's segment `[i, i+1]` onto `ctx`, at `worldUnitPx`
 * -- the taper/depth-fade math for a single segment, in isolation. Extracted
 * so both renderScene (which calls this for every segment of every stroke,
 * full-redraw) and live-compositor.ts (which calls this only for a growing
 * stroke's newly-added tail segments) share the identical taper formula
 * (docs/styles/botanical.md section 1) rather than either reimplementing
 * it. Pure with respect to `element`/`i`/`worldUnitPx`; only `ctx` is
 * mutated. Requires `element.points.length >= 2` and `0 <= i <
 * element.points.length - 1`.
 */
export function drawStrokeSegment(ctx: CanvasLike, element: StrokeElement, i: number, worldUnitPx: number): void {
  const lastIndex = element.points.length - 1;
  const tStart = i / lastIndex;
  const tEnd = (i + 1) / lastIndex;
  const widthStart = element.baseWidth * (1 - tStart) ** element.taperExponent;
  const widthEnd = element.baseWidth * (1 - tEnd) ** element.taperExponent;
  const segmentWidth = (widthStart + widthEnd) / 2;
  const displayOpacity = clamp01(element.opacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));
  const displayWidthPx = Math.max(
    MIN_STROKE_WIDTH_PX,
    segmentWidth * (1 - element.z * DEPTH_RADIUS_FALLOFF) * worldUnitPx,
  );

  const p0 = element.points[i]!;
  const p1 = element.points[i + 1]!;

  ctx.globalAlpha = displayOpacity;
  ctx.strokeStyle = element.color;
  ctx.lineCap = 'round';
  ctx.lineWidth = displayWidthPx;
  ctx.beginPath();
  ctx.moveTo(p0.x * worldUnitPx, p0.y * worldUnitPx);
  ctx.lineTo(p1.x * worldUnitPx, p1.y * worldUnitPx);
  ctx.stroke();
}

/**
 * Paints each scene element -- circles and tapered strokes alike -- farthest
 * (largest z) first so nearer elements paint over farther ones, applying a
 * simple depth fade to opacity and radius/width as it goes.
 *
 * Does NOT clear the canvas itself: that responsibility belongs to the
 * caller (e.g. via renderPaperGround, see ../compositor/paper-ground.ts), so
 * a caller that wants to paint a textured background before compositing
 * isn't at risk of renderScene silently clearing over it.
 */
export function renderScene(ctx: CanvasLike, scene: Scene, canvasSize: CanvasSize): void {
  // Sort a copy -- never mutate the style's own scene.elements array.
  const farthestFirst = [...scene.elements].sort((a, b) => b.z - a.z);
  // The fixed world-to-pixel scale: 1 world unit = 1 canvas height in
  // pixels. Deliberately keyed to height alone, never width -- width is
  // derived from content and grows over a session, so scaling by it would
  // make every existing mark's pixel position drift each time the canvas
  // widens (breaking "permanent ink", docs/styles/botanical.md section 7).
  const worldUnitPx = canvasSize.height;

  for (const element of farthestFirst) {
    if (element.kind === 'circle') {
      drawCircleElement(ctx, element, worldUnitPx);
    } else {
      const lastIndex = element.points.length - 1;
      for (let i = 0; i < lastIndex; i++) {
        drawStrokeSegment(ctx, element, i, worldUnitPx);
      }
    }
  }

  // Leave the context in a clean state for whatever draws next.
  ctx.globalAlpha = 1;
}

/** How far past the growth front to keep visible/exportable canvas, in world units (1 unit = 1 canvas height). */
export const WORLD_WIDTH_PADDING_UNITS = 0.3;
/** The canvas never starts (or shrinks to) narrower than it is tall. */
export const MIN_WORLD_WIDTH_UNITS = 1;

/**
 * Computes the canvas pixel size needed to fit `scene` at a fixed height
 * of `heightPx`. Finds the farthest-right point any element reaches (a
 * circle's x + radius; a stroke's farthest point.x), in world units, and
 * converts to a canvas width in pixels via the same worldUnitPx = heightPx
 * scale renderScene itself uses -- so a Scene rendered through this
 * computed CanvasSize always has room for everything in it, with a little
 * padding past the growth front.
 */
export function computeCanvasSize(scene: Scene, heightPx: number): CanvasSize {
  let maxX = 0;
  for (const element of scene.elements) {
    if (element.kind === 'circle') {
      maxX = Math.max(maxX, element.x + element.radius);
    } else {
      for (const point of element.points) {
        maxX = Math.max(maxX, point.x);
      }
    }
  }
  const worldWidthUnits = Math.max(MIN_WORLD_WIDTH_UNITS, maxX + WORLD_WIDTH_PADDING_UNITS);
  return { width: Math.round(worldWidthUnits * heightPx), height: heightPx };
}
