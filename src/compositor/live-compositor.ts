/**
 * The incremental live-preview compositor (docs/HANDOFF.md, "Known issues /
 * debt" -- frame rate collapsing over the course of a session). Botanical's
 * marks are permanent ink (docs/styles/botanical.md section 7): nothing is
 * ever removed, so the plain full-redraw-every-frame compositor
 * (render-scene.ts's renderScene) does strictly more canvas work every
 * frame for the life of a session, which starves the main thread as a
 * session runs long. This module bakes each piece of FINAL (done-growing)
 * geometry onto a persistent offscreen buffer exactly once, then every
 * frame just blits the buffers into place -- bounding per-frame cost to
 * "how much finished this frame, plus whatever's still growing" instead of
 * "everything ever drawn."
 *
 * Stroke taper correctness (a real bug found and fixed before this landed --
 * see docs/HANDOFF.md): a stroke's width at each point depends on
 * `points.length` (StrokeElement.taperExponent's own doc comment,
 * render-scene.ts's drawStrokeSegment) -- width(t) where t = i /
 * (points.length - 1). Baking a segment the instant it's appended, using
 * whatever points.length the branch had AT THAT MOMENT, would freeze it at
 * the wrong t forever (it's always newest-and-thinnest the instant it's
 * baked, and never gets to "thicken" as the branch keeps growing past it).
 * So a stroke is baked ONLY once it's `final` (StyleRenderer.sceneLayers'
 * StrokeElement.final -- "this points array will never grow again"), baked
 * whole, in one shot, at its true final points.length -- matching exactly
 * what renderScene() would compute for the same, now-final, element. While
 * a stroke is still growing (`final` absent/false), it is never baked at
 * all: it's redrawn fully, fresh, directly onto destCtx every frame,
 * exactly like renderScene() already does for one element. This is cheap
 * because concurrently-growing strokes are a small, bounded set (capped per
 * growth system by maxConcurrentBranches) -- it was the unboundedly
 * accumulating MATURE content that needed to stop being redrawn every
 * frame, not the small live-growing set.
 *
 * Paint-order consequence of the above: a bucket's own still-growing
 * strokes must be drawn onto destCtx AFTER that bucket's persistent buffer
 * is blitted, but BEFORE moving on to the next bucket in
 * BUCKET_PAINT_ORDER -- lumping all "live" strokes together at the very end
 * would let a still-growing ECHO branch incorrectly paint on top of
 * already-composited FOREGROUND content.
 *
 * Circles (blossoms) are unaffected by any of the above: a blossom is whole
 * the instant it appears (no growing-width concept), so it's still baked
 * once, in full, the first frame it's seen.
 *
 * Scope: this is ONLY the on-screen live-preview path
 * (src/app/live-render-loop.ts). render-scene.ts's renderScene() -- the
 * full clear-and-redraw path -- is completely untouched and is still what
 * produces the byte-for-byte session-end export.
 *
 * Per render-scene.ts's own CanvasLike doc comment (testability without a
 * real DOM/jsdom, which this project doesn't use), this module never
 * imports lib.dom's canvas types directly -- OffscreenBuffer/
 * OffscreenBufferFactory below are hand-written structural interfaces, DI'd
 * in by the caller (src/main.ts implements OffscreenBufferFactory against a
 * real HTMLCanvasElement).
 */
import { drawCircleElement, drawStrokeSegment, type CanvasLike, type CanvasSize } from './render-scene';
import { renderPaperGround } from './paper-ground';
import type { SceneElement, SceneLayer, StrokeElement } from '../styles/style-renderer';

/**
 * A caller-owned persistent offscreen pixel buffer -- one per depth bucket
 * (see BUCKET_PAINT_ORDER below), created and grown by an injected
 * OffscreenBufferFactory so this module stays unit-testable with a
 * hand-written fake factory, no real canvas.
 */
