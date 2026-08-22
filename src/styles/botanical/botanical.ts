/**
 * Botanical style (spec Part 4, M4 rebuild): the experience MVP, rebuilt to
 * docs/styles/botanical.md. Tapered-stroke branches (not circle chains)
 * repeatedly fork into fine twigs, carrying dense gaussian-packed blossom
 * clusters in curated palette colors, on a warm paper background (see
 * ../../compositor/paper-ground.ts, wired in by main.ts/live-render-loop.ts).
 * One or two dominant root branches sweep left-to-right (the Scroll
 * composition, spec Part 3); pale depth echoes render the same kind of
 * growth further back in atmosphere. Marks are permanent ink (visual spec
 * section 7, decided 2026-08-22) -- nothing ever shrinks or is removed;
 * liveliness comes from a root periodically starting a new sibling branch
 * once its current one matures, not from anything disappearing. See
 * branch.ts/blossom.ts/palettes.ts
 * for the pure, independently-tested growth/wander/lifecycle/spawn/color
 * math this file wires together; this file owns the mutable state and the
 * StyleRenderer lifecycle (init/step/scene/finish).
 */
import type { MovementParams } from '../../adapters/movement-params';
import { clamp01 } from '../../shared/math';
import { createLabeledNoise } from '../../world/labeled-noise';
import { createLabeledStream } from '../../world/labeled-stream';
import type { World } from '../../world/world';
import type { Scene, SceneElement, StyleRenderer } from '../style-renderer';
import {
  checkCrossedForks,
  computeChildBaseWidth,
  computeForkFractions,
  computeMatureDurationMs,
  computeTargetLength,
  spawnBranch,
  tickGrowing,
  type Branch,
} from './branch';
import { spawnBlossomCluster, type Blossom } from './blossom';
import { BOTANICAL_PALETTE_PRESETS, type BotanicalPalette } from './palettes';
import { DEFAULT_BOTANICAL_TUNING_CONFIG, type BotanicalTuningConfig } from './tuning-config';

// --- World-knob range mappings (each documented at its own line; exact
// values are a first-pass, expected to get retuned after the static-render
// founder review -- see docs/HANDOFF.md). ---

const BRANCH_DENSITY_MIN = 15;
const BRANCH_DENSITY_SPAN = 45; // maxConcurrentBranches lands in [15, 60)

const GROWTH_RATE_MIN = 0.5;
const GROWTH_RATE_SPAN = 1.5; // baseGrowthRate lands in [0.5, 2.0)

const MATURE_DURATION_MIN = 3000;
const MATURE_DURATION_SPAN = 9000; // baseMatureDurationMs lands in [3000, 12000) ms

const ROOT_COUNT_MIN = 1;
const ROOT_COUNT_SPAN = 2; // rootCount lands in {1, 2} -- "one or two dominant structures" (visual spec section 6)

const BRANCH_SPREAD_MIN = 0.15;
const BRANCH_SPREAD_SPAN = 0.4; // branchSpreadBase lands in [0.15, 0.55) radians -- a tight cone around the rightward sweep, not a wide fan

const WANDER_AMPLITUDE_MIN = 0.02;
const WANDER_AMPLITUDE_SPAN = 0.13; // wanderAmplitudeBase lands in [0.02, 0.15) radians

const BLOSSOMS_PER_CLUSTER_MIN = 25;
const BLOSSOMS_PER_CLUSTER_SPAN = 55; // blossomsPerCluster lands in [25, 80) -- visual spec section 3

// The Scroll composition (spec Part 3, docs/styles/botanical.md section 6):
// growth sweeps left to right, so roots originate near the left edge and
// aim rightward (0 rad = +x), not upward from a bottom band. Fixed (not a
// world knob) so "the reference sweeps horizontally" is a structural
// promise, not a per-day coin flip -- root placement (still per-seed) is
// where day-to-day variety comes from.
const COMPOSITION_SWEEP_ANGLE = 0;
const ROOT_X_MIN = 0.05;
const ROOT_X_SPAN = 0.2;

/** One independent growth system's own randomness namespace, z-offset, and opacity multiplier -- everything that makes a depth echo "the same kind of growth further back in atmosphere" rather than the main event. Fixed/not knob-configurable for this first pass (visual spec section 5). */
interface EchoConfig {
  systemId: string;
  zOffset: number;
  opacityMultiplier: number;
  rootCount: number;
  maxGenerationCap: number;
}
const ECHO_CONFIGS: EchoConfig[] = [
  { systemId: 'echo0', zOffset: 0.35, opacityMultiplier: 0.5, rootCount: 1, maxGenerationCap: 3 },
  { systemId: 'echo1', zOffset: 0.6, opacityMultiplier: 0.3, rootCount: 1, maxGenerationCap: 3 },
];

