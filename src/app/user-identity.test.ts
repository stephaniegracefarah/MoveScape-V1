import { describe, expect, it } from 'vitest';
import { getOrCreateUserId, type MinimalStorage } from './user-identity';

function createMemoryStorage(): MinimalStorage {
  const map = new Map<string, string>();
  return {
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

describe('getOrCreateUserId', () => {
  it('creates and persists a fresh id on first run', () => {
    const storage = createMemoryStorage();
    const id = getOrCreateUserId(storage);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(storage.getItem('movescape-user-id')).toBe(id);
  });

  it('returns the same id on a subsequent call against the same storage', () => {
    const storage = createMemoryStorage();
    const first = getOrCreateUserId(storage);
    const second = getOrCreateUserId(storage);
    expect(second).toBe(first);
  });

  it('returns different ids for independent storages', () => {
    const first = getOrCreateUserId(createMemoryStorage());
    const second = getOrCreateUserId(createMemoryStorage());
    expect(first).not.toBe(second);
  });
});
