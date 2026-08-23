/**
 * Botanical style (spec Part 4, M4 rebuild): the internal tuning constants
 * that used to be hardcoded module-level consts, now collected into one
 * config object so the dev-only tuning panel (see main.ts) can override
 * them live, per session, without a rebuild.
 *
 * This is the M4-rebuild revision (docs/styles/botanical.md), replacing the
 * hue-spread/circle-chain-era field set. Owned centrally by the coordinator
 * rather than by any one builder, since branch.ts/blossom.ts/botanical.ts
 * all read from it -- editing it in three parallel builder passes would
 * have been a guaranteed merge conflict.
 *
 * These are NOT world knobs (see palettes.ts / World.knob for those) --
 * they're first-pass internal constants the founder will hand-tune by feel
 * once the static-render gate passes.
 */
export interface BotanicalTuningConfig {
  // --- Lifecycle / growth (unchanged in role from the pre-rebuild config) ---
  /** Recursion depth cap for sub-branches. Visual spec section 2: recursion to generation 4-5. */
  maxGeneration: number;
  /** Fraction of max growth rate that still applies at speed=0. */
  speedFloor: number;
  /** How much symmetry=1 damps wander amplitude vs symmetry=0. */
  symmetryDamping: number;
  /** Scales the constant directional pull toward the world's windAngle knob. Defaults to 0 -- the new sweepStrength/sweepTarget mechanism (below) is what makes branches commit to the Scroll's overall sweep now; a nonzero windStrength alongside it can fight sweepPull (competing pulls toward two different fixed angles) and produce spiral-looking paths rather than graceful arcs. Left tunable, not removed, in case a future style wants an independent wind effect. */
  windStrength: number;
  /** Internal per-ms growth scale folded into baseGrowthPerTick. */
  baseGrowthScale: number;
  /** Root/generation-0 target branch length before generation decay (fraction of the full [0,1] normalized coordinate space, not the canvas shorter side -- see branch.ts's tickGrowing, which adds growthStep directly to tipX/tipY). Needs to be large relative to 1.0 for a dominant branch to actually sweep across the canvas width (visual spec section 6), not just a short arc. */
  targetLengthBase: number;
  /** targetLength jitter multiplier span (lands in [0.7, 0.7 + span)). */
  targetLengthJitterSpan: number;
  /** Each sub-branch generation's targetLength is this fraction of its parent's base length. Visual spec section 2: child length ~0.35-0.55x parent. */
  generationLengthDecay: number;

  // --- Branch stroke (new: replaces the circle-chain BRANCH_SEGMENT_RADIUS) ---
  /** Generation-0 branch stroke baseWidth minimum (normalized, fraction of canvas shorter side). Visual spec section 1: ~8-14px at final display scale. */
  branchBaseWidthMin: number;
  /** Generation-0 branch stroke baseWidth span above branchBaseWidthMin. */
  branchBaseWidthSpan: number;
  /** Each child generation's baseWidth is this fraction of its parent's baseWidth at the attachment point. Visual spec section 2: ~0.5-0.65x parent. */
  generationWidthDecay: number;
  /** Exponent in width(t) = baseWidth * (1-t)^taperExponent. Visual spec section 1's literal formula. */
  taperExponent: number;
  /** Branch stroke opacity. Visual spec section 1: branches are "fully opaque." */
  branchBaseOpacity: number;

  // --- Curvature / sweep (new: replaces per-tick high-frequency wander with graceful sweeping arcs) ---
  /** grownLength is multiplied by this before being sampled as a noise coordinate, so curvature varies far more slowly per unit grown ("~10x lower frequency" per visual spec section 1). */
  curvatureNoiseScale: number;
  /** Strength of the constant pull toward a branch's own sweepTarget angle (same angleDifference-pull mechanism as windStrength, just per-branch instead of per-world) -- this is what makes a branch "commit to an overall arc" instead of wandering. */
  sweepStrength: number;
  /** Minimum magnitude (radians) of a forked child's direction jitter relative to the parent's direction at the fork point. */
  childDirectionJitterMin: number;
  /** Span above childDirectionJitterMin (radians). Visual spec section 2: child direction is parent direction +/- 0.3-0.8 rad. */
  childDirectionJitterSpan: number;

  // --- Ramification (new: replaces the single maturity-time subBranchSpawnChance roll) ---
  /** Minimum number of fork points scheduled along a branch's own growth path at spawn. */
  forkCountMin: number;
  /** Span above forkCountMin. Visual spec section 2: 2-5 children total per major branch. */
  forkCountSpan: number;
  /** Earliest point (as a fraction of the branch's own targetLength) a fork may be scheduled. */
  forkFractionMin: number;
  /** Latest point (as a fraction of the branch's own targetLength) a fork may be scheduled. Visual spec section 2: a child every ~15-30% of parent length. */
  forkFractionMax: number;

