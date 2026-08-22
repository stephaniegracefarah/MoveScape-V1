/**
 * IndexedDB persistence for piece recipes (spec Part 3, "Storage: local only
 * for v1 -- IndexedDB for piece recipes"). This is the primary store; JSON
 * export/import (recipe-export.ts) exists as the backup path, since
 * IndexedDB is lost if the user clears browser data.
 *
 * Keyed by `${worldSeed}:${sessionIndex}` -- a world+session-index pair
 * deterministically identifies one real performance (spec Part 3's world/
 * session seed split), so this is a natural stable id rather than a random
 * one: saving twice under the same key is a legitimate overwrite of the
 * same piece, not a collision to guard against.
 *
 * `idbFactory` is injected (defaulting to `globalThis.indexedDB` for
 * production/browser use) so tests can pass an in-memory implementation
 * instead of requiring a real browser -- the same DI pattern
 * src/adapters/sliders/ uses for `document`.
 */
import type { PieceRecipe } from './recipe';

const DB_NAME = 'movescape-recipes';
const DB_VERSION = 1;
const STORE_NAME = 'recipes';

export interface StoredRecipe {
  id: string;
  recipe: PieceRecipe;
  /**
   * Date.now() at save time -- display/sort metadata only. Never fed into
   * any simulation; the fixed-timestep engine (invariant 4) only ever uses
   * movementRecording's own timestamps.
   */
  savedAt: number;
}

export interface RecipeStore {
  save(recipe: PieceRecipe): Promise<string>;
  load(id: string): Promise<StoredRecipe | undefined>;
  list(): Promise<StoredRecipe[]>;
  remove(id: string): Promise<void>;
}

/** Wraps an IDBRequest in a promise, following the standard onsuccess/onerror -> resolve/reject pattern. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function recipeKey(recipe: PieceRecipe): string {
  return `${recipe.worldSeed}:${recipe.sessionIndex}`;
}

export function openRecipeStore(idbFactory: IDBFactory | undefined = globalThis.indexedDB): Promise<RecipeStore> {
  return new Promise((resolve, reject) => {
    if (!idbFactory) {
      reject(new Error('openRecipeStore: no IDBFactory available (globalThis.indexedDB is undefined)'));
      return;
    }

    const openRequest = idbFactory.open(DB_NAME, DB_VERSION);

    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    openRequest.onsuccess = () => {
      const db = openRequest.result;
      resolve(createStore(db));
    };

    openRequest.onerror = () => {
      reject(openRequest.error ?? new Error('openRecipeStore: failed to open database'));
    };
  });
}

function createStore(db: IDBDatabase): RecipeStore {
  function store(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  return {
    async save(recipe: PieceRecipe): Promise<string> {
      const id = recipeKey(recipe);
      const stored: StoredRecipe = { id, recipe, savedAt: Date.now() };
      await requestToPromise(store('readwrite').put(stored));
      return id;
    },

    async load(id: string): Promise<StoredRecipe | undefined> {
      const result = await requestToPromise<StoredRecipe | undefined>(
        store('readonly').get(id) as IDBRequest<StoredRecipe | undefined>,
      );
      return result;
    },

    async list(): Promise<StoredRecipe[]> {
      const result = await requestToPromise<StoredRecipe[]>(
        store('readonly').getAll() as IDBRequest<StoredRecipe[]>,
      );
      return result;
    },

    async remove(id: string): Promise<void> {
      await requestToPromise(store('readwrite').delete(id));
    },
  };
}