export interface OffscreenBuffer {
  ctx: CanvasLike;
  /** Copies this buffer's current pixels onto `dest` at (0,0). */
  blitTo(dest: CanvasLike): void;
  /** Grows this buffer to `newSize`, preserving existing pixel content (the old content must still be there at (0,0) afterward -- never just clear-and-resize). Only ever called with a size >= the current size. */
  growTo(newSize: CanvasSize): void;
}

export interface OffscreenBufferFactory {
  create(size: CanvasSize): OffscreenBuffer;
}

export interface LiveCompositor {
  /**
   * One frame: diffs `layers` against internally tracked state, bakes only
   * what's newly-final into the right persistent buffer, redraws whatever's
   * still growing fresh, then composites paper-ground + all buffers +
   * live-growing strokes back-to-front onto `destCtx` at `canvasSize`.
   */
  renderFrame(layers: SceneLayer[], destCtx: CanvasLike, canvasSize: CanvasSize, worldSeed: string): void;
  /**
   * Discards all persistent buffers and tracked bake-state -- call when
   * starting a fresh session (e.g. a palette-switch restart) so no stale
   * pixels from a previous session can bleed through.
   */
  reset(): void;
}

type Bucket = 'echo1' | 'echo0' | 'foreground';

/** Paint order back-to-front onto destCtx, so the foreground ends up on top (nearest), matching the compositor's general depth intent. */
const BUCKET_PAINT_ORDER: Bucket[] = ['echo1', 'echo0', 'foreground'];

/**
 * Every non-echo layerId (Botanical's foreground growth systems: 'fg0',
 * 'fg1', 'fg2', ...) shares the single 'foreground' bucket -- they're all
 * the same depth band and meant to read as one continuous sweep. 'echo0'
 * and 'echo1' each get their own dedicated buffer.
 */
function bucketFor(layerId: string): Bucket {
  if (layerId === 'echo0') return 'echo0';
  if (layerId === 'echo1') return 'echo1';
  return 'foreground';
}

/**
 * Per-layer bake progress. Tracked per-*kind*, independently: a stroke
 * element's own index among this layer's stroke-kind elements only (its Nth
 * stroke), and a running count of how many of this layer's circle-kind
 * elements have been baked -- NOT the element's raw position in the
 * layer's mixed `elements` array. This is deliberate (see StyleRenderer.
 * sceneLayers' doc comment in style-renderer.ts): Botanical's own emission
 * order puts all of a system's stroke elements before all of its circle
 * elements, but new stroke elements keep appending to that layer for the
 * life of a session (front-driven resprouting), long after that same
 * layer's first blossom cluster already exists -- which would land a new
 * stroke's *raw* array position before an already-baked circle's raw
 * position. Tracking each kind's own relative order independently sidesteps
 * that entirely: each kind's own sequence is append-only even when the
 * flattened array's raw indices are not.
 */
interface LayerBakeState {
  /** Per-kind indices of strokes that have already been baked (once, in full, the frame they turned final). A stroke's own index is never in this set until `element.final === true`. */
  bakedStrokeIndices: Set<number>;
  /** How many of this layer's circle-kind elements (in their own kind-relative order) have been baked in full so far. */
  circlesBaked: number;
}

function createLayerBakeState(): LayerBakeState {
  return { bakedStrokeIndices: new Set(), circlesBaked: 0 };
}

/** Draws one stroke element's entire polyline (every segment, 0..points.length-2) onto `ctx` at its CURRENT points.length -- the same "compute taper fresh over the true point count" shape renderScene() uses for one element. Shared by the bake-when-final path (baking once, at the final point count) and the live still-growing path (redrawing fresh every frame, at whatever point count it currently has). */
function drawStrokeElementFully(ctx: CanvasLike, element: StrokeElement, worldUnitPx: number): void {
  const lastIndex = element.points.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    drawStrokeSegment(ctx, element, i, worldUnitPx);
  }
}

/** One not-yet-baked element discovered during the collect pass, tagged with the `z` it must be sorted by before drawing. */
interface PendingBakeItem {
  z: number;
  element: SceneElement;
}