  // --- Root / origin placement (composition-facing; values retuned during the Scroll composition pass) ---
  /** Root y minimum (normalized). Spans a broad middle band, not a bottom band -- growth sweeps rightward now, not upward, so roots no longer need to start low. */
  rootYMin: number;
  /** Root y span above rootYMin (normalized). */
  rootYSpan: number;
  /** Spread (radians) around a root's base direction center. */
  rootBaseDirectionSpread: number;
  /** Max per-axis z jitter for a sub-branch child relative to its parent. */
  childZJitter: number;

  // --- Blossoms (new: replaces the uniform-anchor+jitter confetti model) ---
  /** Small-blossom radius minimum (normalized, fraction of canvas shorter side). Visual spec section 3: mostly r ~= 3-10px. */
  blossomRadiusSmallMin: number;
  /** Small-blossom radius span above blossomRadiusSmallMin. */
  blossomRadiusSmallSpan: number;
  /** Large-blossom radius minimum. Visual spec section 3: a few large, r ~= 12-22px. */
  blossomRadiusLargeMin: number;
  /** Large-blossom radius span above blossomRadiusLargeMin. */
  blossomRadiusLargeSpan: number;
  /** Fraction of blossoms in a cluster drawn from the large range rather than the small range. */
  blossomLargeFraction: number;
  /** Blossom opacity range minimum. Visual spec section 3: alpha 25-60%. */
  blossomOpacityMin: number;
  /** Blossom opacity range span above blossomOpacityMin. */
  blossomOpacitySpan: number;
  /** 2D gaussian packing sigma minimum around a cluster's anchor (normalized, fraction of canvas shorter side). Visual spec section 3: sigma ~= 2-4% of canvas. */
  blossomClusterSigmaMin: number;
  /** Gaussian sigma span above blossomClusterSigmaMin. */
  blossomClusterSigmaSpan: number;
  /** Max per-blossom z jitter around the owning branch's z. */
  blossomZJitter: number;
  /** Probability a given blossom circle carries a thin, lighter ring outline (visual spec section 3's "signature Lippmann detail"). */
  blossomRingProbability: number;
  /** How much lighter (0-1, toward white) a ring color is than its circle's own fill color. */
  blossomRingLightenAmount: number;
  /** Probability a given blossom circle's color is drawn from anywhere in the palette rather than the cluster's own base tone (visual spec section 4's "~40% cross-draw"). */
  blossomCrossDrawProbability: number;
  /** Milliseconds between each individual blossom's reveal within a freshly-matured cluster (founder request, session 011: "1 by 1 as if someone was doing watercolor" rather than a cluster popping in all at once). A cluster's full membership is still decided deterministically the instant its branch matures (spawnBlossomsFor) -- this only paces how many of those already-decided blossoms have been added to the rendered/scene-visible list so far, driven purely by dt (fixed-timestep, invariant 4), never wall-clock. */
  blossomRevealIntervalMs: number;
}

export const DEFAULT_BOTANICAL_TUNING_CONFIG: BotanicalTuningConfig = {
  maxGeneration: 5,
  speedFloor: 0.06,
  symmetryDamping: 0.85,
  windStrength: 0,
  baseGrowthScale: 0.00005,
  targetLengthBase: 0.65,
  targetLengthJitterSpan: 0.6,
  generationLengthDecay: 0.5,

  branchBaseWidthMin: 0.017,
  branchBaseWidthSpan: 0.012,
  generationWidthDecay: 0.575,
  taperExponent: 1.4,
  branchBaseOpacity: 1,

  curvatureNoiseScale: 0.1,
  sweepStrength: 0.002,
  childDirectionJitterMin: 0.3,
  childDirectionJitterSpan: 0.5,

  forkCountMin: 2,
  forkCountSpan: 4,
  forkFractionMin: 0.15,
  forkFractionMax: 0.85,

  rootYMin: 0.35,
  rootYSpan: 0.35,
  rootBaseDirectionSpread: 0.3,
  childZJitter: 0.05,

  blossomRadiusSmallMin: 0.006,
  blossomRadiusSmallSpan: 0.015,
  blossomRadiusLargeMin: 0.025,
  blossomRadiusLargeSpan: 0.021,
  blossomLargeFraction: 0.15,
  blossomOpacityMin: 0.25,
  blossomOpacitySpan: 0.35,
  blossomClusterSigmaMin: 0.02,
  blossomClusterSigmaSpan: 0.02,
  blossomZJitter: 0.03,
  blossomRingProbability: 0.2,
  blossomRingLightenAmount: 0.3,
  blossomCrossDrawProbability: 0.4,
  blossomRevealIntervalMs: 40,
};
