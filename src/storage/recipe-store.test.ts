import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MovementRecording } from '../engine/recording';
import { PIECE_RECIPE_VERSION, type PieceRecipe } from './recipe';
import { openRecipeStore, type RecipeStore } from './recipe-store';

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

let idbFactory: IDBFactory;
let store: RecipeStore;

beforeEach(async () => {
  idbFactory = new IDBFactory();
  store = await openRecipeStore(idbFactory);
});

describe('openRecipeStore — save/load', () => {
  it('save then load returns an equivalent recipe, including the movementRecording array', async () => {
    const r = recipe();
    const id = await store.save(r);

    const loaded = await store.load(id);
    expect(loaded).toBeDefined();
    expect(loaded?.recipe).toEqual(r);
    expect(loaded?.id).toBe(id);
    expect(typeof loaded?.savedAt).toBe('number');
  });

  it('loading a nonexistent id returns undefined, not a throw', async () => {
    await expect(store.load('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('openRecipeStore — overwrite by worldSeed:sessionIndex', () => {
  it('saving twice with the same worldSeed+sessionIndex overwrites: list() shows one entry, load() returns the latest', async () => {
    const first = recipe({ styleId: 'botanical' });
    const second = recipe({ styleId: 'botanical-v2' });

    const idFirst = await store.save(first);
    const idSecond = await store.save(second);
    expect(idFirst).toBe(idSecond);

    const all = await store.list();
    expect(all).toHaveLength(1);

    const loaded = await store.load(idSecond);
    expect(loaded?.recipe.styleId).toBe('botanical-v2');
  });
});

describe('openRecipeStore — list', () => {
  it('returns all saved recipes', async () => {
    await store.save(recipe({ worldSeed: 'seed-a', sessionIndex: 0 }));
    await store.save(recipe({ worldSeed: 'seed-b', sessionIndex: 0 }));
    await store.save(recipe({ worldSeed: 'seed-b', sessionIndex: 1 }));

    const all = await store.list();
    expect(all).toHaveLength(3);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(['seed-a:0', 'seed-b:0', 'seed-b:1']);
  });
});

describe('openRecipeStore — remove', () => {
  it('deletes one entry; load() afterward returns undefined', async () => {
    const id = await store.save(recipe());
    expect(await store.load(id)).toBeDefined();

    await store.remove(id);
    expect(await store.load(id)).toBeUndefined();
  });

  it('leaves other entries intact', async () => {
    const idA = await store.save(recipe({ worldSeed: 'seed-a', sessionIndex: 0 }));
    const idB = await store.save(recipe({ worldSeed: 'seed-b', sessionIndex: 0 }));

    await store.remove(idA);

    expect(await store.load(idA)).toBeUndefined();
    expect(await store.load(idB)).toBeDefined();
    expect(await store.list()).toHaveLength(1);
  });
});
