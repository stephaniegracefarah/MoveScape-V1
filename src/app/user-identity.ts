/**
 * The locally-stored random identity used to derive the day's world seed
 * (spec Part 3: "userId is a locally stored random identity created on
 * first run; when accounts arrive, it migrates"). Not part of the
 * MovementParams/World/style layers — purely app-layer bookkeeping, so it
 * lives here rather than in `src/world/`.
 */

const STORAGE_KEY = 'movescape-user-id';

/** The minimal storage surface this needs, so tests can inject a plain object instead of a real localStorage. */
export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the persisted user id, creating and persisting a fresh one on first run. */
export function getOrCreateUserId(storage: MinimalStorage = localStorage): string {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  storage.setItem(STORAGE_KEY, id);
  return id;
}
