import { describe, expect, it } from 'vitest';
import { cyrb53, cyrb53Bytes } from './hash';

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

describe('cyrb53Bytes — determinism', () => {
  it('returns the same output for the same bytes', () => {
    const bytesA = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const bytesB = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    expect(cyrb53Bytes(bytesA)).toBe(cyrb53Bytes(bytesB));
  });
});

describe('cyrb53Bytes — sensitivity to input', () => {
  it('returns different outputs for different bytes', () => {
    expect(cyrb53Bytes(new Uint8Array([1, 2, 3]))).not.toBe(
      cyrb53Bytes(new Uint8Array([1, 2, 4])),
    );
    expect(cyrb53Bytes(new Uint8Array([]))).not.toBe(cyrb53Bytes(new Uint8Array([0])));
  });
});

describe('cyrb53Bytes — byte-indexed, not type-dependent', () => {
  it('a Uint8Array and a Uint8ClampedArray with the same byte values hash the same', () => {
    const values = [10, 20, 30, 200, 255, 0, 128];
    const asUint8 = new Uint8Array(values);
    const asClamped = new Uint8ClampedArray(values);
    expect(cyrb53Bytes(asUint8)).toBe(cyrb53Bytes(asClamped));
  });
});

describe('cyrb53Bytes — output shape', () => {
  it('always returns a non-negative safe integer', () => {
    const inputs = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8ClampedArray([255, 255, 255, 255]),
    ];
    for (const input of inputs) {
      const result = cyrb53Bytes(input);
      expect(Number.isSafeInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});
