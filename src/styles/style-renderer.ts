/**
 * The style plugin interface (spec Part 3). Styles generate depth-tagged
 * geometry; a separate compositor turns scenes into pixels.
 */
import type { MovementParams } from '../adapters/movement-params';
import type { World } from '../world/world';

export type AestheticFamily = 'organic' | 'cosmic' | 'ink';

/**
 * One element of a style's scene. Every element carries depth (invariant 8).
 * Position/size are normalized 0-1 (canvas convention, resolution-independent
 * -- the compositor scales to actual canvas size), matching MovementParams'
 * own normalization convention.
 */
export interface SceneElement {
  /** Depth coordinate: 0 = nearest, 1 = farthest. */
  z: number;
  /** Normalized position, 0-1 per axis; (0,0) = top-left. */
  x: number;
  y: number;
  /** Base radius as a fraction of the canvas's shorter side (0-1), before depth scaling. */
  radius: number;
  /** CSS color string, e.g. 'hsl(210 70% 50%)'. The compositor applies depth fade via globalAlpha and never reinterprets an alpha channel embedded here. */
  color: string;
  /** Base opacity 0-1, before the compositor's depth fade is applied. */
  opacity: number;
}

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
  step(params: MovementParams, time: number, dt: number): void;
  scene(): Scene;
  /** Called at session end; returns the final scene. */
  finish(): Scene;
}
