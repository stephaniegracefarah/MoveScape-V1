/**
 * Botanical style (spec Part 4, M4): Blossom data model and the pure
 * cluster-spawn helper. Randomness is drawn by the caller via a labeled
 * stream and passed in as a `draw` function so this stays deterministic
 * and independently testable (same branchId + draw sequence -> identical
 * cluster, every time).
 */
import { clamp01 } from '../../shared/math';
import { mod360 } from './branch';

export interface Blossom {
  branchId: string;
  x: number;
  y: number;
  z: number;
  hue: number;
  radius: number;
  baseOpacity: number;
}

// --- Internal constants (not world knobs -- first-pass values). ---

/** Blossom radius range (normalized, fraction of shorter side): [0.01, 0.05). */
export const BLOSSOM_RADIUS_MIN = 0.01;
export const BLOSSOM_RADIUS_SPAN = 0.04;

/** Genuine translucency range so overlapping blossoms visibly darken via
 * canvas alpha compositing: [0.3, 0.55). */
export const BLOSSOM_OPACITY_MIN = 0.3;
export const BLOSSOM_OPACITY_SPAN = 0.25;

/** Max per-axis jitter offset (normalized) around a blossom's anchor
 * segment point, so blossoms cluster around but don't sit exactly on the line. */
export const BLOSSOM_JITTER_MAX = 0.02;

/** Small per-blossom hue jitter around the owning branch's hue (degrees). */
export const BLOSSOM_HUE_JITTER_DEGREES = 10;

/** Small per-blossom z jitter around the owning branch's z. */
export const BLOSSOM_Z_JITTER = 0.03;

export interface SpawnBlossomClusterArgs {
  branchId: string;
  segments: { x: number; y: number }[];
  count: number;
  hue: number;
  z: number;
  /** Uniform [0,1) draw function, e.g. createLabeledStream(sessionSeed, branchId + ':blossoms'). */
  draw: () => number;
}

/**
 * Spawns a full blossom cluster (exactly `count` blossoms) anchored near
 * the outer ~30% of a branch's segment history, each jittered slightly off
 * its anchor point. Draws exactly 6 values per blossom, in a fixed order,
 * from the caller-supplied `draw` -- deterministic for a given draw sequence.
 */
export function spawnBlossomCluster(args: SpawnBlossomClusterArgs): Blossom[] {
  const blossoms: Blossom[] = [];
  const lastIndex = args.segments.length - 1;

  for (let i = 0; i < args.count; i++) {
    const anchorFraction = 0.7 + args.draw() * 0.3;
    const anchorIndex = Math.min(lastIndex, Math.floor(anchorFraction * args.segments.length));
    // segments is always non-empty (spawnBranch seeds it with the root
    // point), so the lastIndex fallback is always defined -- the `!` just
    // tells TS what the array's non-empty invariant already guarantees.
    const anchor = args.segments[anchorIndex] ?? args.segments[lastIndex]!;

    const offsetX = (args.draw() * 2 - 1) * BLOSSOM_JITTER_MAX;
    const offsetY = (args.draw() * 2 - 1) * BLOSSOM_JITTER_MAX;
    const radius = BLOSSOM_RADIUS_MIN + args.draw() * BLOSSOM_RADIUS_SPAN;
    const baseOpacity = BLOSSOM_OPACITY_MIN + args.draw() * BLOSSOM_OPACITY_SPAN;
    const hueJitter = (args.draw() * 2 - 1) * BLOSSOM_HUE_JITTER_DEGREES;
    const zJitter = (args.draw() * 2 - 1) * BLOSSOM_Z_JITTER;

    blossoms.push({
      branchId: args.branchId,
      x: clamp01(anchor.x + offsetX),
      y: clamp01(anchor.y + offsetY),
      z: clamp01(args.z + zJitter),
      hue: mod360(args.hue + hueJitter),
      radius,
      baseOpacity,
    });
  }

  return blossoms;
}
