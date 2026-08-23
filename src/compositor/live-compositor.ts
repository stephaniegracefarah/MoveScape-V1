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
 * Circles (blossoms), through session 020: a blossom is whole the instant
 * it appears (no growing-width concept), so it was baked once, in full, the
 * first frame it's seen -- REVEAL and BAKE-SAFETY were the same event back
 * then, since a blossom's reveal was itself gated on bake-order safety
 * (sessions 017-020's isNextBlossomSafe).
 *
 * Session 021 (docs/HANDOFF.md): that coupling caused a real, founder-
 * reported regression -- session 020's more conservative (correctly so)
 * bake-safety bound made a blocked blossom's INVISIBILITY window large
 * enough that blossoms "mostly reveal only after their area scrolls out of
 * view." Reveal timing and bake-order safety are now decoupled: a blossom
 * becomes visible purely on the founder-tuned watercolor timer
 * (botanical.ts's revealPendingBlossoms), independent of whether it's safe
 * to bake yet. A revealed-but-not-yet-safe blossom (StyleRenderer.
 * sceneLayers' CircleElement.final absent/false) is therefore now, exactly
 * like a still-growing or still-blocked STROKE, redrawn fresh every frame
 * instead of baked -- see drawLiveElements below (renamed from
 * drawLiveStrokes, since it now handles both kinds).
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
 *
 * THE globalAlpha INVARIANT (session 024, docs/HANDOFF.md -- root cause of
 * the founder-reported "whole branch segments vanish in a single step"
 * bug): several contexts in this file are SHARED across multiple draw
 * passes that don't all set their own alpha -- `destCtx` across every
 * bucket in one renderFrame call and across every future frame; a bucket's
 * own persistent buffer ctx across every future tick's bake pass. Every
 * draw HELPER here (drawStrokeSegment/drawCircleElement, render-scene.ts)
 * already sets `ctx.globalAlpha` itself before every fill/stroke, so a
 * dirty ambient value never corrupts what THEY draw -- but `blitTo`
 * (main.ts's DOM implementation, render-divergence-harness.ts's Node one)
 * is a bare `drawImage` call that does NOT set its own alpha; it silently
 * composites using whatever `globalAlpha` its target already holds. The
 * root cause: `drawLiveElements` left `destCtx.globalAlpha` at whatever
 * its last-drawn element's own (often depth-faded, near-zero) opacity was,
 * and the NEXT bucket's `blitTo` inherited it, compositing that bucket's
 * entire persistent buffer at a near-invisible opacity. The invariant,
 * now enforced at every site that touches a shared context's alpha: ANY
 * function that sets `globalAlpha` on a context it does not exclusively
 * own restores it to 1 before returning, unconditionally -- see
 * collectAndBakeBucket's and drawLiveElements' own matching reset, and
 * renderFrame's explicit reset immediately before every `blitTo` call
 * (belt-and-suspenders: the resets inside collectAndBakeBucket/
 * drawLiveElements mean an already-correct destCtx reaches renderFrame's
 * own reset as a no-op, but renderFrame's reset is what actually GUARANTEES
 * every blitTo call is protected, independent of what ran before it).
 * renderPaperGround (paper-ground.ts) and renderScene (render-scene.ts)
 * already followed this convention before this fix -- audited, unchanged.
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

/**
 * Diagnostic-only snapshot of one layer's bake bookkeeping after a single
 * renderFrame call, for `onDebug` below -- session 022's "permanence
 * oracle" investigation (docs/HANDOFF.md) needed a way to inspect the REAL
 * internal bookkeeping this module tracks privately, not a caller-side
 * reimplementation of it (which could only ever show what the bookkeeping
 * SHOULD be, not what it actually is, defeating the point of tracing a
 * suspected bookkeeping bug). Purely observational: reading these values
 * can never influence what gets drawn.
 */
export interface LiveCompositorDebugLayerInfo {
  layerId: string;
  bucket: Bucket;
  /** Snapshot of this layer's LayerBakeState.bakedStrokeIndices right after this frame. */
  bakedStrokeIndices: number[];
  /** Stroke kind-relative indices that newly entered bakedStrokeIndices THIS frame (empty if none). */
  newlyBakedStrokeIndicesThisFrame: number[];
  /** This layer's LayerBakeState.circlesBaked right after this frame. */
  circlesBaked: number;
  /** This layer's circlesBaked value BEFORE this frame's bake pass ran -- compare to `circlesBaked` to see if it advanced this frame. */
  circlesBakedBeforeThisFrame: number;
}

/** Diagnostic-only per-frame summary -- see LiveCompositorDebugLayerInfo's own doc comment. */
export interface LiveCompositorDebugFrameInfo {
  canvasSize: CanvasSize;
  /** True iff this frame's canvasSize differs from the previous frame's (width and/or height). */
  canvasSizeChangedThisFrame: boolean;
  /** True iff this frame's canvasSize growth actually triggered growTo() on the persistent buffers (see ensureBuffers -- only fires when width or height increases past the last-known size). */
  buffersGrewThisFrame: boolean;
  layers: LiveCompositorDebugLayerInfo[];
}

export interface LiveCompositor {
  /**
   * One frame: diffs `layers` against internally tracked state, bakes only
   * what's newly-final into the right persistent buffer, redraws whatever's
   * still growing fresh, then composites paper-ground + all buffers +
   * live-growing strokes back-to-front onto `destCtx` at `canvasSize`.
   *
   * `onDebug`, if given, is called once at the end of this frame with a
   * snapshot of the internal bake bookkeeping that just happened --
   * diagnostic-only (see LiveCompositorDebugFrameInfo's own doc comment),
   * never called in production (main.ts never passes it) and never
   * affecting what gets drawn.
   */
  renderFrame(
    layers: SceneLayer[],
    destCtx: CanvasLike,
    canvasSize: CanvasSize,
    worldSeed: string,
    onDebug?: (info: LiveCompositorDebugFrameInfo) => void,
  ): void;
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
  /**
   * How many of this layer's circle-kind elements, counting a CONTIGUOUS
   * PREFIX from the start of this layer's own circle-kind sequence, have
   * been baked in full so far -- a plain count (not a Set, unlike strokes),
   * so it can only ever advance through an unbroken run of already-final
   * circles. This was a harmless simplification through session 020, when
   * every circle was baked unconditionally the instant it appeared (no
   * `final` concept existed for circles at all, so there was never a gap to
   * skip over). Session 021 gave circles a real `final` flag (blossom
   * reveal and bake-order safety are now decoupled -- see this file's own
   * top doc comment), so a circle CAN now be revealed-but-blocked -- and if
   * one is, this plain-count design means every LATER circle in this
   * layer's own sequence stays un-baked too (redrawn live instead, per
   * drawLiveElements below), even one that's individually already safe,
   * until the blocking one clears. This is a real, reported (not silently
   * absorbed) latency trade-off, not a correctness bug: a Set-based "which
   * specific circles are baked" design would let later-safe circles bake
   * out of order, but would also let a farther-z later circle bake before
   * a nearer-z earlier one that's still blocked -- reintroducing exactly
   * the paint-order bug this file's bake-order machinery exists to
   * prevent. Kept in-order deliberately, matching collectAndBakeBucket's
   * own circle-baking gate.
   */
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
  /** The layer's new `circlesBaked` value (the contiguous-prefix count after this pass's newly-safe-and-in-order circles, if any) -- see LayerBakeState.circlesBaked's own doc comment. */
  newCircleBakedCount: number;
}

/**
 * Bakes every newly-final, not-yet-baked stroke element (each in full, at its
 * true final points.length) plus every newly-final, in-order circle element
 * (session 021: a circle can now be revealed but not yet final, exactly like
 * a stroke -- see LayerBakeState.circlesBaked's own doc comment for the
 * in-order constraint), across ALL of `bucketLayers` (every layer sharing
 * one depth bucket -- see bucketFor above), onto `bucketCtx` (that bucket's
 * persistent buffer).
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
function collectAndBakeBucket(
  bucketLayers: SceneLayer[],
  getLayerState: (layerId: string) => LayerBakeState,
  bucketCtx: CanvasLike,
  worldUnitPx: number,
): Map<string, LayerBakeUpdate> {
  const pending: PendingBakeItem[] = [];
  const updates = new Map<string, LayerBakeUpdate>();

  for (const layer of bucketLayers) {
    const state = getLayerState(layer.layerId);
    const newlyBakedStrokeIndices: number[] = [];
    let strokeIndex = 0;
    let circleIndex = 0;
    let newCircleBakedCount = state.circlesBaked;

    for (const element of layer.elements) {
      if (element.kind === 'stroke') {
        if (element.final === true && !state.bakedStrokeIndices.has(strokeIndex)) {
          pending.push({ z: element.z, element });
          newlyBakedStrokeIndices.push(strokeIndex);
        }
        strokeIndex++;
      } else {
        // In-order bake gate (session 021, since circles can now be
        // revealed-but-blocked -- see LayerBakeState.circlesBaked's own
        // doc comment): only the NEXT circle after the already-baked
        // prefix can extend it, and only if it's itself final. A later
        // circle that happens to already be final is deliberately left
        // for a future frame if an earlier one is still blocking the
        // prefix -- `circleIndex === newCircleBakedCount` is false for it
        // once that happens, so it's simply skipped (not pushed) this pass.
        if (circleIndex === newCircleBakedCount && element.final === true) {
          pending.push({ z: element.z, element });
          newCircleBakedCount++;
        }
        circleIndex++;
      }
    }

    updates.set(layer.layerId, { newlyBakedStrokeIndices, newCircleBakedCount });
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

  // GLOBALALPHA INVARIANT (session 024, docs/HANDOFF.md -- the founder-
  // reported "whole branch segments vanish in one step" bug, root-caused to
  // exactly this): drawStrokeSegment/drawCircleElement (render-scene.ts)
  // both SET `ctx.globalAlpha` themselves before every fill/stroke call, so
  // leaving it dirty here wouldn't corrupt any FUTURE draw through this
  // same function (every draw call sets its own alpha first) -- but
  // `bucketCtx` is not private to this function: it's a persistent buffer's
  // own context, reused across every future tick's bake pass AND blitted
  // via `drawImage` elsewhere (live-compositor.ts's own renderFrame),
  // and `drawImage` does NOT set its own alpha -- it silently composites
  // using whatever `globalAlpha` its target context already has. Any
  // function here that sets `ctx.globalAlpha` on a context it does not
  // exclusively own must restore it to 1 before returning, unconditionally
  // (even when `pending` was empty) -- the same convention paper-ground.ts's
  // renderPaperGround already followed. See drawLiveElements' matching
  // reset and renderFrame's own reset immediately before each blitTo call.
  bucketCtx.globalAlpha = 1;

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
    state.circlesBaked = update.newCircleBakedCount;
  }

  return updates;
}

/**
 * Redraws every still-growing-or-not-yet-safe (`final` absent/false)
 * element -- strokes AND, since session 021, circles too -- across ALL of
 * `bucketLayers` fully, fresh, directly onto `destCtx` -- exactly what
 * renderScene() would do for those elements. Cheap: concurrently-live
 * elements are a small, bounded set (strokes: capped per growth system by
 * maxConcurrentBranches; circles: bounded the same way a blocked stroke
 * already was -- see the perf measurement in docs/HANDOFF.md session 021),
 * unlike the unboundedly-accumulating mature/baked content
 * collectAndBakeBucket handles above.
 *
 * Paint-order fix (docs/HANDOFF.md, session 018's render-diff evidence):
 * this used to draw each layer's own live strokes independently, one layer
 * at a time, in `layer.elements` array order -- NOT sorted by z at all,
 * unlike collectAndBakeBucket's bake path (which already z-sorts its own
 * batch, since PR #14). Multiple branches can be growing CONCURRENTLY within
 * one bucket (maxConcurrentBranches allows many at once), each with its own
 * z -- with no sort, a farther-z branch could paint over a nearer-z one
 * every single frame this condition holds, for as long as both stay
 * unresolved (which, per this fix's own bake-order gate, can now be many
 * frames). Fixed the same way collectAndBakeBucket already is: collect every
 * live element (of EITHER kind, since session 021 -- a revealed-but-
 * unsafe blossom is exactly as much a live paint-order risk as a still-
 * growing branch) across every layer in this bucket first, sort by z
 * descending (farthest first, same convention as renderScene/
 * collectAndBakeBucket), THEN draw each with its own kind's draw function.
 * Never baked, so this has zero effect on the permanent-bake correctness
 * fix above -- purely the live (never-yet-final) redraw's own paint order
 * within a single frame. Renamed from drawLiveStrokes (session 021) now
 * that it handles both kinds.
 *
 * "Live" for a STROKE means `element.final !== true` -- always accurate,
 * since collectAndBakeBucket bakes every final stroke immediately, the
 * same frame it turns final (bakedStrokeIndices is a Set, no ordering
 * dependency between strokes). "Live" for a CIRCLE is NOT simply
 * `element.final !== true`, though -- the in-order bake constraint
 * (LayerBakeState.circlesBaked's own doc comment) can leave an
 * individually-final circle un-baked for a frame or more if an earlier
 * circle in the same layer's own circle sequence is still blocking the
 * contiguous baked prefix. Checking `element.final` for circles here would
 * make such a circle neither baked NOR drawn live -- invisible, exactly
 * the class of bug this whole session exists to fix. So a circle's
 * liveness is instead determined the same way collectAndBakeBucket decides
 * bakeability: by its own kind-relative index against `state.circlesBaked`
 * (read AFTER collectAndBakeBucket has already run this frame, via the
 * same `getLayerState`) -- genuinely NOT-yet-baked, regardless of what its
 * own `final` flag says.
 */
function drawLiveElements(
  bucketLayers: SceneLayer[],
  getLayerState: (layerId: string) => LayerBakeState,
  destCtx: CanvasLike,
  worldUnitPx: number,
): void {
  const pending: SceneElement[] = [];
  for (const layer of bucketLayers) {
    const state = getLayerState(layer.layerId);
    let circleIndex = 0;
    for (const element of layer.elements) {
      if (element.kind === 'stroke') {
        if (element.final !== true) {
          pending.push(element);
        }
      } else {
        if (circleIndex >= state.circlesBaked) {
          pending.push(element);
        }
        circleIndex++;
      }
    }
  }
  pending.sort((a, b) => b.z - a.z);
  for (const element of pending) {
    if (element.kind === 'stroke') {
      drawStrokeElementFully(destCtx, element, worldUnitPx);
    } else {
      drawCircleElement(destCtx, element, worldUnitPx);
    }
  }

  // GLOBALALPHA INVARIANT (session 024) -- see collectAndBakeBucket's own
  // matching comment for the full mechanism. `destCtx` here is the SHARED
  // on-screen (or export) canvas context, reused across every bucket in
  // BUCKET_PAINT_ORDER within this same renderFrame call, and across every
  // future frame -- leaving it at whatever alpha this bucket's last live
  // element happened to use is exactly the leak that let the NEXT bucket's
  // `blitTo` (a bare `drawImage`, which never sets its own alpha) silently
  // composite an entire persistent buffer at a near-invisible opacity.
  destCtx.globalAlpha = 1;
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
    renderFrame(layers, destCtx, canvasSize, worldSeed, onDebug): void {
      const sizeBeforeThisFrame = lastSize;
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

      const debugLayers: LiveCompositorDebugLayerInfo[] = [];

      for (const bucket of BUCKET_PAINT_ORDER) {
        const bucketLayers = layersByBucket[bucket];

        const circlesBakedBefore = new Map<string, number>();
        if (onDebug) {
          for (const layer of bucketLayers) {
            circlesBakedBefore.set(layer.layerId, getLayerState(layer.layerId).circlesBaked);
          }
        }

        const updates = collectAndBakeBucket(bucketLayers, getLayerState, bucketBuffers[bucket].ctx, worldUnitPx);

        // GLOBALALPHA INVARIANT (session 024, docs/HANDOFF.md -- the
        // founder-reported "whole branch segments vanish in one step" bug):
        // `blitTo` is a bare `drawImage` under the hood (main.ts's DOM
        // implementation, render-divergence-harness.ts's Node one) -- it
        // never sets its own alpha, so it silently composites this bucket's
        // ENTIRE persistent buffer using whatever `globalAlpha` `destCtx`
        // already happens to hold. `destCtx` is shared across every bucket
        // in this loop; drawLiveElements' own reset (its own doc comment)
        // covers the common case, but this explicit reset immediately
        // before the call is the actual fix -- it does not depend on every
        // upstream drawer remembering to clean up after itself, and it
        // means the FIRST bucket's blit (nothing has drawn on destCtx yet
        // this frame except renderPaperGround, which already resets to 1
        // itself) is exactly as protected as the second and third.
        destCtx.globalAlpha = 1;
        bucketBuffers[bucket].blitTo(destCtx);

        // Still-growing/still-unsafe live elements (strokes AND, since
        // session 021, circles) for this bucket paint on top of this
        // bucket's own just-blitted content, but before the NEXT bucket
        // (nearer to the viewer) gets composited over them. z-sorted across
        // the whole bucket, not per-layer -- see drawLiveElements's own doc
        // comment.
        drawLiveElements(bucketLayers, getLayerState, destCtx, worldUnitPx);

        if (onDebug) {
          for (const layer of bucketLayers) {
            const state = getLayerState(layer.layerId);
            const update = updates.get(layer.layerId);
            debugLayers.push({
              layerId: layer.layerId,
              bucket,
              bakedStrokeIndices: [...state.bakedStrokeIndices].sort((a, b) => a - b),
              newlyBakedStrokeIndicesThisFrame: update?.newlyBakedStrokeIndices ?? [],
              circlesBaked: state.circlesBaked,
              circlesBakedBeforeThisFrame: circlesBakedBefore.get(layer.layerId) ?? 0,
            });
          }
        }
      }

      if (onDebug) {
        onDebug({
          canvasSize,
          canvasSizeChangedThisFrame:
            sizeBeforeThisFrame === null ||
            sizeBeforeThisFrame.width !== canvasSize.width ||
            sizeBeforeThisFrame.height !== canvasSize.height,
          buffersGrewThisFrame:
            sizeBeforeThisFrame !== null &&
            (canvasSize.width > sizeBeforeThisFrame.width || canvasSize.height > sizeBeforeThisFrame.height),
          layers: debugLayers,
        });
      }
    },
    reset(): void {
      buffers = null;
      lastSize = null;
      layerState.clear();
    },
  };
}