/** Per-layer bookkeeping collected during the collect pass, applied to that layer's LayerBakeState only after every pending item across the whole bucket has actually been drawn (see collectAndBakeBucket below). */
interface LayerBakeUpdate {
  newlyBakedStrokeIndices: number[];
  newCircleCount: number;
}

/**
 * Bakes every newly-final, not-yet-baked stroke element (each in full, at its
 * true final points.length) plus every newly-appeared circle element, across
 * ALL of `bucketLayers` (every layer sharing one depth bucket -- see
 * bucketFor above), onto `bucketCtx` (that bucket's persistent buffer).
 *
 * Paint-order fix (docs/HANDOFF.md, "branches poof disappear" /
 * "blossoms burst all at once"): a bucket's bake pass used to draw each
 * layer's own newly-bakeable elements immediately, one layer at a time, in
 * `layer.elements` iteration order -- NOT in z order. Early in a session,
 * before the canvas has spread out, that let a farther-z (higher z) element
 * that happened to finish baking in a later layer or later array position
 * permanently paint over a nearer-z (lower z) element it should always
 * render underneath, since baking is one-shot and permanent (unlike
 * render-scene.ts's renderScene, which re-sorts and repaints every element
 * fresh every frame). The fix: collect every newly-bakeable element across
 * every layer in this bucket FIRST, sort the whole batch by z descending
 * (farthest first -- same convention as renderScene's
 * `[...scene.elements].sort((a, b) => b.z - a.z)`, so nearer/lower-z
 * elements paint last, i.e. on top), THEN draw them onto `bucketCtx` in that
 * order, and only THEN update each layer's bake-state bookkeeping. This
 * changes nothing about WHAT gets baked or WHEN (still exactly once, the
 * first frame a stroke is final / a circle appears) -- only the paint order
 * among elements that become bakeable in the same frame.
 */
function collectAndBakeBucket(bucketLayers: SceneLayer[], getLayerState: (layerId: string) => LayerBakeState, bucketCtx: CanvasLike, worldUnitPx: number): void {
  const pending: PendingBakeItem[] = [];
  const updates = new Map<string, LayerBakeUpdate>();

  for (const layer of bucketLayers) {
    const state = getLayerState(layer.layerId);
    const newlyBakedStrokeIndices: number[] = [];
    let strokeIndex = 0;
    let circleIndex = 0;

    for (const element of layer.elements) {
      if (element.kind === 'stroke') {
        if (element.final === true && !state.bakedStrokeIndices.has(strokeIndex)) {
          pending.push({ z: element.z, element });
          newlyBakedStrokeIndices.push(strokeIndex);
        }
        strokeIndex++;
      } else {
        if (circleIndex >= state.circlesBaked) {
          pending.push({ z: element.z, element });
        }
        circleIndex++;
      }
    }

    // Elements are append-only (see LayerBakeState's doc comment), so
    // circleIndex (this frame's total circle count) is always >= the
    // previous count; Math.max is defensive, not load-bearing.
    updates.set(layer.layerId, { newlyBakedStrokeIndices, newCircleCount: circleIndex });
  }

  // Farthest (largest z) first, so nearer elements draw last and end up on
  // top -- matching render-scene.ts's renderScene exactly.
  pending.sort((a, b) => b.z - a.z);

  for (const item of pending) {
    if (item.element.kind === 'stroke') {
      drawStrokeElementFully(bucketCtx, item.element, worldUnitPx);
    } else {
      drawCircleElement(bucketCtx, item.element, worldUnitPx);
    }
  }

  // Only now, after every pending element in this bucket has actually been
  // drawn in the correct order, record what got baked -- so a mid-batch
  // ordering decision can never be observed as "already baked" partway
  // through this same frame's draw pass.
  for (const layer of bucketLayers) {
    const state = getLayerState(layer.layerId);
    const update = updates.get(layer.layerId)!;
    for (const strokeIndex of update.newlyBakedStrokeIndices) {
      state.bakedStrokeIndices.add(strokeIndex);
    }
    state.circlesBaked = Math.max(state.circlesBaked, update.newCircleCount);
  }
}

