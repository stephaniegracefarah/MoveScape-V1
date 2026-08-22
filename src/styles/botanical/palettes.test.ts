import { describe, expect, it } from 'vitest';
import { BOTANICAL_PALETTE_IDS, BOTANICAL_PALETTE_PRESETS } from './palettes';

const HEX_RE = /^#[0-9a-f]{6}$/i;

describe('BOTANICAL_PALETTE_PRESETS — shape', () => {
  it('has exactly 3 entries, one per BOTANICAL_PALETTE_ID, in declared id order', () => {
    expect(BOTANICAL_PALETTE_PRESETS.length).toBe(3);
    expect(BOTANICAL_PALETTE_PRESETS.map((p) => p.id)).toEqual([...BOTANICAL_PALETTE_IDS]);
  });

  it('every preset has a non-empty displayName', () => {
    for (const preset of BOTANICAL_PALETTE_PRESETS) {
      expect(typeof preset.displayName).toBe('string');
      expect(preset.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('BOTANICAL_PALETTE_PRESETS — colors', () => {
  for (const preset of BOTANICAL_PALETTE_PRESETS) {
    it(`${preset.id}: has at least 6 colors, all valid hex strings`, () => {
      expect(preset.colors.length).toBeGreaterThanOrEqual(6);
      for (const color of preset.colors) {
        expect(color).toMatch(HEX_RE);
      }
    });
  }
});

describe('BOTANICAL_PALETTE_PRESETS — branchColors', () => {
  for (const preset of BOTANICAL_PALETTE_PRESETS) {
    it(`${preset.id}: has 1-3 branchColors, all valid hex strings`, () => {
      expect(preset.branchColors.length).toBeGreaterThanOrEqual(1);
      expect(preset.branchColors.length).toBeLessThanOrEqual(3);
      for (const color of preset.branchColors) {
        expect(color).toMatch(HEX_RE);
      }
    });
  }
});

describe('BOTANICAL_PALETTE_PRESETS — distinctness', () => {
  it('no two palettes share an identical colors array', () => {
    const colorLists = BOTANICAL_PALETTE_PRESETS.map((p) => p.colors);
    for (const [i, a] of colorLists.entries()) {
      for (const [j, b] of colorLists.entries()) {
        if (i < j) {
          expect(a).not.toEqual(b);
        }
      }
    }
  });

  it('no two palettes share an identical branchColors array', () => {
    const branchColorLists = BOTANICAL_PALETTE_PRESETS.map((p) => p.branchColors);
    for (const [i, a] of branchColorLists.entries()) {
      for (const [j, b] of branchColorLists.entries()) {
        if (i < j) {
          expect(a).not.toEqual(b);
        }
      }
    }
  });
});
