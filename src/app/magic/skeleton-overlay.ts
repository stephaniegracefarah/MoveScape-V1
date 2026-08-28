/**
 * "Show the magic" pose-skeleton overlay (UX Stage 2). Draws the tracked
 * body skeleton on a transparent <canvas> layered over the camera-preview
 * <video> in the PiP. Purely a UI affordance -- it reads the adapter's
 * `latestPose()` each animation frame and never feeds anything back into
 * tracking (invariant 1). Only drawn while the panel is shown AND the
 * preview is visible; the caller gates that via `setActive`.
 *
 * Style guide: lines in `--ink`, thin, ~70% opacity -- no colour (colour
 * belongs to the artwork only).
 *
 * The preview <video> is CSS-mirrored (`transform: scaleX(-1)` in main.ts),
 * while MediaPipe landmarks are unmirrored image-frame coords. The overlay
 * canvas carries the same `scaleX(-1)` transform so lines drawn in raw
 * landmark space line up with what the viewer sees.
 */
import type { PosePoint } from '../../adapters/input-adapter';

/**
 * Standard MediaPipe Pose landmark connection pairs, body only. The 11 face
 * landmarks (0-10) are deliberately skipped -- they add visual noise without
 * saying anything about how the body is moving. Indices match
 * params-from-landmarks.ts's POSE_LANDMARK map.
 */
export const POSE_CONNECTIONS: readonly (readonly [number, number])[] = [
  // shoulders + torso box
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  // left arm + hand
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  // right arm + hand
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  // left leg + foot
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  // right leg + foot
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
];

/** One skeleton line segment, in device pixels within the overlay canvas. */
export interface SkeletonSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * The subset of CanvasRenderingContext2D drawSkeleton needs -- kept minimal
 * (mirrors compositor/render-scene.ts's CanvasLike) so it's drivable by a
 * plain stub in tests without a real canvas / jsdom.
 */
export interface SkeletonCtx {
  strokeStyle: string;
  lineWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  globalAlpha: number;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

const INK = '#241a17';

/**
 * Pure geometry: the skeleton line segments for `pose` scaled into a
 * `width` x `height` box. Returns `[]` for a null / too-short pose (fewer
 * than 33 landmarks means MediaPipe hasn't produced a full detection).
 */
export function skeletonSegments(
  pose: readonly PosePoint[] | null,
  width: number,
  height: number,
): SkeletonSegment[] {
  if (!pose || pose.length < 33) return [];
  const segments: SkeletonSegment[] = [];
  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = pose[a];
    const pb = pose[b];
    if (!pa || !pb) continue;
    segments.push({ ax: pa.x * width, ay: pa.y * height, bx: pb.x * width, by: pb.y * height });
  }
  return segments;
}

/**
 * Renders (or clears) the skeleton onto `ctx`. Always clears the whole
 * `width` x `height` box first; only strokes when `active` and `pose` yield
 * at least one segment. Pure w.r.t. its args aside from the `ctx` mutations.
 */
export function drawSkeleton(
  ctx: SkeletonCtx,
  pose: readonly PosePoint[] | null,
  opts: { active: boolean; width: number; height: number },
): void {
  ctx.clearRect(0, 0, opts.width, opts.height);
  if (!opts.active) return;
  const segments = skeletonSegments(pose, opts.width, opts.height);
  if (segments.length === 0) return;

  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (const s of segments) {
    ctx.moveTo(s.ax, s.ay);
    ctx.lineTo(s.bx, s.by);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export interface SkeletonOverlay {
  /** Redraw for the newest pose (or clear, when pose is null/partial). */
  draw(pose: readonly PosePoint[] | null): void;
  /** Gate drawing on/off. While false, `draw` only clears. */
  setActive(active: boolean): void;
  destroy(): void;
}

/**
 * Mounts a transparent overlay canvas into `mountInto` (the element that
 * holds the preview <video>) and returns its draw/activate API. `mountInto`
 * is made `position: relative` so the absolutely-positioned canvas tracks
 * it; the canvas mirrors the video's CSS `scaleX(-1)`.
 */
export function createSkeletonOverlay(mountInto: HTMLElement): SkeletonOverlay {
  if (getComputedStyle(mountInto).position === 'static') {
    mountInto.style.position = 'relative';
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;transform:scaleX(-1);pointer-events:none;z-index:2;';
  mountInto.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let active = false;

  function sizeToBox(): { width: number; height: number } {
    const width = mountInto.clientWidth || canvas.width || 0;
    const height = mountInto.clientHeight || canvas.height || 0;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return { width, height };
  }

  return {
    draw(pose: readonly PosePoint[] | null): void {
      if (!ctx) return;
      const { width, height } = sizeToBox();
      drawSkeleton(ctx as unknown as SkeletonCtx, pose, { active, width, height });
    },
    setActive(next: boolean): void {
      active = next;
    },
    destroy(): void {
      canvas.remove();
    },
  };
}
