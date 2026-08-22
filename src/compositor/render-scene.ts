/**
 * The compositor (spec Part 3, invariant 8): a depth-sort-fade-composite
 * loop, nothing fancier. No scene graphs, no per-layer accumulate/redraw
 * architecture -- that's deferred to whichever future milestone (Botanical)
 * actually needs it.
 */
import { clamp01 } from '../shared/math';
import type { Scene } from '../styles/style-renderer';

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
  const shorterSide = Math.min(canvasSize.width, canvasSize.height);

  for (const element of farthestFirst) {
    const displayOpacity = clamp01(element.opacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));

    if (element.kind === 'circle') {
      const displayRadiusPx = element.radius * (1 - element.z * DEPTH_RADIUS_FALLOFF) * shorterSide;

      ctx.globalAlpha = displayOpacity;
      ctx.fillStyle = element.color;
      ctx.beginPath();
      ctx.arc(element.x * canvasSize.width, element.y * canvasSize.height, displayRadiusPx, 0, 2 * Math.PI);
      ctx.fill();

      if (element.ringColor !== undefined) {
        const ringBaseOpacity = element.ringOpacity ?? element.opacity;
        const ringDisplayOpacity = clamp01(ringBaseOpacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));
        ctx.globalAlpha = ringDisplayOpacity;
        ctx.strokeStyle = element.ringColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(element.x * canvasSize.width, element.y * canvasSize.height, displayRadiusPx, 0, 2 * Math.PI);
        ctx.stroke();
      }
    } else {
      const pixelPoints = element.points.map((p) => ({ x: p.x * canvasSize.width, y: p.y * canvasSize.height }));
      const lastIndex = pixelPoints.length - 1;

      ctx.globalAlpha = displayOpacity;
      ctx.strokeStyle = element.color;
      ctx.lineCap = 'round';

      for (let i = 0; i < lastIndex; i++) {
        const tStart = i / lastIndex;
        const tEnd = (i + 1) / lastIndex;
        const widthStart = element.baseWidth * (1 - tStart) ** element.taperExponent;
        const widthEnd = element.baseWidth * (1 - tEnd) ** element.taperExponent;
        const segmentWidth = (widthStart + widthEnd) / 2;
        const displayWidthPx = Math.max(
          MIN_STROKE_WIDTH_PX,
          segmentWidth * (1 - element.z * DEPTH_RADIUS_FALLOFF) * shorterSide,
        );

        const p0 = pixelPoints[i]!;
        const p1 = pixelPoints[i + 1]!;

        ctx.lineWidth = displayWidthPx;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }
  }

  // Leave the context in a clean state for whatever draws next.
  ctx.globalAlpha = 1;
}
