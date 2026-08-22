import { describe, expect, it } from 'vitest';
import type { MovementRecording } from '../engine/recording';
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './recipe';
import { deserializeRecipe, serializeRecipe } from './recipe-export';

function recording(): MovementRecording {
  return [
    { t: 0, params: { v: 1, expansion: 0.2, speed: 0.1, symmetry: 0.8 } },
    { t: 33, params: { v: 1, expansion: 0.25, speed: 0.15, symmetry: 0.75 } },
  ];
}

function recipe(overrides: Partial<PieceRecipe> = {}): PieceRecipe {
  return {
    version: PIECE_RECIPE_VERSION,
    styleId: 'botanical',
    userChoices: { paletteWarmth: 0.5 },
    worldSeed: 'seed-tuesday',
    sessionIndex: 0,
    movementRecording: recording(),
    ...overrides,
  };
}

describe('serializeRecipe / deserializeRecipe — round trip', () => {
  it('round-trips to an equal recipe', () => {
    const r = recipe();
    const json = serializeRecipe(r);
    expect(deserializeRecipe(json)).toEqual(r);
  });

  it('produces pretty-printed JSON', () => {
    const json = serializeRecipe(recipe());
    expect(json).toContain('\n');
  });
});

describe('deserializeRecipe — malformed JSON', () => {
  it('throws rather than crashing on invalid JSON text', () => {
    expect(() => deserializeRecipe('{not valid json')).toThrow();
  });
});

describe('deserializeRecipe — wrong shape', () => {
  it('rejects a valid-JSON object missing movementRecording', () => {
    const bad = { ...recipe() } as Partial<PieceRecipe>;
    delete bad.movementRecording;
    expect(() => deserializeRecipe(JSON.stringify(bad))).toThrow(/movementRecording/);
  });

  it('rejects a non-object top level (e.g. an array)', () => {
    expect(() => deserializeRecipe(JSON.stringify([1, 2, 3]))).toThrow();
  });

  it('rejects userChoices with non-number values', () => {
    const bad = { ...recipe(), userChoices: { foo: 'bar' } };
    expect(() => deserializeRecipe(JSON.stringify(bad))).toThrow(/userChoices/);
  });

  it('rejects a movementRecording sample missing a required params field', () => {
    const bad = {
      ...recipe(),
      movementRecording: [{ t: 0, params: { v: 1, expansion: 0.2, speed: 0.1 } }],
    };
    expect(() => deserializeRecipe(JSON.stringify(bad))).toThrow(/symmetry/);
  });
});

describe('deserializeRecipe — version mismatch', () => {
  it('rejects a version mismatch with a message naming expected vs. actual', () => {
    const bad = { ...recipe(), version: 2 };
    expect(() => deserializeRecipe(JSON.stringify(bad))).toThrow(
      new RegExp(`expected ${PIECE_RECIPE_VERSION}.*got 2`),
    );
  });
});
