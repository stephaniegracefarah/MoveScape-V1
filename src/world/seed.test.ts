import { describe, expect, it } from 'vitest';
import { deriveSessionSeed, deriveWorldSeed, formatLocalDate } from './seed';

describe('formatLocalDate', () => {
  it('zero-pads a single-digit month and day', () => {
    // Constructed via the local Date constructor (year, monthIndex, day),
    // never via an ISO string, so the test stays timezone-agnostic.
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('handles a double-digit month and day', () => {
    expect(formatLocalDate(new Date(2026, 10, 23))).toBe('2026-11-23');
  });
});

describe('deriveWorldSeed', () => {
  it('is deterministic for identical inputs', () => {
    expect(deriveWorldSeed('user-1', '2026-08-20')).toBe(
      deriveWorldSeed('user-1', '2026-08-20'),
    );
  });

  it('differs when userId differs', () => {
    expect(deriveWorldSeed('user-1', '2026-08-20')).not.toBe(
      deriveWorldSeed('user-2', '2026-08-20'),
    );
  });

  it('differs when localDate differs', () => {
    expect(deriveWorldSeed('user-1', '2026-08-20')).not.toBe(
      deriveWorldSeed('user-1', '2026-08-21'),
    );
  });
});

describe('deriveSessionSeed', () => {
  it('is deterministic for repeated identical calls', () => {
    const worldSeed = deriveWorldSeed('user-1', '2026-08-20');
    expect(deriveSessionSeed(worldSeed, 0)).toBe(
      deriveSessionSeed(worldSeed, 0),
    );
  });

  it('differs across session indices', () => {
    const worldSeed = deriveWorldSeed('user-1', '2026-08-20');
    expect(deriveSessionSeed(worldSeed, 0)).not.toBe(
      deriveSessionSeed(worldSeed, 1),
    );
  });
});
