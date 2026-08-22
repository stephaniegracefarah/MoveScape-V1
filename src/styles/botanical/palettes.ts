/**
 * Botanical style (spec Part 4, M4): named palette presets, expressed as
 * curated color lists.
 *
 * Botanical no longer picks colors via hueBase/hueSpread (a single hue ±
 * a spread, driving saturation/lightness formulas) -- that scheme cannot
 * produce near-blacks and creams in the same cluster. Instead each preset
 * is a small hand-picked list of specific hex colors spanning value
 * extremes (near-black through pale/cream) within a family. A blossom
 * cluster draws individual circles from `colors` (mostly near a chosen
 * base tone, some cross-drawn from anywhere in the list) to get the
 * cream-next-to-crimson richness the reference shows. Branches draw their
 * stroke color only from the much smaller `branchColors` subset, so
 * branches read as "very dark, warm, not pure black" -- visually distinct
 * from what blossoms do. See docs/styles/botanical.md section 4.
 */

export const BOTANICAL_PALETTE_IDS = ['default', 'crimsonBloom', 'twilight'] as const;

export type BotanicalPaletteId = (typeof BOTANICAL_PALETTE_IDS)[number];

export interface BotanicalPalette {
  id: BotanicalPaletteId;
  displayName: string;
  /** The full curated list a blossom cluster draws from -- hex strings, spanning value extremes (near-black through pale/cream) within this palette's family. At least 6 entries. */
  colors: string[];
  /** A small subset of `colors` (1-3 entries) that are near-black/dark -- branches draw their own stroke color from this subset, never from the full `colors` list (branches read as "very dark, warm, not pure black," per docs/styles/botanical.md section 1 -- visually distinct from what blossoms do). */
  branchColors: string[];
}

export const BOTANICAL_PALETTE_PRESETS: BotanicalPalette[] = [
  {
    id: 'default',
    displayName: 'Default',
    // The visual spec's own reference family (docs/styles/botanical.md section 4), verbatim.
    colors: [
      '#a31621', // deep crimson
      '#7c0f1c', // dark red
      '#4a1218', // maroon
      '#2a0d10', // near-black
      '#c4707d', // dusty rose
      '#e8b4b8', // blush
      '#f2e3d5', // cream
      '#f0d7d7', // pale pink
    ],
    branchColors: [
      '#2a0d10', // the palette's own near-black
      '#2e1518', // spec section 1's literal branch-color example: warm near-black maroon/brown, not pure black
    ],
  },
  {
    id: 'crimsonBloom',
    displayName: 'Crimson Bloom',
    // Warm reds staying closer to true crimson/scarlet than default's maroon-leaning family.
    colors: [
      '#590a12', // near-black crimson
      '#8c0f1f', // dark scarlet
      '#c41e3a', // crimson
      '#e0344f', // bright scarlet-red
      '#f0748a', // warm coral-pink
      '#f7a9b4', // light rose
      '#fbd9d0', // pale peach-cream
      '#fff1e6', // near-white warm cream
    ],
    branchColors: [
      '#590a12', // palette's own near-black crimson
      '#3a0c14', // extra near-black, warm and not pure black
    ],
  },
  {
    id: 'twilight',
    displayName: 'Twilight',
    // Cool violet/blue-purple dusk tones, near-black through pale lavender/lilac.
    colors: [
      '#1c1230', // near-black indigo
      '#2e1a4d', // deep violet
      '#4b2e83', // dusk purple
      '#6f4aa8', // mid violet
      '#9b7bc4', // dusty lavender
      '#c3aee0', // soft lilac
      '#e2d6f2', // pale lavender
      '#f0e9f8', // near-white violet mist
    ],
    branchColors: [
      '#1c1230', // palette's own near-black indigo
      '#241639', // extra near-black, warm-cool blend, not pure black
    ],
  },
];
