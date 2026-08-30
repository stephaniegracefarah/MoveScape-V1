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
  /** Fraction of full reveal-rate that still applies at speed=0, mirroring branch growth's own speedFloor (growthStepFor in branch.ts) -- reveal pacing ties to how fast the user is actually moving rather than advancing at a fixed real-time rate, so blossoms still creep forward at rest but reveal faster the more the user moves. Kept as its own field, independent from branch growth's speedFloor, so the founder can tune blossom-reveal pacing separately via the dev tuning panel. Per the spec's immediacy-budget principle, this scales by the tick's own honestly-recorded speed -- never noise -- so the determinism invariant (same recorded speed + dt sequence -> identical result, live or replay) still holds. */
  blossomRevealSpeedFloor: number;

  /** Cross-root bake-order safety margin (world units, same scale as targetLengthBase): the minimum lead a farther root's own growth frontier must have over a nearer branch's tipX (or a nearer blossom's own x) before that nearer content is allowed to bake permanently into the live compositor's persistent buffer (isSafeToBake in botanical.ts). Guards against the bug where two roots sharing one growth system start bunched close together near the left edge -- root index alone always makes a higher-index root farther (paler) -- so if the nearer root's branch matures and bakes first while the farther root is still catching up nearby, the farther root's later, paler bake would permanently overwrite the nearer, richer one once it arrives at the same screen position (the live compositor's own within-frame z-sort can't reconcile bakes that happen on different frames). A still-catching-up farther root can never again paint over content that already required it to be this far ahead. */
  crossRootBakeSafetyMargin: number;

  /**
   * Roadmap C1 rework (docs/HANDOFF.md Roadmap C / Session 026): the fixed,
   * small number N of PERSISTENT trunk-lineages in the single foreground
   * growth system. This is the ONLY control over "how many main branches" --
   * it is deliberately NOT scaled by `density` (the founder wants a small,
   * controlled number: 3-4 concurrent, persistent, continuous trunks).
   *
   * Each lineage is an unbroken chain of generation-0 segments: exactly one
   * is `growing` at any moment; when it matures, the lineage CONTINUES from
   * that segment's own tip (spawnTrunkContinuation) -- never handed to a
   * shared front, never re-seeded at the origin. So each lineage reads as one
   * continuous meandering line running the full length of the scroll, in its
   * own vertical band, with its own persistent `lean` (trunkLeanSpread),
   * forking + blooming along its length. Replaces the ephemeral
   * born-and-ending population (mainBranchTarget / maybeSpawnMainBranches)
   * and the near-origin resprout + single-frontier hand-off before it.
   *
   * The initial N origins (initForegroundLineages) sit near the left edge in
   * N evenly-spaced vertical bands. Dev-panel range 1..6 step 1.
   */
  trunkCount: number;

  /**
   * Roadmap C1 rework: the half-range (radians) of each trunk-lineage's
   * PERSISTENT `lean` -- a per-lineage bias, drawn once from
   * `createLabeledStream(sessionSeed, \`${systemId}:trunk${i}:lean\`)` and
   * STRATIFIED across the N lineages so trunk 0 consistently drifts one way
   * and trunk N-1 the other (`lean_i ~= trunkLeanSpread * ((i + jitter)/(N-1)
   * * 2 - 1)`). The lean is added to every segment's `sweepTarget` (the angle
   * the segment arcs toward) and, at a reduced weight, to each continuation's
   * starting direction. This is what keeps the N trunks in visually distinct
   * bands criss-crossing each other instead of collapsing together. N == 1 ->
   * lean is 0 (a single centred meander). Dev-panel range 0..1.2 step 0.02.
   */
  trunkLeanSpread: number;

  /**
   * Roadmap C1 rework: the half-range (radians) of the small SEEDED random
   * jitter added to a maturing segment's final direction when its lineage
   * spawns the successor segment (spawnTrunkContinuation) -- this is what
   * keeps the trunk meandering rather than running dead straight after each
   * continuation. Applied on top of the segment's own inherited direction and
   * the (reduced-weight) persistent lean bias. Dev-panel range 0..0.8 step
   * 0.02.
   */
  trunkContinuationJitter: number;

  /**
   * Roadmap C1 rework -- repurposed from the retired born-at-the-front
   * population model: the half-width (world units, same scale as
   * targetLengthBase) of a seeded x stagger applied to the N INITIAL trunk
   * origins (initForegroundLineages). At the default 0 every trunk starts at
   * exactly `ROOT_X_MIN` (evenly spaced in y only, no x spread); raised, the
   * origins stagger rightward slightly so the trunks don't all enter at the
   * same vertical line. Only affects the N initial origins -- continuations
   * carry on from wherever the previous segment's tip landed. Dev-panel range
   * 0..0.4 step 0.02.
   */
  mainBranchSpawnXSpread: number;

  /**
   * Roadmap C1 rework -- repurposed: extra half-height (normalized canvas-y)
   * that WIDENS the vertical band the N initial trunk origins are distributed
   * across, beyond the base `[rootYMin, rootYMin + rootYSpan]`. At the
   * default 0 the N origins are evenly spaced across exactly that base band.
   * Raised, the outermost trunks push toward the top/bottom edges so they
   * lean off-frame and are hard-clipped there (with mainBranchSpawnYOverscan
   * for the part that lands fully off-canvas). Dev-panel range 0..0.6 step
   * 0.02.
   */
  mainBranchSpawnYSpread: number;

  /**
   * Roadmap C1 rework -- repurposed: extra half-height (normalized) added on
   * top of `mainBranchSpawnYSpread` when distributing the N initial trunk
   * origins, whose purpose is to let the OUTERMOST origins land OUTSIDE
   * [0, 1] -- above the top edge or below the bottom -- so those trunks grow
   * partly off-canvas and are hard-clipped at the edge (organic edge-clipping
   * from where the trunk actually goes, not an imposed diagonal). Geometry
   * off the top/bottom is simply clipped by the compositor; it never resizes
   * the canvas (height is fixed at CANVAS_HEIGHT_PX, only width grows).
   * Dev-panel range 0..0.4 step 0.02.
   */
  mainBranchSpawnYOverscan: number;

  /**
   * Roadmap C3.5 Commit 2 (docs/HANDOFF.md Roadmap C / Session 026): the ONE
   * coordinated "how LUSH is the whole scroll" dial. Default 0.5 is a true
   * no-op -- the scene is byte-identical to leaving it out. It maps to a
   * single coordinated scalar `f = 2 ** ((density - 0.5) * 2)` (so density 0
   * -> f = 0.5, density 0.5 -> f = 1.0, density 1.0 -> f = 2.0), applied once
   * at init() on top of the individual base dials:
   *   - forkCountMin / forkCountSpan -> round(base * f)  (a base >= 1 stays >= 1)
   *   - blossomsPerCluster (the already-world-knob-mapped internal value)
   *                             -> round(base * f)
   * `trunkCount` is deliberately NOT scaled by density (the C1 rework: the
   * founder wants a small, controlled number of trunks -- lushness is forks +
   * blossoms ALONG those trunks, not more trunks). maxGeneration is also left
   * alone (its own separate dial). The individual fields still work as the
   * base values `f` multiplies, so they stay usable for fine-tuning;
   * `density` is the coordinated control on top. Pure deterministic config
   * math evaluated once at init -- no new random draws. Dev-panel range
   * 0..1 step 0.02.
   */
  density: number;

  /**
   * Forced-bake ceiling (roadmap B, docs/HANDOFF.md): the maximum SIMULATED
   * time (milliseconds, accumulated from each step()'s own `dt` -- never
   * wall-clock, never render frames, so live and replay stay bit-identical)
   * a `mature` branch, or an already-revealed blossom, may sit unresolved
   * and blocked by isSafeToBake before resolveBucketBakeThreats force-marks
   * it `bakeResolved = true` ANYWAY, regardless of what the bake-safety
   * threat model says. Botanical's front-driven resprouting spawns a fresh
   * growing branch at each generation-0 root's fixed near-origin rootX
   * forever, so there is always a low-x blocker near the origin and mature
   * branches behind it would otherwise never resolve -- staying in the live
   * per-frame redraw pass permanently, the unbounded-growth bug that
   * collapses FPS over a long session (phase 1 profiling). The founder has
   * explicitly accepted the resulting rare, small depth-ordering artifact as
   * permanent (same class as the already-accepted cross-bucket z-overlap
   * deviation). Set well above a normal quick resolve (which happens within
   * a tick or a few) so the common case is completely unaffected -- this
   * only ever fires for content that is genuinely, persistently blocked.
   * Live-tunable via the dev panel like every other field here.
   */
  forcedBakeCeilingMs: number;
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
  blossomRevealIntervalMs: 300,
  blossomRevealSpeedFloor: 0,
  // Roadmap C1 rework: 3 persistent, continuous trunk-lineages -- each one
  // unbroken meandering gen-0 chain running the full length of the scroll in
  // its own vertical band. NOT scaled by density.
  trunkCount: 3,
  // Persistent per-lineage lean, stratified across the trunks so they fan out
  // into distinct bands (0.55 rad half-range ~= +/-31 deg of arc-target bias).
  trunkLeanSpread: 0.55,
  // Small seeded meander jitter at each segment continuation (~+/-14 deg).
  trunkContinuationJitter: 0.25,
  // Roadmap C1 rework -- repurposed to spread the N INITIAL trunk origins:
  // default 0 -> all origins at ROOT_X_MIN, evenly spaced in y only. Raise
  // XSpread to stagger the origins' x; raise YSpread (+ YOverscan for the
  // fully-off-canvas part) to push the outermost trunks toward / past the
  // top and bottom edges so they lean off-frame and clip there.
  mainBranchSpawnXSpread: 0,
  mainBranchSpawnYSpread: 0,
  mainBranchSpawnYOverscan: 0,
  // Roadmap C3.5 Commit 2: 0.5 is the true no-op midpoint (f = 1.0). Lower =
  // sparser, higher = lusher -- one coordinated dial over forkCount* /
  // blossomsPerCluster (NOT trunkCount).
  density: 0.5,
  crossRootBakeSafetyMargin: 0.15,
  // ~4 simulated seconds (240 ticks at the 60 Hz fixed timestep). Long
  // enough that a normal resolve -- which lands within a tick or a few --
  // never comes close; short enough that the mature-but-blocked set
  // plateaus and drains over a long session instead of growing without
  // bound (roadmap B long-run plateau test).
  forcedBakeCeilingMs: 4000,
};