const FOREGROUND_SYSTEM_ID = 'fg';

// Pre-first-step() spawn spread default: no step() has run yet at init(),
// so root branches spawn using a neutral mid-range "current expansion".
const DEFAULT_EXPANSION_BEFORE_FIRST_STEP = 0.5;

const WORLD_KNOB_NAMES = [
  'paletteIndex',
  'branchDensity',
  'baseGrowthRate',
  'matureDurationMs',
  'windAngle',
  'rootCount',
  'branchSpreadBase',
  'wanderAmplitudeBase',
  'blossomsPerCluster',
] as const;

interface RootPoint {
  x: number;
  y: number;
  z: number;
  baseDirectionCenter: number;
}

/** One independent growth system: its own roots/branches/blossoms/resprout counters. The foreground system and each depth echo are each one of these, stepped identically. */
interface GrowthSystemState {
  roots: RootPoint[];
  branches: Branch[];
  blossoms: Blossom[];
  resproutCounters: Map<number, number>;
}

function createEmptyGrowthSystem(): GrowthSystemState {
  return { roots: [], branches: [], blossoms: [], resproutCounters: new Map() };
}

/**
 * Everything the StyleRenderer factory mutates over a session, held in one
 * place so a test-only entry point can reach in directly (see
 * createBotanicalInternal below) without widening StyleRenderer's own
 * public interface.
 */
export interface BotanicalState {
  sessionSeed: string;
  foreground: GrowthSystemState;
  echoes: GrowthSystemState[];
  latestParams: MovementParams | undefined;

  /** Resolved once at renderer creation -- DEFAULT_BOTANICAL_TUNING_CONFIG merged with any caller-supplied partial override, constant for the renderer's whole lifetime. */
  tuning: BotanicalTuningConfig;
  /** Resolved once at init() from the paletteIndex world knob. */
  palette: BotanicalPalette;

  maxConcurrentBranches: number;
  baseGrowthRate: number;
  baseGrowthPerTick: number;
  baseMatureDurationMs: number;
  windAngle: number;
  rootCount: number;
  branchSpreadBase: number;
  wanderAmplitudeBase: number;
  blossomsPerCluster: number;
}

function createEmptyState(tuning: BotanicalTuningConfig): BotanicalState {
  return {
    sessionSeed: '',
    foreground: createEmptyGrowthSystem(),
    echoes: ECHO_CONFIGS.map(() => createEmptyGrowthSystem()),
    latestParams: undefined,
    tuning,
    palette: BOTANICAL_PALETTE_PRESETS[0]!,
    maxConcurrentBranches: 0,
    baseGrowthRate: 0,
    baseGrowthPerTick: 0,
    baseMatureDurationMs: 0,
    windAngle: 0,
    rootCount: 0,
    branchSpreadBase: 0,
    wanderAmplitudeBase: 0,
    blossomsPerCluster: 0,
  };
}

function currentExpansion(state: BotanicalState): number {
  return state.latestParams?.expansion ?? DEFAULT_EXPANSION_BEFORE_FIRST_STEP;
}

/** Draws forkFractions for a freshly-spawned branch: count from tuning's fork-count range, jittered spacing via computeForkFractions. */
function drawForkFractions(state: BotanicalState, id: string): number[] {
  const countDraw = createLabeledStream(state.sessionSeed, `${id}:forkCount`)();
  const count = Math.floor(state.tuning.forkCountMin + countDraw * state.tuning.forkCountSpan);
  const jitterStream = createLabeledStream(state.sessionSeed, `${id}:forkJitter`);
  const jitterDraws = Array.from({ length: count }, () => jitterStream());
  return computeForkFractions(count, jitterDraws, state.tuning);
}

