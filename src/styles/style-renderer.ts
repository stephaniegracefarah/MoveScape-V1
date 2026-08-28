/**
 * The style plugin interface (spec Part 3). Styles generate depth-tagged
 * geometry; a separate compositor turns scenes into pixels.
 */
import type { MovementParams } from '../adapters/movement-params';
import type { SessionParams } from '../engine/session-params';
import type { World } from '../world/world';

export type AestheticFamily = 'organic' | 'cosmic' | 'ink';

/**
 * One element of a style's scene. Every element carries depth (invariant 8).
 *
 * Position convention (spec Part 3, "Composition and canvas" -- "the
 * Scroll"): `y` is normalized 0-1, a fraction of the canvas's fixed height,
 * matching MovementParams' own normalization convention. `x` is different:
 * it is in *world units*, where 1 world unit = 1 canvas height in pixels --
 * unbounded rightward as a piece grows (0, 2, 20, ...), NOT normalized 0-1
 * and NOT related to the canvas's width. The compositor (render-scene.ts)
 * scales both axes by the canvas's fixed height; the canvas itself is
 * resized to fit however far content has grown. SceneElement is a
 * discriminated union on `kind`, so the compositor can render circles and
 * tapered strokes with distinct pixel logic while styles keep composing
 * scenes as flat arrays.
 */
export interface CircleElement {
  kind: 'circle';
  /** Depth coordinate: 0 = nearest, 1 = farthest. */
  z: number;
  /** Position in world units on x (1 unit = 1 canvas height in pixels, unbounded rightward), normalized 0-1 on y (fraction of the canvas's fixed height); (0,0) = top-left. */
  x: number;
  y: number;
  /** Base radius as a fraction of the canvas's fixed height (the world-unit scale), before depth scaling. */
  radius: number;
  /** CSS color string. The compositor applies depth fade via globalAlpha and never reinterprets an alpha channel embedded here. */
  color: string;
  /** Base opacity 0-1, before the compositor's depth fade is applied. */
  opacity: number;
  /** Optional thin outline ring (docs/styles/botanical.md section 3's "signature Lippmann detail"): when present, the compositor strokes an additional 1px-wide ring at the same center/radius after filling. */
  ringColor?: string;
  /** Base opacity for the ring, 0-1, before depth fade (same fade formula as the fill). Ignored if ringColor is absent. */
  ringOpacity?: number;
  /**
   * True once this circle is safe to permanently bake into the live
   * compositor's persistent buffer (src/compositor/live-compositor.ts) --
   * mirrors StrokeElement.final exactly, but for a different reason. A
   * circle is whole the instant it's revealed (no growing-width concept
   * the way a stroke has), so this is never about the circle's OWN
   * geometry changing -- it's about docs/HANDOFF.md's bake-order safety
   * gate (isSafeToBake in botanical.ts): a revealed-but-not-yet-safe
   * blossom must still render every frame (this session's fix, decoupling
   * the founder-tuned watercolor REVEAL pacing from the bake-order safety
   * gate -- a blossom becomes visible immediately on reveal, exactly like
   * a blocked stroke stays visible while growing), just not yet baked
   * permanently. Absent or false means "draw fresh every frame instead of
   * baking." Purely additive: ignored entirely by renderScene() and by
   * export (finish()), so neither is affected by a style setting this.
   */
  final?: boolean;
}

export interface StrokeElement {
  kind: 'stroke';
  /** Depth coordinate: 0 = nearest, 1 = farthest. */
  z: number;
  /** Ordered polyline; each point's x is in world units (1 unit = 1 canvas height in pixels, unbounded rightward), y is normalized 0-1 (fraction of the canvas's fixed height) -- same convention as CircleElement.x/y. Must have at least 2 points. */
  points: { x: number; y: number }[];
  /** Width at the stroke's origin (t=0), as a fraction of the canvas's fixed height (the world-unit scale), before depth scaling -- same convention as CircleElement.radius. */
  baseWidth: number;
  /** Exponent in width(t) = baseWidth * (1-t)^taperExponent, where t is the point's index fraction along the polyline (i / (points.length - 1)), matching docs/styles/botanical.md section 1's taper formula. */
  taperExponent: number;
  color: string;
  opacity: number;
  /**
   * True once this stroke's `points` array will never grow again -- the
   * live compositor (src/compositor/live-compositor.ts) may then safely
   * bake it once, in full, using this call's `points.length`, and never
   * revisit it. Absent or false means still-changing (e.g. a branch still
   * growing): the compositor must redraw it fresh, in full, every frame
   * instead of baking it, since taper width (`width(t)` above) depends on
   * `points.length` -- baking a growing stroke early would freeze each
   * segment's `t` at whatever it was the instant it was baked, never
   * "thickening" toward its true final width as the branch keeps growing
   * past it. Purely additive: ignored entirely by renderScene() and by
   * export (finish()), so neither is affected by a style setting this.
   */
  final?: boolean;
}

