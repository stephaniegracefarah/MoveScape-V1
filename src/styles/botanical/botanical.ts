/**
 * Botanical style (spec Part 4, M4): the experience MVP. Thin, dark,
 * curving line-branches fan out from a handful of root points, mature
 * into clusters of translucent blossoms, then shrink away and (for root
 * branches) resprout -- forever. See branch.ts/blossom.ts for the pure,
 * independently-tested growth/wander/lifecycle/spawn math this file wires
 * together; this file owns the mutable active-branch/blossom lists and the
 * StyleRenderer lifecycle (init/step/scene/finish).
 */
import type { MovementParams } from '../../adapters/movement-params';
import { clamp01 } from '../../shared/math';
import { createLabeledNoise } from '../../world/labeled-noise';
import { createLabeledStream } from '../../world/labeled-stream';
import type { World } from '../../world/world';
import type { Scene, SceneElement, StyleRenderer } from '../style-renderer';
import {
  computeColor,
  computeHue,
  computeMatureDurationMs,
  computeShrinkDurationMs,
  computeTargetLength,
  mod360,
  spawnBranch,
  tickGrowing,
  visibleSegmentCount,
  type Branch,
} from './branch';
import { spawnBlossomCluster, type Blossom } from './blossom';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './tuning-config';

// --- World-knob range mappings (each documented at its own line; exact
// values are a first-pass, expected to get retuned after a live visual pass). ---

const HUE_SPREAD_MIN = 10;
const HUE_SPREAD_SPAN = 50; // hueSpread lands in [10, 60) degrees

const BRANCH_DENSITY_MIN = 8;
const BRANCH_DENSITY_SPAN = 32; // maxConcurrentBranches lands in [8, 40)

const GROWTH_RATE_MIN = 0.5;
const GROWTH_RATE_SPAN = 1.5; // baseGrowthRate lands in [0.5, 2.0)

const MATURE_DURATION_MIN = 3000;
const MATURE_DURATION_SPAN = 9000; // baseMatureDurationMs lands in [3000, 12000) ms

const ROOT_COUNT_MIN = 3;
const ROOT_COUNT_SPAN = 4; // rootCount lands in [3, 6]

const BRANCH_SPREAD_MIN = 0.3;
const BRANCH_SPREAD_SPAN = 0.9; // branchSpreadBase lands in [0.3, 1.2) radians

const WANDER_AMPLITUDE_MIN = 0.02;
const WANDER_AMPLITUDE_SPAN = 0.13; // wanderAmplitudeBase lands in [0.02, 0.15) radians

const BLOSSOMS_PER_CLUSTER_MIN = 6;
const BLOSSOMS_PER_CLUSTER_SPAN = 13; // blossomsPerCluster lands in [6, 18]

// Root point y-range, sub-branch jitter, MAX_GENERATION, growth/length/color
// formula constants, etc. formerly lived here as local consts -- they now
// live in tuning-config.ts's BotanicalTuningConfig (state.tuning.*), since
// they're the values the dev tuning panel (main.ts) needs to override live.

// Pre-first-step() spawn spread default: no step() has run yet at init(),
// so root branches spawn using a neutral mid-range "current expansion".
const DEFAULT_EXPANSION_BEFORE_FIRST_STEP = 0.5;

const WORLD_KNOB_NAMES = [
  'hueBase',
  'hueSpread',
  'branchDensity',
  'baseGrowthRate',
  'matureDurationMs',
  'windAngle',
  'rootCount',
  'branchSpreadBase',
  'wanderAmplitudeBase',
  'blossomsPerCluster',
  'subBranchSpawnChance',
] as const;

interface RootPoint {
  x: number;
  y: number;
  z: number;
  baseDirectionCenter: number;
}

/**
 * Everything the StyleRenderer factory mutates over a session, held in one
 * place so a test-only entry point can reach in directly (see
 * createBotanicalInternal below) without widening StyleRenderer's own
 * public interface.
 */
export interface BotanicalState {
  sessionSeed: string;
  roots: RootPoint[];
  branches: Branch[];
  blossoms: Blossom[];
  resproutCounters: Map<number, number>;
  latestParams: MovementParams | undefined;

  /** Resolved once at renderer creation (see createBotanicalInternal) --
   * DEFAULT_BOTANICAL_TUNING_CONFIG merged with any caller-supplied partial
   * override, constant for the renderer's whole lifetime. */
  tuning: BotanicalTuningConfig;