/** Draws every field for a fresh generation-0 branch at `rootIndex` in `system`, and returns it (not yet pushed). `systemId` namespaces this system's labeled streams so the foreground system and each depth echo draw independent randomness even at the same rootIndex/counter. */
function spawnRootBranch(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  rootIndex: number,
): Branch {
  // rootIndex always comes from a valid range (0..rootCount-1, or a parsed
  // resprout id that originated from one of those), so this is always defined.
  const root = system.roots[rootIndex]!;
  const counter = system.resproutCounters.get(rootIndex) ?? 0;
  system.resproutCounters.set(rootIndex, counter + 1);
  const id = `${systemId}:root${rootIndex}:${counter}`;

  const spread = state.branchSpreadBase * (0.4 + 0.6 * currentExpansion(state));
  const directionDraw = createLabeledStream(state.sessionSeed, `${id}:spawnDirection`)();
  const baseDirection = root.baseDirectionCenter + (directionDraw * 2 - 1) * spread;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${id}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, 0, state.tuning);

  const colorDraw = createLabeledStream(state.sessionSeed, `${id}:color`)();
  const color = state.palette.branchColors[Math.floor(colorDraw * state.palette.branchColors.length)]!;

  const widthDraw = createLabeledStream(state.sessionSeed, `${id}:width`)();
  const baseWidth = state.tuning.branchBaseWidthMin + widthDraw * state.tuning.branchBaseWidthSpan;

  const sweepDraw = createLabeledStream(state.sessionSeed, `${id}:sweepTarget`)();
  const sweepTarget = COMPOSITION_SWEEP_ANGLE + (sweepDraw * 2 - 1) * state.tuning.rootBaseDirectionSpread;

  return spawnBranch({
    id,
    generation: 0,
    z: root.z,
    color,
    rootX: root.x,
    rootY: root.y,
    baseDirection,
    targetLength,
    sweepTarget,
    baseWidth,
    forkFractions: drawForkFractions(state, id),
  });
}

