/**
 * Botanical style (spec Part 4, M4): Blossom data model and the pure
 * cluster-spawn helper. Randomness is drawn by the caller via a labeled
 * stream and passed in as a `draw` function so this stays deterministic
 * and independently testable (same branchId + draw sequence -> identical
 * cluster, every time).
 */
import { clamp01 } from '../../shared/math';
import type { BotanicalTuningConfig } from './tuning-config';

export interface Blossom {
  branchId: string;
  /** Which root (0-based, within its own growth system) the owning branch's lineage descends from -- threaded through from `branch.rootIndex` at spawn (spawnBlossomsFor in botanical.ts). Used by the cross-root bake-order safety check (isSafeToBake in botanical.ts) the same way Branch.rootIndex is. */
  rootIndex: number;
  x: number;
  y: number;
  z: number;
  color: string;
  /** Present only when this blossom carries the thin ring-outline detail (docs/styles/botanical.md section 3). */
  ringColor?: string;
  ringOpacity?: number;
  radius: number;
  baseOpacity: number;
  /**
   * True once this ALREADY-REVEALED blossom has been resolved safe to
   * permanently bake into the live compositor's persistent buffer
   * (botanical.ts's resolveBucketBakeThreats/isSafeToBake) -- mirrors
   * Branch.bakeResolved exactly, but starts meaningful only once a blossom
   * is revealed (botanical.ts's revealPendingBlossoms; a still-pending,
   * not-yet-revealed blossom isn't part of the scene at all, so this field
   * is irrelevant, though always present, for those). Session 021
   * (docs/HANDOFF.md): reveal timing and bake-order safety were decoupled
   * -- a blossom becomes VISIBLE purely on the founder-tuned watercolor
   * timer, independent of this flag; this flag only controls whether it's
   * baked once, permanently, or redrawn live every frame in the meantime
   * (exactly the growing-vs-mature-and-safe distinction a Branch already
   * has). Starts false and, once flipped true, stays true forever -- same
   * "never revisited" performance shape Branch.bakeResolved documents.
   */
  bakeResolved: boolean;
}

// Internal tuning constants formerly hardcoded here (BLOSSOM_RADIUS_MIN/SPAN,
// BLOSSOM_OPACITY_MIN/SPAN, BLOSSOM_JITTER_MAX, BLOSSOM_HUE_JITTER_DEGREES,
// BLOSSOM_Z_JITTER) now live in tuning-config.ts's BotanicalTuningConfig,
// passed in via SpawnBlossomClusterArgs.tuning -- see
// DEFAULT_BOTANICAL_TUNING_CONFIG for their (unchanged) default values.

export interface SpawnBlossomClusterArgs {
  branchId: string;
  rootIndex: number;
  segments: { x: number; y: number }[];
  count: number;
  /** Curated palette color list for this cluster (docs/styles/botanical.md section 4), at least 1 entry, hex strings like '#a31621'. */
  paletteColors: string[];
  z: number;
  /** Uniform [0,1) draw function, e.g. createLabeledStream(sessionSeed, branchId + ':blossoms'). */
  draw: () => number;
  tuning: BotanicalTuningConfig;
}

/**
 * Standard Box-Muller transform: turns two independent uniform [0,1) draws
 * into one standard-normal (mean 0, stddev 1) sample. `Math.max(u1, 1e-9)`
 * guards against log(0) if the seeded stream ever produces exactly 0 --
 * extremely unlikely but keeps the function total.
 */
function sampleGaussian(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-9))) * Math.cos(2 * Math.PI * u2);
}

/**
 * Lightens a '#rrggbb' hex color toward white by `amount` (0-1). Pure string
 * math, no color-space conversion needed for this small a nudge.
 */
export function lightenHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const lighten = (channel: number) => Math.round(channel + (255 - channel) * amount);
  const toHex = (channel: number) => channel.toString(16).padStart(2, '0');
  return `#${toHex(lighten(r))}${toHex(lighten(g))}${toHex(lighten(b))}`;
}

