/**
 * The piece recipe (spec Part 3, "The piece recipe is the unit of
 * permanence"): `{ version, styleId, userChoices, worldSeed, sessionIndex,
 * movementRecording }`. This tiny, fully-reconstructable record is what
 * survives long-term -- worlds are math, so a finished piece is completely
 * described by its style, the user's overrides, the seed pair that placed it
 * in the world, and the timestamped movement stream that performed it.
 * Replaying a recipe reproduces the piece exactly, at any resolution.
 *
 * This module only owns the type and its version tag. Persistence
 * (IndexedDB) lives in recipe-store.ts; JSON backup/restore lives in
 * recipe-export.ts.
 */
import type { MovementRecording } from '../engine/recording';
import type { WorldOverrides } from '../world/world';

export const PIECE_RECIPE_VERSION = 1;

export interface PieceRecipe {
  version: typeof PIECE_RECIPE_VERSION;
  styleId: string;
  userChoices: WorldOverrides;
  worldSeed: string;
  sessionIndex: number;
  movementRecording: MovementRecording;
}