/** Draws every field for a fresh sub-branch child forking off `parent` at its current tip, `childIndex` disambiguating multiple children forking off the same parent at different fork points. */
function spawnChildBranch(state: BotanicalState, parent: Branch, childIndex: number): Branch {
  const childId = `${parent.id}/child${childIndex}`;

  const zJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:zJitter`)();
  const z = clamp01(parent.z + (zJitterDraw * 2 - 1) * state.tuning.childZJitter);

  const colorDraw = createLabeledStream(state.sessionSeed, `${childId}:color`)();
  const color = state.palette.branchColors[Math.floor(colorDraw * state.palette.branchColors.length)]!;

  const generation = parent.generation + 1;

  // Direction inherits the parent's current direction (at the fork point) +/-
  // a jittered magnitude, per docs/styles/botanical.md section 2 -- not
  // modulated by expansion/branchSpreadBase, which are root-spawn-only knobs.
  const magnitudeDraw = createLabeledStream(state.sessionSeed, `${childId}:directionMagnitude`)();
  const signDraw = createLabeledStream(state.sessionSeed, `${childId}:directionSign`)();
  const magnitude = state.tuning.childDirectionJitterMin + magnitudeDraw * state.tuning.childDirectionJitterSpan;
  const sign = signDraw < 0.5 ? -1 : 1;
  const baseDirection = parent.direction + sign * magnitude;

  const targetLengthDraw = createLabeledStream(state.sessionSeed, `${childId}:targetLength`)();
  const targetLength = computeTargetLength(state.tuning.targetLengthBase, targetLengthDraw, generation, state.tuning);

  const baseWidth = computeChildBaseWidth(parent.baseWidth, state.tuning);

  // Small jitter around the parent's own sweepTarget, so a child still
  // trends toward the same overall composition sweep as its parent even
  // after forking off at a wide angle.
  const sweepJitterDraw = createLabeledStream(state.sessionSeed, `${childId}:sweepTarget`)();
  const sweepTarget = parent.sweepTarget + (sweepJitterDraw * 2 - 1) * 0.15;

  return spawnBranch({
    id: childId,
    generation,
    z,
    color,
    rootX: parent.tipX,
    rootY: parent.tipY,
    baseDirection,
    targetLength,
    sweepTarget,
    baseWidth,
    forkFractions: drawForkFractions(state, childId),
  });
}

/**
 * Movement mapping (visual spec section 7): "expansion maps to spread/reach
 * of new growth and cluster size." A cluster spawns at the moment its owning
 * branch matures, so the CURRENT tick's expansion (not a session-average or
 * the value at spawn-time root placement) is what should size it -- a
 * branch that matures during an expansive movement gets a bigger cluster
 * than one that matures during a contained movement, else identical.
 * expansion=0.5 (this file's own pre-first-step default) reproduces exactly
 * `state.blossomsPerCluster`, so the world knob's own mapped range stays
 * the meaningful "baseline size" even though every real cluster varies
 * around it.
 */
function expansionScaledClusterCount(state: BotanicalState): number {
  return Math.round(state.blossomsPerCluster * (0.5 + currentExpansion(state)));
}

function spawnBlossomsFor(state: BotanicalState, branch: Branch): Blossom[] {
  const draw = createLabeledStream(state.sessionSeed, `${branch.id}:blossoms`);
  return spawnBlossomCluster({
    branchId: branch.id,
    segments: branch.segments,
    count: expansionScaledClusterCount(state),
    paletteColors: state.palette.colors,
    z: branch.z,
    draw,
    tuning: state.tuning,
  });
}

function initGrowthSystem(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  rootCount: number,
): void {
  system.resproutCounters = new Map();
  system.roots = [];
  system.branches = [];
  system.blossoms = [];

  // Root points: drawn once, sequentially, from a single system-level
  // stream (not per-root streams) -- spec Part 4's documented init order.
  const rootsDraw = createLabeledStream(state.sessionSeed, `${systemId}:roots`);
  for (let i = 0; i < rootCount; i++) {
    const x = ROOT_X_MIN + rootsDraw() * ROOT_X_SPAN;
    const y = state.tuning.rootYMin + rootsDraw() * state.tuning.rootYSpan;
    const zJitter = rootsDraw();
    const dirJitter = rootsDraw();
    const z = clamp01((i + zJitter) / rootCount);
    const baseDirectionCenter = COMPOSITION_SWEEP_ANGLE + (dirJitter * 2 - 1) * state.tuning.rootBaseDirectionSpread;

    system.roots.push({ x, y, z, baseDirectionCenter });
    system.resproutCounters.set(i, 0);
    system.branches.push(spawnRootBranch(state, system, systemId, i));
  }
}

/** Advances one growth system one tick: growth/wander/fork-crossing/lifecycle for every branch, exactly mirroring the pre-rebuild single-system stepState, just parametrized so the foreground system and each depth echo can all run through the same logic independently. Nothing is ever removed from `system.branches`/`system.blossoms` (permanent ink, docs/styles/botanical.md section 7) -- this function only ever appends. */
function stepGrowthSystem(
  state: BotanicalState,
  system: GrowthSystemState,
  systemId: string,
  params: MovementParams,
  dt: number,
  maxGenerationForSystem: number,
): void {
  const newBranches: Branch[] = [];
  const liveCount = () => system.branches.length + newBranches.length;

  for (const branch of system.branches) {
    if (branch.lifecycle === 'growing') {
      const previousGrownLength = branch.grownLength;
      const noise01 = createLabeledNoise(state.sessionSeed, `${branch.id}:wander`)(
        branch.grownLength * state.tuning.curvatureNoiseScale,
      );
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

      if (branch.generation < maxGenerationForSystem) {
        const crossedForkIndices = checkCrossedForks(branch, previousGrownLength);
        for (const forkIndex of crossedForkIndices) {
          if (liveCount() < state.maxConcurrentBranches) {
            newBranches.push(spawnChildBranch(state, branch, forkIndex));
          }
        }
      }

      if (becameMature) {
        branch.lifecycle = 'mature';
        branch.lifecycleTimer = 0;
        const jitterDraw = createLabeledStream(state.sessionSeed, `${branch.id}:matureDuration`)();
        branch.matureDurationMs = computeMatureDurationMs(state.baseMatureDurationMs, jitterDraw);
        system.blossoms.push(...spawnBlossomsFor(state, branch));
      }
    } else {
      // mature -- permanent (docs/styles/botanical.md section 7's "marks are
      // permanent ink": no shrink, no removal, ever). A generation-0 branch's
      // timer instead triggers front-driven new growth: once matureDurationMs
      // elapses, a new sibling spawns at the same root (subject to the same
      // maxConcurrentBranches cap that already gates forking) and the timer
      // resets, so a root keeps producing fresh growth for the life of the
      // session rather than going still. Forked (generation > 0) branches
      // just carry an unused timer once mature -- only roots resprout.
      branch.lifecycleTimer += dt;

      if (branch.lifecycleTimer >= branch.matureDurationMs) {
        branch.lifecycleTimer = 0;
        if (branch.generation === 0 && liveCount() < state.maxConcurrentBranches) {
          const rootIndexMatch = /:root(\d+):/.exec(branch.id);
          const rootIndex = rootIndexMatch?.[1] !== undefined ? Number(rootIndexMatch[1]) : NaN;
          if (!Number.isNaN(rootIndex)) {
            newBranches.push(spawnRootBranch(state, system, systemId, rootIndex));
          }
        }
      }
    }
  }

  if (newBranches.length > 0) {
    system.branches.push(...newBranches);
  }
}

function initState(state: BotanicalState, world: World): void {
  state.sessionSeed = world.sessionSeed;

  const paletteIndexRaw = world.knob('paletteIndex');
  const branchDensityRaw = world.knob('branchDensity');
  const baseGrowthRateRaw = world.knob('baseGrowthRate');
  const matureDurationRaw = world.knob('matureDurationMs');
  const windAngleRaw = world.knob('windAngle');
  const rootCountRaw = world.knob('rootCount');
  const branchSpreadBaseRaw = world.knob('branchSpreadBase');
  const wanderAmplitudeBaseRaw = world.knob('wanderAmplitudeBase');
  const blossomsPerClusterRaw = world.knob('blossomsPerCluster');

  const paletteIndex = Math.min(
    BOTANICAL_PALETTE_PRESETS.length - 1,
    Math.floor(paletteIndexRaw * BOTANICAL_PALETTE_PRESETS.length),
  );
  state.palette = BOTANICAL_PALETTE_PRESETS[paletteIndex]!;

  state.maxConcurrentBranches = BRANCH_DENSITY_MIN + Math.floor(branchDensityRaw * BRANCH_DENSITY_SPAN);
  state.baseGrowthRate = GROWTH_RATE_MIN + baseGrowthRateRaw * GROWTH_RATE_SPAN;
  state.baseGrowthPerTick = state.baseGrowthRate * state.tuning.baseGrowthScale;
  state.baseMatureDurationMs = MATURE_DURATION_MIN + matureDurationRaw * MATURE_DURATION_SPAN;
  state.windAngle = windAngleRaw * Math.PI * 2;
  state.rootCount = ROOT_COUNT_MIN + Math.floor(rootCountRaw * ROOT_COUNT_SPAN);
  state.branchSpreadBase = BRANCH_SPREAD_MIN + branchSpreadBaseRaw * BRANCH_SPREAD_SPAN;
  state.wanderAmplitudeBase = WANDER_AMPLITUDE_MIN + wanderAmplitudeBaseRaw * WANDER_AMPLITUDE_SPAN;
  state.blossomsPerCluster = BLOSSOMS_PER_CLUSTER_MIN + Math.floor(blossomsPerClusterRaw * BLOSSOMS_PER_CLUSTER_SPAN);

  state.latestParams = undefined;
  state.foreground = createEmptyGrowthSystem();
  state.echoes = ECHO_CONFIGS.map(() => createEmptyGrowthSystem());

  initGrowthSystem(state, state.foreground, FOREGROUND_SYSTEM_ID, state.rootCount);
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    initGrowthSystem(state, state.echoes[i]!, echoConfig.systemId, echoConfig.rootCount);
  });
}

function stepState(state: BotanicalState, params: MovementParams, dt: number): void {
  state.latestParams = params;

  stepGrowthSystem(state, state.foreground, FOREGROUND_SYSTEM_ID, params, dt, state.tuning.maxGeneration);
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    stepGrowthSystem(
      state,
      state.echoes[i]!,
      echoConfig.systemId,
      params,
      dt,
      Math.min(state.tuning.maxGeneration, echoConfig.maxGenerationCap),
    );
  });
}

/** Emits one growth system's branches/blossoms as scene elements, applying its z-offset (depth-echo placement) and opacity multiplier (depth-echo paleness) on top of each element's own values. zOffset=0/opacityMultiplier=1 for the foreground system is a no-op. */
function emitGrowthSystem(
  elements: SceneElement[],
  state: BotanicalState,
  system: GrowthSystemState,
  zOffset: number,
  opacityMultiplier: number,
): void {
  for (const branch of system.branches) {
    if (branch.segments.length < 2) continue; // a stroke needs at least 2 points

    elements.push({
      kind: 'stroke',
      z: clamp01(branch.z + zOffset),
      points: branch.segments,
      baseWidth: branch.baseWidth,
      taperExponent: state.tuning.taperExponent,
      color: branch.color,
      opacity: state.tuning.branchBaseOpacity * opacityMultiplier,
    });
  }

  for (const blossom of system.blossoms) {
    const element: SceneElement = {
      kind: 'circle',
      z: clamp01(blossom.z + zOffset),
      x: blossom.x,
      y: blossom.y,
      radius: blossom.radius,
      opacity: blossom.baseOpacity * opacityMultiplier,
      color: blossom.color,
    };
    if (blossom.ringColor !== undefined) {
      element.ringColor = blossom.ringColor;
      element.ringOpacity = (blossom.ringOpacity ?? blossom.baseOpacity) * opacityMultiplier;
    }
    elements.push(element);
  }
}

function buildScene(state: BotanicalState): Scene {
  const elements: SceneElement[] = [];

  emitGrowthSystem(elements, state, state.foreground, 0, 1);
  ECHO_CONFIGS.forEach((echoConfig, i) => {
    emitGrowthSystem(elements, state, state.echoes[i]!, echoConfig.zOffset, echoConfig.opacityMultiplier);
  });

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