  hueBaseDegrees: number;
  hueSpreadDegrees: number;
  maxConcurrentBranches: number;
  baseGrowthRate: number;
  baseGrowthPerTick: number;
  baseMatureDurationMs: number;
  windAngle: number;
  rootCount: number;
  branchSpreadBase: number;
  wanderAmplitudeBase: number;
  blossomsPerCluster: number;
  subBranchSpawnChance: number;
}

function createEmptyState(tuning: BotanicalTuningConfig): BotanicalState {
  return {
    sessionSeed: '',
    roots: [],
    branches: [],
    blossoms: [],
    resproutCounters: new Map(),
    latestParams: undefined,
    tuning,
    hueBaseDegrees: 0,
    hueSpreadDegrees: 0,
    maxConcurrentBranches: 0,
    baseGrowthRate: 0,
    baseGrowthPerTick: 0,
    baseMatureDurationMs: 0,
    windAngle: 0,
    rootCount: 0,
    branchSpreadBase: 0,
    wanderAmplitudeBase: 0,
    blossomsPerCluster: 0,
    subBranchSpawnChance: 0,
  };
}

function currentExpansion(state: BotanicalState): number {
  return state.latestParams?.expansion ?? DEFAULT_EXPANSION_BEFORE_FIRST_STEP;
}

/** Draws every field for a fresh generation-0 branch at `rootIndex` and returns it (not yet pushed). */
function spawnRootBranch(state: BotanicalState, rootIndex: number): Branch {
  // rootIndex always comes from a valid range (0..rootCount-1, or a parsed
  // resprout id that originated from one of those), so this is always defined.
  const root = state.roots[rootIndex]!;
  const counter = state.resproutCounters.get(rootIndex) ?? 0;
  state.resproutCounters.set(rootIndex, counter + 1);
  const id = `root${rootIndex}:${counter}`;

  const spread = state.branchSpreadBase * (0.4 + 0.6 * currentExpansion(state));
  const directionDraw = createLabeledStream(state.sessionSeed, `${id}:spawnDirection`)();
  const baseDirection = root.baseDirectionCenter + (directionDraw * 2 - 1) * spread;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${id}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, 0, state.tuning);

  const hueDraw = createLabeledStream(state.sessionSeed, `${id}:hue`)();
  const hue = computeHue(state.hueBaseDegrees, state.hueSpreadDegrees, hueDraw * 2 - 1);

  return spawnBranch({
    id,
    generation: 0,
    z: root.z,
    hue,
    rootX: root.x,
    rootY: root.y,
    baseDirection,
    targetLength,
  });
}

/** Draws every field for a fresh sub-branch child anchored on `parent`'s own segment history. */
function spawnChildBranch(state: BotanicalState, parent: Branch): Branch {
  const childId = `${parent.id}/child0`;

  const anchorFractionDraw = createLabeledStream(state.sessionSeed, `${parent.id}:subBranchAnchor`)();
  const anchorFraction = 0.5 + anchorFractionDraw * 0.5;
  const anchorIndex = Math.min(
    parent.segments.length - 1,
    Math.floor(anchorFraction * parent.segments.length),
  );
  // parent.segments is always non-empty, so this fallback is always defined.
  const anchor = parent.segments[anchorIndex] ?? parent.segments[parent.segments.length - 1]!;

  const zJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:zJitter`)();
  const z = clamp01(parent.z + (zJitterDraw * 2 - 1) * state.tuning.childZJitter);

  const hueJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:hueJitter`)();
  const hue = mod360(parent.hue + (hueJitterDraw * 2 - 1) * state.tuning.childHueJitterDegrees);

  const generation = parent.generation + 1;
  const spread = state.branchSpreadBase * (0.4 + 0.6 * currentExpansion(state));
  const directionDraw = createLabeledStream(state.sessionSeed, `${childId}:spawnDirection`)();
  const baseDirection = parent.direction + (directionDraw * 2 - 1) * spread;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${childId}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, generation, state.tuning);

  return spawnBranch({
    id: childId,
    generation,
    z,
    hue,
    rootX: anchor.x,
    rootY: anchor.y,
    baseDirection,
    targetLength,
  });
}

function spawnBlossomsFor(state: BotanicalState, branch: Branch): Blossom[] {
  const draw = createLabeledStream(state.sessionSeed, `${branch.id}:blossoms`);
  return spawnBlossomCluster({
    branchId: branch.id,
    segments: branch.segments,
    count: state.blossomsPerCluster,
    hue: branch.hue,
    z: branch.z,
    draw,
    tuning: state.tuning,
  });
}

