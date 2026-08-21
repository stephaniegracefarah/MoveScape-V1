/**
 * Botanical style (spec Part 4, M4): Blossom data model and the pure
 * cluster-spawn helper. Randomness is drawn by the caller via a labeled
 * stream and passed in as a `draw` function so this stays deterministic
 * and independently testable (same branchId + draw sequence -> identical
 * cluster, every time).
 */
import { clamp01 } from '../../shared/math';
import { mod360 } from './branch';
import type { BotanicalTuningConfig } from './tuning-config';

export interface Blossom {
  branchId: string;
  x: number;
  y: number;
  z: number;
  hue: number;
  radius: number;
  baseOpacity: number;
}

// Internal tuning constants formerly hardcoded here (BLOSSOM_RADIUS_MIN/SPAN,
// BLOSSOM_OPACITY_MIN/SPAN, BLOSSOM_JITTER_MAX, BLOSSOM_HUE_JITTER_DEGREES,
// BLOSSOM_Z_JITTER) now live in tuning-config.ts's BotanicalTuningConfig,
// passed in via SpawnBlossomClusterArgs.tuning -- see
// DEFAULT_BOTANICAL_TUNING_CONFIG for their (unchanged) default values.

export interface SpawnBlossomClusterArgs {
  branchId: string;
  segments: { x: number; y: number }[];
  count: number;
  hue: number;
  z: number;
  /** Uniform [0,1) draw function, e.g. createLabeledStream(sessionSeed, branchId + ':blossoms'). */
  draw: () => number;
  tuning: BotanicalTuningConfig;
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

    const offsetX = (args.draw() * 2 - 1) * args.tuning.blossomJitterMax;
    const offsetY = (args.draw() * 2 - 1) * args.tuning.blossomJitterMax;
    const radius = args.tuning.blossomRadiusMin + args.draw() * args.tuning.blossomRadiusSpan;
    const baseOpacity = args.tuning.blossomOpacityMin + args.draw() * args.tuning.blossomOpacitySpan;
    const hueJitter = (args.draw() * 2 - 1) * args.tuning.blossomHueJitterDegrees;
    const zJitter = (args.draw() * 2 - 1) * args.tuning.blossomZJitter;

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
