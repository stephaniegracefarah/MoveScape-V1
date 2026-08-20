/**
 * Botanical style (spec Part 4, M4): named palette presets, expressed as
 * WorldOverrides. World.knob() exact-replaces on overrides, so these are
 * the RAW [0,1) values world.knob('hueBase')/world.knob('hueSpread') must
 * return to land on the target degree ranges via botanical.ts's own
 * mapping (hueBase: raw*360; hueSpread: 10 + raw*50) -- i.e. each preset
 * here is `targetDegrees / 360` and `(targetSpreadDegrees - 10) / 50`
 * respectively, so the override and the mapping stay consistent.
 */
import type { WorldOverrides } from '../../world/world';

export const BOTANICAL_PALETTE_IDS = ['default', 'crimsonBloom', 'twilight'] as const;

export type BotanicalPaletteId = (typeof BOTANICAL_PALETTE_IDS)[number];

export interface BotanicalPalettePreset {
  id: BotanicalPaletteId;
  displayName: string;
  overrides: WorldOverrides;
}

export const BOTANICAL_PALETTES: Record<BotanicalPaletteId, WorldOverrides> = {
  // Greenish base (~100deg) with a wide spread (~55deg) reaching toward warm pink hues.
  default: { hueBase: 100 / 360, hueSpread: (55 - 10) / 50 },
  // Deep maroon/crimson base (~352deg) with a moderate spread (~25deg).
  crimsonBloom: { hueBase: 352 / 360, hueSpread: (25 - 10) / 50 },
  // Cool violet/twilight base (~260deg) with a moderate spread (~25deg).
  twilight: { hueBase: 260 / 360, hueSpread: (25 - 10) / 50 },
};

export const BOTANICAL_PALETTE_PRESETS: BotanicalPalettePreset[] = [
  { id: 'default', displayName: 'Default', overrides: BOTANICAL_PALETTES.default },
  { id: 'crimsonBloom', displayName: 'Crimson Bloom', overrides: BOTANICAL_PALETTES.crimsonBloom },
  { id: 'twilight', displayName: 'Twilight', overrides: BOTANICAL_PALETTES.twilight },
];
