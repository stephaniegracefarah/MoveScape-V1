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
}

export type SceneElement = CircleElement | StrokeElement;

export interface Scene {
  elements: SceneElement[];
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
}