/**
 * Redraws every still-growing (`final` absent/false) stroke element in
 * `layer` fully, fresh, directly onto `destCtx` -- exactly what
 * renderScene() would do for that one element. Cheap: concurrently-growing
 * strokes are a small, bounded set per growth system (capped by
 * maxConcurrentBranches), unlike the unboundedly-accumulating mature
 * content collectAndBakeBucket handles above.
 */
function drawLiveStrokes(layer: SceneLayer, destCtx: CanvasLike, worldUnitPx: number): void {
  for (const element of layer.elements) {
    if (element.kind === 'stroke' && element.final !== true) {
      drawStrokeElementFully(destCtx, element, worldUnitPx);
    }
  }
}

export function createLiveCompositor(bufferFactory: OffscreenBufferFactory): LiveCompositor {
  let buffers: Record<Bucket, OffscreenBuffer> | null = null;
  let lastSize: CanvasSize | null = null;
  const layerState = new Map<string, LayerBakeState>();

  function ensureBuffers(size: CanvasSize): Record<Bucket, OffscreenBuffer> {
    if (buffers === null) {
      buffers = {
        echo1: bufferFactory.create(size),
        echo0: bufferFactory.create(size),
        foreground: bufferFactory.create(size),
      };
      lastSize = size;
      return buffers;
    }
    if (lastSize === null || size.width > lastSize.width || size.height > lastSize.height) {
      for (const bucket of BUCKET_PAINT_ORDER) {
        buffers[bucket].growTo(size);
      }
      lastSize = size;
    }
    return buffers;
  }

  function getLayerState(layerId: string): LayerBakeState {
    let state = layerState.get(layerId);
    if (state === undefined) {
      state = createLayerBakeState();
      layerState.set(layerId, state);
    }
    return state;
  }

  return {
    renderFrame(layers, destCtx, canvasSize, worldSeed): void {
      const bucketBuffers = ensureBuffers(canvasSize);
      // Same fixed world-to-pixel scale as render-scene.ts: 1 world unit =
      // 1 canvas height in pixels, constant for the life of a session --
      // this is what keeps an already-baked pixel's position stable
      // regardless of how much wider the canvas grows later.
      const worldUnitPx = canvasSize.height;

      // Group by bucket up front, preserving each layer's relative order
      // within its bucket, so the bake -> blit -> live-redraw sequence
      // below can run bucket-by-bucket in BUCKET_PAINT_ORDER (paint-order
      // correctness -- see this file's top doc comment).
      const layersByBucket: Record<Bucket, SceneLayer[]> = { echo1: [], echo0: [], foreground: [] };
      for (const layer of layers) {
        layersByBucket[bucketFor(layer.layerId)].push(layer);
      }

      // Paper ground stays a flat, bounded-cost full repaint every frame
      // (see paper-ground.ts) -- not the source of the frame-rate collapse,
      // out of scope for this fix. Painted first so it sits underneath
      // everything else.
      renderPaperGround(destCtx, canvasSize, worldSeed);

      for (const bucket of BUCKET_PAINT_ORDER) {
        const bucketLayers = layersByBucket[bucket];

        collectAndBakeBucket(bucketLayers, getLayerState, bucketBuffers[bucket].ctx, worldUnitPx);

        bucketBuffers[bucket].blitTo(destCtx);

        // Still-growing strokes for this bucket paint on top of this
        // bucket's own just-blitted content, but before the NEXT bucket
        // (nearer to the viewer) gets composited over them.
        for (const layer of bucketLayers) {
          drawLiveStrokes(layer, destCtx, worldUnitPx);
        }
      }
    },
    reset(): void {
      buffers = null;
      lastSize = null;
      layerState.clear();
    },
  };
}
