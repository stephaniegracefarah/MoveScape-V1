/**
 * The high-resolution session-end export path (founder backlog: exported
 * PNGs were pixelated when zoomed, because image-export.ts's
 * exportCanvasAsPng was just re-encoding the live on-screen canvas's own
 * pixels -- fixed at CANVAS_HEIGHT_PX (480px) display scale). This module
 * instead re-renders the whole scene fresh onto a dedicated offscreen
 * canvas at a higher pixel scale (EXPORT_SCALE, default 3x), then that
 * offscreen canvas -- not the live canvas -- is what gets exported.
 *
 * FOUNDER-MANDATED layer ordering (2026-08-23, see live-compositor.ts's own
 * "FOUNDER DECISION" doc comment): the live on-screen look -- fixed
 * per-depth-bucket paint order (echo1 -> echo0 -> foreground), z-sorted only
 * WITHIN each bucket -- is the intended one, for any style that implements
 * `sceneLayers()`. render-scene.ts's renderScene() z-sorts every element
 * globally instead, which disagrees with the live look wherever an echo's
 * and the foreground's z-ranges overlap. So this module does NOT just call
 * renderScene() at a bigger CanvasSize: renderBucketedScene below replicates
 * live-compositor.ts's own BUCKET_PAINT_ORDER/bucketFor grouping (imported,
 * not re-declared -- live-compositor.ts's own doc comment explains why
 * duplicating this logic would risk drifting out of sync with the real
 * live-preview behavior) and z-sorts only within each bucket, exactly
 * mirroring what live-compositor.ts's collectAndBakeBucket/drawLiveElements
 * jointly paint over the life of a session -- just recomputed fresh, in one
 * pass, from the style's current (permanent-ink, everything-ever-drawn)
 * scene state, rather than incrementally baked. For a style that does NOT
 * implement `sceneLayers()`, there is no bucket structure to replicate --
 * live-render-loop.ts's own frame() falls back to plain renderScene() for
 * such a style, so renderExportScene below does exactly the same (see
 * live-compositor.ts's FOUNDER DECISION comment: "renderScene()... is still
 * what session-end export... uses" for non-sceneLayers styles).
 *
 * Unrevealed blossoms (verified, not assumed -- see botanical.ts's
 * revealPendingBlossoms): a not-yet-revealed blossom lives only in a growth
 * system's `pendingClusters`, never in `system.blossoms`, and
 * buildScene/buildSceneLayers only ever emit from `system.blossoms`. So
 * `style.scene()`/`style.sceneLayers()` already exclude unrevealed blossoms
 * on their own -- this module reads whatever those return verbatim, with no
 * separate reveal-filtering of its own to duplicate or drift out of sync.
 *
 * Canvas size safety: the live canvas's width grows unboundedly with the
 * piece's own scroll (render-scene.ts's computeCanvasSize), so naively
 * multiplying it by EXPORT_SCALE could produce a canvas past what a real
 * <canvas> element/GPU texture can hold. clampExportScale is a pure
 * function of the base (1x) CanvasSize and the requested scale: it picks
 * the largest scale <= the requested one that keeps both dimensions <=
 * MAX_EXPORT_DIMENSION_PX and total pixel area <= MAX_EXPORT_AREA_PX,
 * falling back toward (and, for a pathologically wide piece, even below) 1x
 * -- the save must never fail outright just because the canvas has grown
 * very wide over a long session.
 */
import {
  bucketFor,
  BUCKET_PAINT_ORDER,
  drawStrokeElementFully,
  type Bucket,
} from './live-compositor';
import { renderPaperGround } from './paper-ground';
import { drawCircleElement, renderScene, type CanvasLike, type CanvasSize } from './render-scene';
import type { Scene, SceneElement, SceneLayer, StyleRenderer } from '../styles/style-renderer';