/**
 * Spawns a full blossom cluster (exactly `count` blossoms): dense, 2D
 * gaussian-packed mass around a single anchor point, with a size mixture
 * (mostly small, a few large) and rich color mixing drawn from a curated
 * palette (docs/styles/botanical.md sections 3-4), instead of the old
 * uniform-jitter/single-hue confetti model.
 *
 * Draw order:
 *  1. Once for the whole cluster: anchorFraction (picks the anchor point
 *     from `segments`), then baseColorIndex (picks the cluster's base tone
 *     from `paletteColors`).
 *  2. Per blossom, in order: sigma, two pairs of uniforms for the gaussian
 *     x/y offsets (u1x, u2x, u1y, u2y), isLarge, radius, baseOpacity,
 *     crossDraw (+ a palette index draw only when crossDraw is true),
 *     zJitter, hasRing.
 *
 * Deterministic for a given draw sequence -- same inputs always produce the
 * same cluster.
 */
export function spawnBlossomCluster(args: SpawnBlossomClusterArgs): Blossom[] {
  const blossoms: Blossom[] = [];
  const lastIndex = args.segments.length - 1;

  // --- Cluster-wide picks (drawn once, not per-circle) ---
  const anchorFraction = 0.7 + args.draw() * 0.3;
  const anchorIndex = Math.min(lastIndex, Math.floor(anchorFraction * args.segments.length));
  // segments is always non-empty (spawnBranch seeds it with the root
  // point), so the lastIndex fallback is always defined -- the `!` just
  // tells TS what the array's non-empty invariant already guarantees.
  const anchor = args.segments[anchorIndex] ?? args.segments[lastIndex]!;

  const baseColorIndex = Math.floor(args.draw() * args.paletteColors.length);
  const baseColor = args.paletteColors[baseColorIndex]!;

  for (let i = 0; i < args.count; i++) {
    // Position: 2D gaussian packing around the anchor.
    const sigma = args.tuning.blossomClusterSigmaMin + args.draw() * args.tuning.blossomClusterSigmaSpan;
    const offsetX = sampleGaussian(args.draw(), args.draw()) * sigma;
    const offsetY = sampleGaussian(args.draw(), args.draw()) * sigma;

    // Size mixture: mostly small, a few large.
    const isLarge = args.draw() < args.tuning.blossomLargeFraction;
    const radius = isLarge
      ? args.tuning.blossomRadiusLargeMin + args.draw() * args.tuning.blossomRadiusLargeSpan
      : args.tuning.blossomRadiusSmallMin + args.draw() * args.tuning.blossomRadiusSmallSpan;

    const baseOpacity = args.tuning.blossomOpacityMin + args.draw() * args.tuning.blossomOpacitySpan;

    // Color: cluster's own base tone, or (cross-draw) anywhere in the palette.
    const crossDraw = args.draw() < args.tuning.blossomCrossDrawProbability;
    const color = crossDraw ? args.paletteColors[Math.floor(args.draw() * args.paletteColors.length)]! : baseColor;

    const zJitter = (args.draw() * 2 - 1) * args.tuning.blossomZJitter;

    // Ring outline: a thin ring, slightly lighter than the circle's own fill.
    const hasRing = args.draw() < args.tuning.blossomRingProbability;

    const blossom: Blossom = {
      branchId: args.branchId,
      rootIndex: args.rootIndex,
      // x mirrors branch.ts's tickGrowing: world-space and unbounded, not
      // clamped to [0,1] -- only y (the canvas's fixed height) is.
      x: anchor.x + offsetX,
      y: clamp01(anchor.y + offsetY),
      z: clamp01(args.z + zJitter),
      color,
      radius,
      baseOpacity,
      bakeResolved: false,
    };

    if (hasRing) {
      blossom.ringColor = lightenHex(color, args.tuning.blossomRingLightenAmount);
      blossom.ringOpacity = baseOpacity;
    }

    blossoms.push(blossom);
  }

  return blossoms;
}
