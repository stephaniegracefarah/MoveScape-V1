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
  globalAlpha: number;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
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

/**
 * Clears the canvas, then paints each scene element as a filled circle,
 * farthest (largest z) first so nearer elements paint over farther ones,
 * applying a simple depth fade to opacity and radius as it goes.
 */
export function renderScene(ctx: CanvasLike, scene: Scene, canvasSize: CanvasSize): void {
  ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);

  // Sort a copy -- never mutate the style's own scene.elements array.
  const farthestFirst = [...scene.elements].sort((a, b) => b.z - a.z);
  const shorterSide = Math.min(canvasSize.width, canvasSize.height);

  for (const element of farthestFirst) {
    const displayOpacity = clamp01(element.opacity * (1 - element.z * DEPTH_OPACITY_FALLOFF));
    const displayRadiusPx = element.radius * (1 - element.z * DEPTH_RADIUS_FALLOFF) * shorterSide;

    ctx.globalAlpha = displayOpacity;
    ctx.fillStyle = element.color;
    ctx.beginPath();
    ctx.arc(element.x * canvasSize.width, element.y * canvasSize.height, displayRadiusPx, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Leave the context in a clean state for whatever draws next.
  ctx.globalAlpha = 1;
}