/** Applied to EXPORT_SCALE requests unless a caller overrides it -- 3x the live canvas's own pixel resolution, per the founder backlog item this module fixes. */
export const DEFAULT_EXPORT_SCALE = 3;

/** Neither the exported canvas's width nor height is ever allowed past this, regardless of requested scale or how wide the piece has scrolled. */
export const MAX_EXPORT_DIMENSION_PX = 16000;

/** The exported canvas's total pixel area (width * height) is never allowed past this, roughly 200 megapixels. */
export const MAX_EXPORT_AREA_PX = 200_000_000;

/**
 * A scale is never clamped below this floor, even for a base CanvasSize so
 * large that MAX_EXPORT_DIMENSION_PX/MAX_EXPORT_AREA_PX would otherwise
 * demand something smaller or non-finite -- keeps computeExportCanvasSize's
 * output at least a valid 1x1px canvas instead of degenerating to 0x0,
 * which is the actual "never fail the save" guarantee at the extreme end.
 */
const MIN_EXPORT_SCALE = 0.001;

/**
 * Pure function: given the live canvas's current (1x) pixel size and a
 * requested export scale, returns the largest scale <= `requestedScale`
 * that keeps both `width * scale` and `height * scale` at or under
 * MAX_EXPORT_DIMENSION_PX, and their product at or under MAX_EXPORT_AREA_PX.
 * Degenerate/non-finite inputs (a zero-size or negative base, a
 * non-positive or non-finite requested scale) fall back to 1 -- the whole
 * point of this function existing is that a save must never fail outright,
 * so an input this module's own callers should never actually produce still
 * resolves to *something* usable rather than throwing or returning NaN.
 */
export function clampExportScale(baseCanvasSize: CanvasSize, requestedScale: number): number {
  const { width, height } = baseCanvasSize;
  if (width <= 0 || height <= 0 || !Number.isFinite(requestedScale) || requestedScale <= 0) {
    return 1;
  }

  const maxScaleForWidth = MAX_EXPORT_DIMENSION_PX / width;
  const maxScaleForHeight = MAX_EXPORT_DIMENSION_PX / height;
  const maxScaleForArea = Math.sqrt(MAX_EXPORT_AREA_PX / (width * height));

  const clamped = Math.min(requestedScale, maxScaleForWidth, maxScaleForHeight, maxScaleForArea);
  return Math.max(clamped, MIN_EXPORT_SCALE);
}

/** Pure function: the pixel CanvasSize to actually allocate for an export at `scale` of `baseCanvasSize`, rounded and floored at 1px per side so a degenerate scale can never request a 0-pixel canvas. */
export function computeExportCanvasSize(baseCanvasSize: CanvasSize, scale: number): CanvasSize {
  return {
    width: Math.max(1, Math.round(baseCanvasSize.width * scale)),
    height: Math.max(1, Math.round(baseCanvasSize.height * scale)),
  };
}

/**
 * Draws every element across `layers`, grouped into live-compositor.ts's
 * own depth buckets (echo1/echo0/foreground) and painted in
 * BUCKET_PAINT_ORDER -- each bucket's own elements z-sorted (farthest
 * first) only WITHIN that bucket, exactly matching the live on-screen paint
 * order (see this file's own top doc comment for why that's the founder-
 * mandated behavior, not renderScene()'s global sort). Does not touch the
 * paper ground -- callers paint that first (see renderExportScene below).
 */