function initState(state: BotanicalState, world: World): void {
  state.sessionSeed = world.sessionSeed;

  const hueBaseRaw = world.knob('hueBase');
  const hueSpreadRaw = world.knob('hueSpread');
  const branchDensityRaw = world.knob('branchDensity');
  const baseGrowthRateRaw = world.knob('baseGrowthRate');
  const matureDurationRaw = world.knob('matureDurationMs');
  const windAngleRaw = world.knob('windAngle');
  const rootCountRaw = world.knob('rootCount');
  const branchSpreadBaseRaw = world.knob('branchSpreadBase');
  const wanderAmplitudeBaseRaw = world.knob('wanderAmplitudeBase');
  const blossomsPerClusterRaw = world.knob('blossomsPerCluster');
  const subBranchSpawnChanceRaw = world.knob('subBranchSpawnChance');

  state.hueBaseDegrees = hueBaseRaw * 360;
  state.hueSpreadDegrees = HUE_SPREAD_MIN + hueSpreadRaw * HUE_SPREAD_SPAN;
  state.maxConcurrentBranches = BRANCH_DENSITY_MIN + Math.floor(branchDensityRaw * BRANCH_DENSITY_SPAN);
  state.baseGrowthRate = GROWTH_RATE_MIN + baseGrowthRateRaw * GROWTH_RATE_SPAN;
  state.baseGrowthPerTick = state.baseGrowthRate * state.tuning.baseGrowthScale;
  state.baseMatureDurationMs = MATURE_DURATION_MIN + matureDurationRaw * MATURE_DURATION_SPAN;
  state.windAngle = windAngleRaw * Math.PI * 2;
  state.rootCount = ROOT_COUNT_MIN + Math.floor(rootCountRaw * ROOT_COUNT_SPAN);
  state.branchSpreadBase = BRANCH_SPREAD_MIN + branchSpreadBaseRaw * BRANCH_SPREAD_SPAN;
  state.wanderAmplitudeBase = WANDER_AMPLITUDE_MIN + wanderAmplitudeBaseRaw * WANDER_AMPLITUDE_SPAN;
  state.blossomsPerCluster = BLOSSOMS_PER_CLUSTER_MIN + Math.floor(blossomsPerClusterRaw * BLOSSOMS_PER_CLUSTER_SPAN);
  state.subBranchSpawnChance = subBranchSpawnChanceRaw;

  state.latestParams = undefined;
  state.resproutCounters = new Map();
  state.roots = [];
  state.branches = [];
  state.blossoms = [];

  // Root points: drawn once, sequentially, from a single session-level
  // stream (not per-root streams) -- spec Part 4's documented init order.
  const rootsDraw = createLabeledStream(state.sessionSeed, 'botanical-roots');
  for (let i = 0; i < state.rootCount; i++) {
    const x = rootsDraw();
    const y = state.tuning.rootYMin + rootsDraw() * state.tuning.rootYSpan;
    const zJitter = rootsDraw();
    const dirJitter = rootsDraw();
    const z = clamp01((i + zJitter) / state.rootCount);
    const baseDirectionCenter = -Math.PI / 2 + (dirJitter * 2 - 1) * state.tuning.rootBaseDirectionSpread;

    state.roots.push({ x, y, z, baseDirectionCenter });
    state.resproutCounters.set(i, 0);
    state.branches.push(spawnRootBranch(state, i));
  }
}

