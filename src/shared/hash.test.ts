import { describe, expect, it } from 'vitest';
import { cyrb53 } from './hash';

describe('cyrb53 — determinism', () => {
  it('returns the same output for the same string', () => {
    expect(cyrb53('hello world')).toBe(cyrb53('hello world'));
    expect(cyrb53('movescape::2026-08-20')).toBe(
      cyrb53('movescape::2026-08-20'),
    );
  });
});

describe('cyrb53 — sensitivity to input', () => {
  it('returns different outputs for different strings', () => {
    expect(cyrb53('hello')).not.toBe(cyrb53('hellp'));
    expect(cyrb53('seedA')).not.toBe(cyrb53('seedB'));
    expect(cyrb53('')).not.toBe(cyrb53(' '));
  });

  it('the seed parameter changes the output for the same string', () => {
    expect(cyrb53('hello world', 0)).not.toBe(cyrb53('hello world', 1));
    expect(cyrb53('paletteHue', 1)).not.toBe(cyrb53('paletteHue', 2));
  });
});

describe('cyrb53 — output shape', () => {
  it('always returns a non-negative safe integer', () => {
    const inputs = ['', 'a', 'hello world', 'movescape::user::2026-08-20', '🌱'];
    for (const input of inputs) {
      const result = cyrb53(input);
      expect(Number.isSafeInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});
