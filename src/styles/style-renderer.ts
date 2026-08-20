/**
 * The style plugin interface (spec Part 3). Styles generate depth-tagged
 * geometry; a separate compositor turns scenes into pixels. The exact
 * SceneElement vocabulary grows in M3 with the first compositor.
 */
import type { MovementParams } from '../adapters/movement-params';
import type { World } from '../world/world';

export type AestheticFamily = 'organic' | 'cosmic' | 'ink';

/** One element of a style's scene. Every element carries depth (invariant 8). */
export interface SceneElement {
  /** Depth coordinate: 0 = nearest, 1 = farthest. */
  z: number;
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
