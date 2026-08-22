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
 * Position/size are normalized 0-1 (canvas convention, resolution-independent
 * -- the compositor scales to actual canvas size), matching MovementParams'
 * own normalization convention. SceneElement is a discriminated union on
 * `kind`, so the compositor can render circles and tapered strokes with
 * distinct pixel logic while styles keep composing scenes as flat arrays.
 */
export interface CircleElement {
  kind: 'circle';
  /** Depth coordinate: 0 = nearest, 1 = farthest. */
  z: number;
  /** Normalized position, 0-1 per axis; (0,0) = top-left. */
  x: number;
  y: number;
  /** Base radius as a fraction of the canvas's shorter side (0-1), before depth scaling. */
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
  /** Ordered polyline, normalized 0-1 per axis, same convention as CircleElement.x/y. Must have at least 2 points. */
  points: { x: number; y: number }[];
  /** Width at the stroke's origin (t=0), normalized as a fraction of the canvas's shorter side, before depth scaling -- same convention as CircleElement.radius. */
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
