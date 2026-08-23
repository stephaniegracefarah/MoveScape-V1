import { describe, expect, it } from 'vitest';
import type { MovementRecording } from '../engine/recording';
import { nextSessionIndexFor } from './next-session-index';
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './recipe';
import type { RecipeStore, StoredRecipe } from './recipe-store';

/**
 * A plain hand-rolled in-memory fake of RecipeStore, backed by a Map --
 * this module only needs `save`/`list` to set up fixtures, no real
 * IndexedDB required (recipe-store.test.ts uses fake-indexeddb for its own,
 * more storage-focused tests; a direct fake is simpler here).
 */
function createFakeStore(): RecipeStore {
  const entries = new Map<string, StoredRecipe>();
  return {
    async save(recipe: PieceRecipe): Promise<string> {
      const id = `${recipe.worldSeed}:${recipe.sessionIndex}`;
      entries.set(id, { id, recipe, savedAt: Date.now() });
      return id;
    },
    async load(id: string): Promise<StoredRecipe | undefined> {
      return entries.get(id);
    },
    async list(): Promise<StoredRecipe[]> {
      return [...entries.values()];
    },
    async remove(id: string): Promise<void> {
      entries.delete(id);
    },
  };
}

function recording(): MovementRecording {
  return [{ t: 0, params: { v: 1, expansion: 0.2, speed: 0.1, symmetry: 0.8 } }];
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

describe('nextSessionIndexFor', () => {
  it('returns 0 for an empty store', async () => {
    const store = createFakeStore();
    expect(await nextSessionIndexFor(store, 'seed-tuesday')).toBe(0);
  });

  it('returns 1 when sessionIndex 0 already exists for this worldSeed', async () => {
    const store = createFakeStore();
    await store.save(recipe({ worldSeed: 'seed-tuesday', sessionIndex: 0 }));

    expect(await nextSessionIndexFor(store, 'seed-tuesday')).toBe(1);
  });

  it('returns max+1, not the first gap, when sessionIndex 0 and 2 exist for this worldSeed', async () => {
    const store = createFakeStore();
    await store.save(recipe({ worldSeed: 'seed-tuesday', sessionIndex: 0 }));
    await store.save(recipe({ worldSeed: 'seed-tuesday', sessionIndex: 2 }));

    expect(await nextSessionIndexFor(store, 'seed-tuesday')).toBe(3);
  });

  it('filters by worldSeed: recipes for a different worldSeed do not affect the result', async () => {
    const store = createFakeStore();
    await store.save(recipe({ worldSeed: 'seed-other', sessionIndex: 5 }));

    expect(await nextSessionIndexFor(store, 'seed-tuesday')).toBe(0);
  });
});
