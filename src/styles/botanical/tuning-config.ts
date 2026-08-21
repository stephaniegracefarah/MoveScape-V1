/**
 * Botanical style (spec Part 4, M4): the internal tuning constants that used
 * to be hardcoded module-level consts across branch.ts/blossom.ts/botanical.ts,
 * now collected into one config object so a dev-only tuning panel (see
 * main.ts) can override them live, per session, without a rebuild.
 *
 * These are NOT world knobs (see palettes.ts / World.knob for those) --
 * they're first-pass internal constants the founder wants to hand-tune by
 * feel. DEFAULT_BOTANICAL_TUNING_CONFIG's values are copied verbatim from
 * the former module constants, so createBotanicalStyle() with no args
 * behaves identically to before this refactor.
 */
export interface BotanicalTuningConfig {
  /** Recursion depth cap for sub-branches. Was MAX_GENERATION. */
  maxGeneration: number;
  /** Fraction of max growth rate that still applies at speed=0. Was SPEED_FLOOR. */
  speedFloor: number;
  /** How much symmetry=1 damps wander amplitude vs symmetry=0. Was SYMMETRY_DAMPING. */
  symmetryDamping: number;
  /** Scales the constant directional pull toward the world's windAngle knob. Was WIND_STRENGTH. */
  windStrength: number;
  /** grownLength (normalized units) per millisecond while shrinking. Was SHRINK_RATE. */
  shrinkRate: number;
  /** Internal per-ms growth scale folded into baseGrowthPerTick. Was BASE_GROWTH_SCALE. */
  baseGrowthScale: number;
  /** Root/generation-0 target branch length before generation decay. Was TARGET_LENGTH_BASE. */
  targetLengthBase: number;
  /** targetLength jitter multiplier span (lands in [0.7, 0.7 + span)). Was TARGET_LENGTH_JITTER_SPAN. */
  targetLengthJitterSpan: number;
  /** Each sub-branch generation is this fraction of its parent's base length. Was GENERATION_LENGTH_DECAY. */
  generationLengthDecay: number;
  /** Fixed line-segment radius (normalized, fraction of shorter side). Was BRANCH_SEGMENT_RADIUS. */
  branchSegmentRadius: number;
  /** Branch line opacity. Was BRANCH_BASE_OPACITY. */
  branchBaseOpacity: number;
  /** Max saturation (z=0). Was MAX_SAT. */
  maxSat: number;
  /** Saturation falloff toward z=1. Was SAT_FALLOFF. */
  satFalloff: number;
  /** Min lightness (z=0). Was MIN_LIGHT. */
  minLight: number;
  /** Lightness rise toward z=1. Was LIGHT_RISE. */
  lightRise: number;
  /** Root y minimum (normalized). Was ROOT_Y_MIN. */
  rootYMin: number;
  /** Root y span above rootYMin (normalized). Was ROOT_Y_SPAN. */
  rootYSpan: number;
  /** Spread (radians) around straight-up per root's base direction. Was ROOT_BASE_DIRECTION_SPREAD. */
  rootBaseDirectionSpread: number;
  /** Max per-axis z jitter for a sub-branch child relative to its parent. Was CHILD_Z_JITTER. */
  childZJitter: number;
  /** Max hue jitter (degrees) for a sub-branch child relative to its parent. Was CHILD_HUE_JITTER_DEGREES. */
  childHueJitterDegrees: number;
  /** Blossom radius range minimum (normalized). Was BLOSSOM_RADIUS_MIN. */
  blossomRadiusMin: number;
  /** Blossom radius range span above blossomRadiusMin (normalized). Was BLOSSOM_RADIUS_SPAN. */
  blossomRadiusSpan: number;
  /** Blossom opacity range minimum. Was BLOSSOM_OPACITY_MIN. */
  blossomOpacityMin: number;
  /** Blossom opacity range span above blossomOpacityMin. Was BLOSSOM_OPACITY_SPAN. */
  blossomOpacitySpan: number;
  /** Max per-axis jitter offset (normalized) around a blossom's anchor point. Was BLOSSOM_JITTER_MAX. */
  blossomJitterMax: number;
  /** Max per-blossom hue jitter (degrees) around the owning branch's hue. Was BLOSSOM_HUE_JITTER_DEGREES. */
  blossomHueJitterDegrees: number;
  /** Max per-blossom z jitter around the owning branch's z. Was BLOSSOM_Z_JITTER. */
  blossomZJitter: number;
}

export const DEFAULT_BOTANICAL_TUNING_CONFIG: BotanicalTuningConfig = {
  maxGeneration: 4,
  speedFloor: 0.06,
  symmetryDamping: 0.85,
  windStrength: 0.0005,
  shrinkRate: 0.0002,
  baseGrowthScale: 0.00005,
  targetLengthBase: 0.35,
  targetLengthJitterSpan: 0.6,
  generationLengthDecay: 0.5,
  branchSegmentRadius: 0.003,
  branchBaseOpacity: 0.92,
  maxSat: 70,
  satFalloff: 45,
  minLight: 15,
  lightRise: 65,
  rootYMin: 0.7,
  rootYSpan: 0.3,
  rootBaseDirectionSpread: 0.3,
  childZJitter: 0.05,
  childHueJitterDegrees: 15,
  blossomRadiusMin: 0.01,
  blossomRadiusSpan: 0.04,
  blossomOpacityMin: 0.3,
  blossomOpacitySpan: 0.25,
  blossomJitterMax: 0.02,
  blossomHueJitterDegrees: 10,
  blossomZJitter: 0.03,
};
