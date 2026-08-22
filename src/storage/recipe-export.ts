/**
 * JSON export/import for piece recipes -- the backup path (spec Part 3):
 * since IndexedDB lives in one browser profile and is lost if the user
 * clears browser data, exporting a recipe as a downloadable JSON file is how
 * a user backs up a piece, and importing it is how a foreign or restored
 * file gets back into recipe-store.ts.
 *
 * Because an imported file may be corrupted, hand-edited, or from an
 * unrelated app, deserializeRecipe validates structure before trusting the
 * parsed object rather than silently coercing or dropping bad data.
 */
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './recipe';

/** Pretty-printed since this is a human-downloadable backup file. */
export function serializeRecipe(recipe: PieceRecipe): string {
  return JSON.stringify(recipe, null, 2);
}

export function deserializeRecipe(json: string): PieceRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`deserializeRecipe: input is not valid JSON (${reason})`, { cause: err });
  }

  return validateRecipe(parsed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRecipe(value: unknown): PieceRecipe {
  if (!isPlainObject(value)) {
    throw new Error('deserializeRecipe: expected a JSON object at the top level');
  }

  if (value.version !== PIECE_RECIPE_VERSION) {
    throw new Error(
      `deserializeRecipe: unsupported recipe version (expected ${PIECE_RECIPE_VERSION}, got ${JSON.stringify(value.version)})`,
    );
  }

  if (typeof value.styleId !== 'string') {
    throw new Error('deserializeRecipe: "styleId" must be a string');
  }

  if (typeof value.worldSeed !== 'string') {
    throw new Error('deserializeRecipe: "worldSeed" must be a string');
  }

  if (typeof value.sessionIndex !== 'number') {
    throw new Error('deserializeRecipe: "sessionIndex" must be a number');
  }

  const userChoices = value.userChoices;
  if (!isPlainObject(userChoices) || !Object.values(userChoices).every((v) => typeof v === 'number')) {
    throw new Error('deserializeRecipe: "userChoices" must be an object of numbers');
  }

  const movementRecording = value.movementRecording;
  if (!Array.isArray(movementRecording)) {
    throw new Error('deserializeRecipe: "movementRecording" must be an array');
  }
  movementRecording.forEach((sample, index) => {
    validateSample(sample, index);
  });

  return {
    version: PIECE_RECIPE_VERSION,
    styleId: value.styleId,
    worldSeed: value.worldSeed,
    sessionIndex: value.sessionIndex,
    userChoices: userChoices as Record<string, number>,
    movementRecording: movementRecording as PieceRecipe['movementRecording'],
  };
}

function validateSample(sample: unknown, index: number): void {
  if (!isPlainObject(sample)) {
    throw new Error(`deserializeRecipe: movementRecording[${index}] must be an object`);
  }
  if (typeof sample.t !== 'number') {
    throw new Error(`deserializeRecipe: movementRecording[${index}].t must be a number`);
  }

  const params = sample.params;
  if (!isPlainObject(params)) {
    throw new Error(`deserializeRecipe: movementRecording[${index}].params must be an object`);
  }
  for (const key of ['v', 'expansion', 'speed', 'symmetry'] as const) {
    if (typeof params[key] !== 'number') {
      throw new Error(`deserializeRecipe: movementRecording[${index}].params.${key} must be a number`);
    }
  }
}