function stepState(state: BotanicalState, params: MovementParams, dt: number): void {
  state.latestParams = params;

  const toRemoveIds = new Set<string>();
  const newBranches: Branch[] = [];

  for (const branch of state.branches) {
    if (branch.lifecycle === 'growing') {
      const noise01 = createLabeledNoise(state.sessionSeed, `${branch.id}:wander`)(branch.grownLength);
      const becameMature = tickGrowing(branch, {
        dt,
        speed: params.speed,
        symmetry: params.symmetry,
        expansion: params.expansion,
        windAngle: state.windAngle,
        noise01,
        baseGrowthPerTick: state.baseGrowthPerTick,
        wanderAmplitudeBase: state.wanderAmplitudeBase,
        tuning: state.tuning,
      });

      if (becameMature) {
        branch.lifecycle = 'mature';
        branch.lifecycleTimer = 0;
        const jitterDraw = createLabeledStream(state.sessionSeed, `${branch.id}:matureDuration`)();
        branch.matureDurationMs = computeMatureDurationMs(state.baseMatureDurationMs, jitterDraw);
        state.blossoms.push(...spawnBlossomsFor(state, branch));
      }
    } else if (branch.lifecycle === 'mature') {
      branch.lifecycleTimer += dt;

      if (!branch.subBranchRolled) {
        branch.subBranchRolled = true;
        const rollDraw = createLabeledStream(state.sessionSeed, `${branch.id}:subBranchRoll`)();
        const liveCount = state.branches.length + newBranches.length;
        if (
          rollDraw < state.subBranchSpawnChance &&
          branch.generation < state.tuning.maxGeneration &&
          liveCount < state.maxConcurrentBranches
        ) {
          newBranches.push(spawnChildBranch(state, branch));
        }
      }

      if (branch.lifecycleTimer >= branch.matureDurationMs) {
        branch.lifecycle = 'shrinking';
        branch.lifecycleTimer = 0;
        branch.shrinkDurationMs = computeShrinkDurationMs(branch.grownLength, state.tuning);
        branch.shrinkProgress = 0;
      }
    } else {
      // shrinking
      branch.lifecycleTimer += dt;
      branch.shrinkProgress = clamp01(branch.lifecycleTimer / branch.shrinkDurationMs);

      if (branch.shrinkProgress >= 1) {
        toRemoveIds.add(branch.id);
        if (branch.generation === 0) {
          const rootIndex = Number(branch.id.split(':')[0]?.replace('root', ''));
          newBranches.push(spawnRootBranch(state, rootIndex));
        }
      }
    }
  }

  if (toRemoveIds.size > 0) {
    state.branches = state.branches.filter((b) => !toRemoveIds.has(b.id));
    state.blossoms = state.blossoms.filter((b) => !toRemoveIds.has(b.branchId));
  }
  if (newBranches.length > 0) {
    state.branches.push(...newBranches);
  }
}

function buildScene(state: BotanicalState): Scene {
  const elements: SceneElement[] = [];
  const branchById = new Map(state.branches.map((b) => [b.id, b]));

  for (const branch of state.branches) {
    const visibleCount =
      branch.lifecycle === 'shrinking'
        ? visibleSegmentCount(branch.segments.length, branch.shrinkProgress)
        : branch.segments.length;
    const color = computeColor(branch.hue, branch.z, state.tuning);

    for (let i = 0; i < visibleCount; i++) {
      // visibleCount is always <= branch.segments.length (see visibleSegmentCount).
      const point = branch.segments[i]!;
      elements.push({
        kind: 'circle',
        z: branch.z,
        x: point.x,
        y: point.y,
        radius: state.tuning.branchSegmentRadius,
        opacity: state.tuning.branchBaseOpacity,
        color,
      });
    }
  }

  for (const blossom of state.blossoms) {
    const owner = branchById.get(blossom.branchId);
    if (!owner) continue;
    const shrinkFade = owner.lifecycle === 'shrinking' ? 1 - owner.shrinkProgress : 1;
    elements.push({
      kind: 'circle',
      z: blossom.z,
      x: blossom.x,
      y: blossom.y,
      radius: blossom.radius,
      opacity: blossom.baseOpacity * shrinkFade,
      color: computeColor(blossom.hue, blossom.z, state.tuning),
    });
  }

  return { elements };
}

/**
 * Builds the StyleRenderer plus a direct handle onto its mutable internal
 * state. The state handle is NOT part of StyleRenderer and never used by
 * production code -- it exists purely so tests can measure exact internal
 * quantities (e.g. a branch's grownLength) instead of reverse-engineering
 * them from opaque SceneElement geometry, without widening the interface
 * every style must implement.
 */
export function createBotanicalInternal(tuning?: Partial<BotanicalTuningConfig>): {
  renderer: StyleRenderer;
  state: BotanicalState;
} {
  const resolvedTuning: BotanicalTuningConfig = { ...DEFAULT_BOTANICAL_TUNING_CONFIG, ...tuning };
  const state = createEmptyState(resolvedTuning);

  const renderer: StyleRenderer = {
    id: 'botanical',
    name: 'Botanical',
    aestheticFamily: 'organic',

    worldKnobs(): string[] {
      return [...WORLD_KNOB_NAMES];
    },

    init(world: World): void {
      initState(state, world);
    },

    step(params: MovementParams, _time: number, dt: number): void {
      stepState(state, params, dt);
    },

    scene(): Scene {
      return buildScene(state);
    },

    finish(): Scene {
      return buildScene(state);
    },
  };

  return { renderer, state };
}

export function createBotanicalStyle(tuning?: Partial<BotanicalTuningConfig>): StyleRenderer {
  return createBotanicalInternal(tuning).renderer;
}