export type SceneElement = CircleElement | StrokeElement;

export interface Scene {
  elements: SceneElement[];
}

/**
 * One independent, incrementally-bakeable layer of a style's scene (see
 * StyleRenderer.sceneLayers below). `layerId` is stable and unique for the
 * life of a session -- e.g. Botanical's foreground growth systems ('fg0',
 * 'fg1', ...) and depth echoes ('echo0', 'echo1').
 */
export interface SceneLayer {
  layerId: string;
  elements: SceneElement[];
}

/**
 * One tab's worth of "Show the magic" data (UX Stage 2, docs/UX/develop.md
 * Live-session decision C): a real function that computes movement→art
 * behavior, plus the exact scalar arguments and return value from ONE real
 * call to it on the most recent tick. The panel loads that function's
 * verbatim source (Vite `?raw`) and annotates it with `args`/`result` — so
 * what the viewer reads is the running code and the numbers it actually
 * ran with, never a paraphrase.
 */
export interface MechanismFunctionSample {
  /** Human tab label, e.g. 'speed → growth'. */
  tabLabel: string;
  /** Exact exported function name whose verbatim source this tab shows, e.g. 'growthStepFor'. */
  sourceFunctionName: string;
  /**
   * Stable id of the module the function lives in, e.g. 'branch.ts'. Shown
   * to the viewer ("branch.ts : growthStepFor()") and used by the panel as
   * the lookup key into its own static table of `?raw`-imported sources
   * (dynamic `?raw` import of an arbitrary path isn't statically
   * analyzable, so the panel imports the known sources up front and maps
   * this id to one of them).
   */
  sourceModule: string;
  /**
   * Live scalar argument values from this tick's real call, keyed by the
   * function's own parameter names (`dt`, `speed`, ...). Non-scalar args
   * (e.g. a `tuning` config object) are omitted — only what annotates
   * cleanly inline.
   */
  args: Record<string, number>;
  /** What that real call returned this tick. */
  result: number;
}

/**
 * The style's current "Show the magic" snapshot: one entry per tab, in tab
 * order. Grouped by real function boundary, NOT by readout label — as of
 * this writing Botanical returns two (speed→growth = `growthStepFor`,
 * expansion+symmetry→wander = `wanderDeltaFor`), captured from the newest
 * still-growing generation-0 branch of the newest foreground growth system
 * (the growth front). A style with no such mechanism omits
 * `latestMechanismSample` entirely and the panel isn't offered.
 */
export interface MechanismSample {
  functions: MechanismFunctionSample[];
}

export interface StyleRenderer {
  id: string;
  name: string;
  aestheticFamily: AestheticFamily;
  /** Declares the knobs the seed will fill via labeled streams. */
  worldKnobs(): string[];
  init(world: World): void;
  /** Advance the living system one fixed tick (invariant 4). */
  step(params: MovementParams, sessionParams: SessionParams, time: number, dt: number): void;
  scene(): Scene;
  /** Called at session end; returns the final scene. */
  finish(): Scene;
  /**
   * Optional: styles with permanent, ever-accumulating geometry (e.g.
   * Botanical) implement this so the live compositor can render
   * incrementally instead of redrawing the whole scene every frame.
   * Each returned layer's `elements` must stay in stable APPEND order
   * across repeated calls within one session -- elements already present
   * in a previous call's array, at the same index, must never change
   * their kind or be removed/reordered; new elements only ever get
   * appended at the end, OR an existing stroke element's `points` array
   * may grow longer (new points appended to its end) representing a
   * branch still growing. This is what lets the compositor safely bake
   * new content once and never revisit old pixels. Styles that omit this
   * method get the plain full-redraw-every-frame path (today's behavior,
   * unchanged) from the live render loop.
   *
   * Implementation note (src/compositor/live-compositor.ts): the
   * "index" the compositor tracks an element's bake progress by is that
   * element's own position among same-`kind` elements within this
   * layer's array (its Nth stroke, or its Nth circle), NOT its raw mixed
   * position in `elements`. This is what lets a layer's array interleave
   * strokes and circles in any order (e.g. all strokes first, then all
   * circles, as Botanical's own emission does) without a later-appended
   * stroke -- landing, in the raw array, before an earlier-baked circle
   * -- being mistaken for a change to that circle's identity: each kind's
   * own relative order is independently append-only even though the
   * flattened array's raw indices are not.
   */
  sceneLayers?(): SceneLayer[];
  /**
   * Optional: the most recent tick's real movement→art function calls, for
   * the "Show the magic" panel (UX Stage 2). Returns null before the first
   * qualifying call (e.g. nothing growing yet). Captured during `step()`
   * from the exact arguments fed to the representative branch's real calls
   * that tick, with return values from invoking those same pure functions
   * on those same arguments (branch.ts's growth/wander math is a pure
   * function of its explicit arguments, so this is the true value, not an
   * estimate). Read-only; never mutated by the caller.
   */
  latestMechanismSample?(): MechanismSample | null;
}