export function renderBucketedScene(ctx: CanvasLike, layers: SceneLayer[], canvasSize: CanvasSize): void {
  const worldUnitPx = canvasSize.height;

  const layersByBucket: Record<Bucket, SceneLayer[]> = { echo1: [], echo0: [], foreground: [] };
  for (const layer of layers) {
    layersByBucket[bucketFor(layer.layerId)].push(layer);
  }

  for (const bucket of BUCKET_PAINT_ORDER) {
    const elements: SceneElement[] = [];
    for (const layer of layersByBucket[bucket]) {
      elements.push(...layer.elements);
    }
    // Farthest (largest z) first, so nearer elements draw last and end up
    // on top -- same convention as renderScene()/live-compositor.ts, but
    // scoped to this one bucket's own elements only.
    elements.sort((a, b) => b.z - a.z);

    for (const element of elements) {
      if (element.kind === 'circle') {
        drawCircleElement(ctx, element, worldUnitPx);
      } else {
        drawStrokeElementFully(ctx, element, worldUnitPx);
      }
    }
  }

  // Leave the context in a clean state for whatever draws next (same
  // convention as renderScene()/renderPaperGround/live-compositor.ts).
  ctx.globalAlpha = 1;
}

/**
 * Paints the paper ground plus the whole current scene onto `ctx`, sized to
 * `canvasSize`, matching whichever paint order the live preview would
 * actually use for `style`: bucket-ordered (renderBucketedScene) if `style`
 * implements `sceneLayers()`, or a plain global-z renderScene() pass if it
 * doesn't -- see this file's own top doc comment.
 *
 * `grainScale` is forwarded to renderPaperGround so the paper's fine-grain
 * texture stays visually proportional to the artwork at whatever pixel
 * scale `canvasSize` actually is (see paper-ground.ts's own grainScale doc
 * comment) -- callers should pass the same scale factor used to derive
 * `canvasSize` from the style's live (1x) canvas size.
 */
export function renderExportScene(
  ctx: CanvasLike,
  style: Pick<StyleRenderer, 'scene' | 'sceneLayers'>,
  canvasSize: CanvasSize,
  worldSeed: string,
  grainScale: number,
): void {
  renderPaperGround(ctx, canvasSize, worldSeed, grainScale);
  if (style.sceneLayers) {
    renderBucketedScene(ctx, style.sceneLayers(), canvasSize);
  } else {
    const scene: Scene = style.scene();
    renderScene(ctx, scene, canvasSize);
  }
}

/**
 * A caller-owned offscreen pixel buffer sized exactly for one export --
 * unlike live-compositor.ts's OffscreenBuffer, this is never grown or
 * blitted elsewhere; it's created once, painted once, and handed directly
 * to image-export.ts's exportCanvasAsPng (its `toBlob` here matches
 * ExportableCanvas's own shape exactly, so a real HTMLCanvasElement
 * satisfies both with zero casting -- same DI-for-testability pattern as
 * OffscreenBuffer/OffscreenBufferFactory in live-compositor.ts).
 */
export interface ExportRenderCanvas {
  ctx: CanvasLike;
  toBlob(callback: (blob: unknown) => void, type?: string): void;
}

export interface ExportRenderCanvasFactory {
  create(size: CanvasSize): ExportRenderCanvas;
}

/**
 * Orchestrates the whole high-resolution export: clamps `requestedScale`
 * against `baseCanvasSize` (clampExportScale), allocates a fresh canvas at
 * the resulting pixel size via `canvasFactory`, and paints the full current
 * scene onto it (renderExportScene) in the founder-mandated live paint
 * order. The returned `canvas` is ready to hand straight to
 * image-export.ts's exportCanvasAsPng.
 */
export function renderStyleToExportCanvas(
  style: Pick<StyleRenderer, 'scene' | 'sceneLayers'>,
  worldSeed: string,
  baseCanvasSize: CanvasSize,
  canvasFactory: ExportRenderCanvasFactory,
  requestedScale: number = DEFAULT_EXPORT_SCALE,
): { canvas: ExportRenderCanvas; canvasSize: CanvasSize; scaleUsed: number } {
  const scaleUsed = clampExportScale(baseCanvasSize, requestedScale);
  const canvasSize = computeExportCanvasSize(baseCanvasSize, scaleUsed);
  const canvas = canvasFactory.create(canvasSize);
  renderExportScene(canvas.ctx, style, canvasSize, worldSeed, scaleUsed);
  return { canvas, canvasSize, scaleUsed };
}
