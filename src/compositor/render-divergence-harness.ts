/**
 * A committed pixel-divergence diagnostic harness for the live incremental
 * compositor (live-compositor.ts) vs. the old, correct-by-construction
 * full-redraw renderer (render-scene.ts's renderScene). Promotes session
 * 018's ad hoc, never-committed pixel-diff tool (docs/HANDOFF.md, "Worth
 * considering") into a real, reusable module, so it doesn't need to be
 * rebuilt from scratch every time this bug class is suspected.
 *
 * Method (session 018's proven technique, replicated exactly): drive ONE
 * botanical instance through the REAL live path every tick --
 * `renderer.step()` then `sceneLayers()` -> `computeCanvasSize()` ->
 * `compositor.renderFrame()`, exactly like src/app/live-render-loop.ts's
 * frame() does -- using a real @napi-rs/canvas-backed OffscreenBufferFactory
 * (the same DI boundary main.ts's DOM implementation satisfies). At
 * checkpoints, render the SAME state fresh through the old, provably-correct
 * `renderScene()` on a separate canvas of the identical size, and diff raw
 * RGBA pixels. Any divergence is unambiguous evidence of a real live-
 * compositor bug -- render-scene.ts re-sorts and repaints every element
 * fresh, every call, so it cannot itself have a permanent-bake-ordering bug.
 *
 * @napi-rs/canvas is a devDependency imported ONLY from this file and its
 * companion test (render-divergence.test.ts) -- never from production
 * compositor/style code, matching src/engine/pixel-determinism.test.ts's own
 * established convention for testing real pixel output without a DOM.
 */
import { createCanvas, type Canvas } from '@napi-rs/canvas';

/**
 * This project has no @types/node dependency (a deliberate omission --
 * src/ is otherwise browser-only code); this harness is the one place that
 * needs Node's `fs`/`path` to write diagnostic PNGs to disk, purely for a
 * developer's own inspection, never read back by production code or by the
 * committed test's assertions. Rather than adding a project-wide
 * @types/node dependency for this one narrow need, `require` is declared
 * locally as `any` -- it genuinely IS available at runtime here (this
 * module is only ever imported from Vitest test files, which vite-node
 * runs with a real CJS-interop `require` in scope) -- and its return value
 * is deliberately left untyped (`any`), so no further Node type surface
 * (Buffer, fs's own types, ...) needs to be declared either.
 */
declare const require: (id: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
import type { MovementParams } from '../adapters/movement-params';
import { SIMULATION_TICK_MS } from '../engine/replay';
import { createSessionParamsAccumulator } from '../engine/session-params';
import { createLiveCompositor, type OffscreenBuffer, type OffscreenBufferFactory } from './live-compositor';
import { renderPaperGround } from './paper-ground';
import { computeCanvasSize, renderScene, type CanvasLike, type CanvasSize } from './render-scene';
import type { Branch } from '../styles/botanical/branch';
import { createBotanicalInternal, type BotanicalState } from '../styles/botanical/botanical';
import type { BotanicalTuningConfig } from '../styles/botanical/tuning-config';
import type { WorldOverrides } from '../world/world';
import { createWorld } from '../world/world';

// --- Real-canvas OffscreenBufferFactory (main.ts's DOM implementation, ---
// --- ported to @napi-rs/canvas) -----------------------------------------

/**
 * Implements live-compositor.ts's OffscreenBuffer/OffscreenBufferFactory DI
 * boundary against a real @napi-rs/canvas Canvas -- structurally identical
 * to main.ts's createDomOffscreenBufferFactory, just against a Node canvas
 * instead of a real `<canvas>` element. `growTo`'s contract (preserve
 * existing content at (0,0)) is satisfied by drawImage-ing the OLD canvas
 * directly onto a freshly-created, larger one -- simpler than the DOM
 * version's snapshot dance, since a Node Canvas's own pixels don't get
 * cleared just by creating a second, unrelated Canvas object.
 */
export function createNodeCanvasBufferFactory(): OffscreenBufferFactory {
  return {
    create(size: CanvasSize): OffscreenBuffer {
      let canvas: Canvas = createCanvas(size.width, size.height);
      let activeCtx = canvas.getContext('2d');

      return {
        get ctx(): CanvasLike {
          return activeCtx as unknown as CanvasLike;
        },
        blitTo(dest: CanvasLike): void {
          (dest as unknown as { drawImage(image: Canvas, dx: number, dy: number): void }).drawImage(canvas, 0, 0);
        },
        growTo(newSize: CanvasSize): void {
          const grown = createCanvas(newSize.width, newSize.height);
          const grownCtx = grown.getContext('2d');
          (grownCtx as unknown as { drawImage(image: Canvas, dx: number, dy: number): void }).drawImage(
            canvas,
            0,
            0,
          );
          canvas = grown;
          activeCtx = grownCtx;
        },
      };
    },
  };
}

/** Creates a fresh destination canvas sized to `size` and returns both the canvas and its CanvasLike-cast context -- mirrors main.ts's resizeCanvas, recreated every frame rather than mutated, which is safe here since renderFrame always repaints the whole canvas (paper-ground first, then every bucket, full-size) before anything is read back. */
function createDestCanvas(size: CanvasSize): { canvas: Canvas; ctx: CanvasLike } {
  const canvas = createCanvas(size.width, size.height);
  return { canvas, ctx: canvas.getContext('2d') as unknown as CanvasLike };
}

// --- Deterministic, realistic movement script ---------------------------

/**
 * A movement script is a pure function of tick index -- no Math.random, no
 * wall clock -- so a run is exactly reproducible. Modeled on the founder's
 * described real sessions: alternating stillness (speed ~0.1) with movement
 * bursts (speed ~0.9), a few seconds each, not a synthetic constant-max-
 * speed stress case. expansion/symmetry stay mid-range throughout, with a
 * slow, gentle drift so they're not perfectly static either.
 */
export interface MovementScript {
  paramsAtTick(tick: number): MovementParams;
}

const TICKS_PER_SECOND = Math.round(1000 / SIMULATION_TICK_MS);

/** Smoothstep easing (3t^2 - 2t^3), so speed ramps between phases instead of stepping discontinuously -- closer to how a real body actually accelerates/decelerates than a square wave. */
function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * One repeating cycle: 3s still (speed 0.1) -> 1s ramp up -> 2s burst (speed
 * 0.9) -> 1s ramp down -> repeat. ~7s/cycle, in the range the founder's own
 * described sessions move at (session 017/018's video evidence: multi-
 * second stillness and burst phases, not frame-to-frame noise).
 */
const STILL_SECONDS = 3;
const RAMP_UP_SECONDS = 1;
const BURST_SECONDS = 2;
const RAMP_DOWN_SECONDS = 1;
const CYCLE_SECONDS = STILL_SECONDS + RAMP_UP_SECONDS + BURST_SECONDS + RAMP_DOWN_SECONDS;
const CYCLE_TICKS = CYCLE_SECONDS * TICKS_PER_SECOND;

const STILL_SPEED = 0.1;
const BURST_SPEED = 0.9;

export function createRealisticMovementScript(): MovementScript {
  return {
    paramsAtTick(tick: number): MovementParams {
      const tInCycle = tick % CYCLE_TICKS;
      const stillTicks = STILL_SECONDS * TICKS_PER_SECOND;
      const rampUpTicks = RAMP_UP_SECONDS * TICKS_PER_SECOND;
      const burstTicks = BURST_SECONDS * TICKS_PER_SECOND;

      let speed: number;
      if (tInCycle < stillTicks) {
        speed = STILL_SPEED;
      } else if (tInCycle < stillTicks + rampUpTicks) {
        const p = (tInCycle - stillTicks) / rampUpTicks;
        speed = STILL_SPEED + (BURST_SPEED - STILL_SPEED) * smoothstep(p);
      } else if (tInCycle < stillTicks + rampUpTicks + burstTicks) {
        speed = BURST_SPEED;
      } else {
        const p = (tInCycle - stillTicks - rampUpTicks - burstTicks) / RAMP_DOWN_SECONDS / TICKS_PER_SECOND;
        speed = BURST_SPEED - (BURST_SPEED - STILL_SPEED) * smoothstep(p);
      }

      // Slow, gentle drift, mid-range, decoupled from the speed cycle so
      // expansion/symmetry aren't just a relabeled copy of speed.
      const expansion = 0.5 + 0.15 * Math.sin(tick * 0.0015);
      const symmetry = 0.6 + 0.12 * Math.sin(tick * 0.0009 + 1.3);

      return { v: 1, expansion, speed, symmetry };
    },
  };
}

// --- Pixel diff -----------------------------------------------------------

export interface PixelBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DiffResult {
  diffPixelCount: number;
  bboxPx: PixelBBox | null;
}

/** Diffs two identically-sized RGBA buffers. Any channel differing by more than `tolerance` (default 0 -- exact) counts the pixel as divergent. Both renderers share the exact same drawCircleElement/drawStrokeSegment/renderPaperGround functions, so a byte-identical match is the expected result for any pixel neither renderer disagrees about -- a nonzero tolerance is only for guarding against incidental platform float rounding, not because approximate agreement is considered acceptable here. */
export function diffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number, tolerance = 0): DiffResult {
  let diffPixelCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dr = Math.abs(a[i]! - b[i]!);
      const dg = Math.abs(a[i + 1]! - b[i + 1]!);
      const db = Math.abs(a[i + 2]! - b[i + 2]!);
      const da = Math.abs(a[i + 3]! - b[i + 3]!);
      if (dr > tolerance || dg > tolerance || db > tolerance || da > tolerance) {
        diffPixelCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    diffPixelCount,
    bboxPx: diffPixelCount > 0 ? { minX, minY, maxX, maxY } : null,
  };
}

/** Converts a pixel-space bbox to world coordinates (render-scene.ts's worldUnitPx = canvasSize.height convention), expanded by `marginWorldUnits` on every side -- "within or near" the diff region, not just exactly inside it. */
export function pixelBBoxToWorld(bboxPx: PixelBBox, worldUnitPx: number, marginWorldUnits: number): PixelBBox {
  return {
    minX: bboxPx.minX / worldUnitPx - marginWorldUnits,
    minY: bboxPx.minY / worldUnitPx - marginWorldUnits,
    maxX: bboxPx.maxX / worldUnitPx + marginWorldUnits,
    maxY: bboxPx.maxY / worldUnitPx + marginWorldUnits,
  };
}

// --- Element-level trace evidence -----------------------------------------

export interface ElementTraceEntry {
  layerId: string;
  kind: 'stroke' | 'circle';
  id: string;
  z: number;
  /** Present for stroke/branch elements only. */
  lifecycle?: 'growing' | 'mature';
  /** Present for circle/blossom elements only -- true iff this blossom has already been revealed into system.blossoms (and is therefore actually present in the scene both renderers read); false means it's still sitting in a pendingCluster, not yet emitted at all. */
  revealed?: boolean;
  /** Present for stroke/branch elements only -- whether emitGrowthSystem would report this branch `final` right now (mirrors botanical.ts's own `final` computation exactly, not re-derived differently). */
  final?: boolean;
  /** Present for stroke/branch elements only. */
  bakeResolved?: boolean;
  rootIndex: number;
  xMin: number;
  xMax: number;
}

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax;
}

/** Every branch/blossom (foreground AND echo systems) whose own bounding box overlaps `worldBBox` -- used to trace the first divergent checkpoint back to concrete state. `applyBakeSafety` mirrors botanical.ts's own emitGrowthSystem argument (true for foreground systems, false for echoes) so `final` is computed identically to what the real scene emission would report. */
export function traceElementsNear(state: BotanicalState, worldBBox: PixelBBox): ElementTraceEntry[] {
  const entries: ElementTraceEntry[] = [];

  function branchFinal(branch: Branch, applyBakeSafety: boolean): boolean {
    return branch.lifecycle === 'mature' && (!applyBakeSafety || branch.bakeResolved);
  }

  function branchXExtent(branch: Branch): { xMin: number; xMax: number } {
    let xMin = branch.rootX;
    let xMax = branch.rootX;
    for (const point of branch.segments) {
      if (point.x < xMin) xMin = point.x;
      if (point.x > xMax) xMax = point.x;
    }
    return { xMin, xMax };
  }

  function scanSystem(layerId: string, system: BotanicalState['foregroundSystems'][number], applyBakeSafety: boolean): void {
    for (const branch of system.branches) {
      const { xMin, xMax } = branchXExtent(branch);
      // y-extent, for the overlap check only (not reported -- xMin/xMax is the requested evidence field).
      let yMin = branch.rootY;
      let yMax = branch.rootY;
      for (const point of branch.segments) {
        if (point.y < yMin) yMin = point.y;
        if (point.y > yMax) yMax = point.y;
      }
      if (
        overlaps(xMin, xMax, worldBBox.minX, worldBBox.maxX) &&
        overlaps(yMin, yMax, worldBBox.minY, worldBBox.maxY)
      ) {
        entries.push({
          layerId,
          kind: 'stroke',
          id: branch.id,
          z: branch.z,
          lifecycle: branch.lifecycle,
          final: branchFinal(branch, applyBakeSafety),
          bakeResolved: branch.bakeResolved,
          rootIndex: branch.rootIndex,
          xMin,
          xMax,
        });
      }
    }

    for (const blossom of system.blossoms) {
      if (
        overlaps(blossom.x, blossom.x, worldBBox.minX, worldBBox.maxX) &&
        overlaps(blossom.y, blossom.y, worldBBox.minY, worldBBox.maxY)
      ) {
        entries.push({
          layerId,
          kind: 'circle',
          id: blossom.branchId,
          z: blossom.z,
          revealed: true,
          rootIndex: blossom.rootIndex,
          xMin: blossom.x,
          xMax: blossom.x,
        });
      }
    }

    // Not-yet-revealed blossoms too (pendingClusters) -- relevant evidence
    // for whether a reveal-timing race, not just a bake-order race, is in
    // play at this checkpoint.
    for (const pending of system.pendingClusters) {
      for (let i = pending.revealedCount; i < pending.blossoms.length; i++) {
        const blossom = pending.blossoms[i]!;
        if (
          overlaps(blossom.x, blossom.x, worldBBox.minX, worldBBox.maxX) &&
          overlaps(blossom.y, blossom.y, worldBBox.minY, worldBBox.maxY)
        ) {
          entries.push({
            layerId,
            kind: 'circle',
            id: blossom.branchId,
            z: blossom.z,
            revealed: false,
            rootIndex: blossom.rootIndex,
            xMin: blossom.x,
            xMax: blossom.x,
          });
        }
      }
    }
  }

  // applyBakeSafety is true for every system, foreground AND each echo
  // (session 019 fix -- botanical.ts's buildScene/buildSceneLayers now pass
  // `true` at every emitGrowthSystem call site, not just foreground's).
  // Kept as an explicit per-call argument here (not hardcoded true inline)
  // so this stays honest about mirroring botanical.ts's own real call
  // sites rather than assuming the value.
  state.foregroundSystems.forEach((system) => scanSystem(system.systemId, system, true));
  state.echoes.forEach((system) => scanSystem(system.systemId, system, true));

  return entries;
}

/** Min/max z actually EMITTED right now (i.e. read straight off the SceneLayer output both renderers consume -- botanical.ts's emitGrowthSystem already folds each echo's zOffset into element.z, `clamp01(branch.z/blossom.z + zOffset)`, so this is the true on-screen depth value, not the raw pre-offset internal z the branch/blossom object itself carries), split by bucket ('echo0'/'echo1'/'foreground' -- mirrors live-compositor.ts's own bucketFor grouping exactly, duplicated here rather than imported since bucketFor itself isn't exported). Used to check the echo-vs-foreground z-range overlap red herring named in the investigation brief: if these ranges overlap, renderScene's global z-sort and the live compositor's fixed echo1->echo0->foreground bucket paint order can legitimately disagree wherever echo and foreground content overlap on screen, independent of any bake-order bug. */
export interface ZRangeReport {
  foreground: { min: number; max: number } | null;
  echo0: { min: number; max: number } | null;
  echo1: { min: number; max: number } | null;
}

/** Same bucket assignment as live-compositor.ts's bucketFor. */
function bucketForLayerId(layerId: string): 'echo0' | 'echo1' | 'foreground' {
  if (layerId === 'echo0') return 'echo0';
  if (layerId === 'echo1') return 'echo1';
  return 'foreground';
}

export function zRangesForLayers(layers: { layerId: string; elements: { z: number }[] }[]): ZRangeReport {
  function rangeOf(zs: number[]): { min: number; max: number } | null {
    if (zs.length === 0) return null;
    return { min: Math.min(...zs), max: Math.max(...zs) };
  }
  const byBucket: Record<'echo0' | 'echo1' | 'foreground', number[]> = { echo0: [], echo1: [], foreground: [] };
  for (const layer of layers) {
    const bucket = bucketForLayerId(layer.layerId);
    for (const element of layer.elements) byBucket[bucket].push(element.z);
  }
  return {
    foreground: rangeOf(byBucket.foreground),
    echo0: rangeOf(byBucket.echo0),
    echo1: rangeOf(byBucket.echo1),
  };
}

// --- Scenario runner --------------------------------------------------------

export interface CheckpointResult {
  tick: number;
  timeMs: number;
  canvasSize: CanvasSize;
  diffPixelCount: number;
  bboxPx: PixelBBox | null;
  bboxWorld: PixelBBox | null;
}

export interface ScenarioRunResult {
  seed: string;
  checkpoints: CheckpointResult[];
  firstDivergence: CheckpointResult | null;
  traceAtFirstDivergence: ElementTraceEntry[] | null;
  zRangesAtFirstDivergence: ZRangeReport | null;
  pngPaths: { live: string; groundTruth: string; diffMask: string } | null;
}

export interface RunScenarioOptions {
  seed: string;
  worldOverrides?: WorldOverrides;
  tuning?: Partial<BotanicalTuningConfig>;
  totalTicks: number;
  checkpointIntervalTicks: number;
  /** The canvas's fixed height in pixels -- same role as main.ts's CANVAS_HEIGHT_PX. */
  fixedHeightPx: number;
  movementScript: MovementScript;
  /** World-unit margin used when collecting trace evidence "near" the diff bbox (see traceElementsNear). */
  traceMarginWorldUnits?: number;
  /** If provided, PNG triples (live/ground-truth/diff-mask) for the FIRST divergent checkpoint are written to this directory, named `${seed}-live.png` etc. */
  dumpPngDir?: string;
}

function writeDiffMaskPng(width: number, height: number, liveData: Uint8ClampedArray, groundData: Uint8ClampedArray) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < liveData.length; i += 4) {
    const dr = Math.abs(liveData[i]! - groundData[i]!);
    const dg = Math.abs(liveData[i + 1]! - groundData[i + 1]!);
    const db = Math.abs(liveData[i + 2]! - groundData[i + 2]!);
    const da = Math.abs(liveData[i + 3]! - groundData[i + 3]!);
    const isDiff = dr > 0 || dg > 0 || db > 0 || da > 0;
    if (isDiff) {
      imageData.data[i] = 255;
      imageData.data[i + 1] = 0;
      imageData.data[i + 2] = 0;
      imageData.data[i + 3] = 255;
    } else {
      // Dim grayscale echo of the ground-truth render underneath, so the
      // red divergent pixels are visible in spatial context rather than
      // floating on a blank field.
      const gray = Math.round((groundData[i]! + groundData[i + 1]! + groundData[i + 2]!) / 3);
      imageData.data[i] = gray;
      imageData.data[i + 1] = gray;
      imageData.data[i + 2] = gray;
      imageData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

/**
 * Runs one full scenario: steps a single Botanical instance tick-by-tick,
 * driving the real LiveCompositor every tick exactly like the live app, and
 * at every `checkpointIntervalTicks`-th tick renders the same state fresh
 * through renderScene() as ground truth and diffs pixels. Stops collecting
 * trace/PNG evidence after the first divergent checkpoint (subsequent
 * checkpoints are still measured, for the diffPixelCount trajectory) to keep
 * cost bounded.
 */
export function runDivergenceScenario(options: RunScenarioOptions): ScenarioRunResult {
  const world = createWorld(options.seed, 0, options.worldOverrides);
  const { renderer, state } = createBotanicalInternal(options.tuning);
  renderer.init(world);

  const bufferFactory = createNodeCanvasBufferFactory();
  const compositor = createLiveCompositor(bufferFactory);
  const accumulator = createSessionParamsAccumulator();

  const checkpoints: CheckpointResult[] = [];
  let firstDivergence: CheckpointResult | null = null;
  let traceAtFirstDivergence: ElementTraceEntry[] | null = null;
  let zRangesAtFirstDivergence: ZRangeReport | null = null;
  let pngPaths: ScenarioRunResult['pngPaths'] = null;

  const sceneLayersFn = renderer.sceneLayers;
  if (!sceneLayersFn) {
    throw new Error('runDivergenceScenario requires a StyleRenderer with sceneLayers() (Botanical implements it)');
  }

  for (let tick = 0; tick < options.totalTicks; tick++) {
    const time = tick * SIMULATION_TICK_MS;
    const params = options.movementScript.paramsAtTick(tick);
    accumulator.update(params.speed, time);
    renderer.step(params, accumulator.current(), time, SIMULATION_TICK_MS);

    const layers = sceneLayersFn();
    const canvasSize = computeCanvasSize({ elements: layers.flatMap((l) => l.elements) }, options.fixedHeightPx);
    const dest = createDestCanvas(canvasSize);
    compositor.renderFrame(layers, dest.ctx, canvasSize, world.worldSeed);

    const isCheckpoint = (tick + 1) % options.checkpointIntervalTicks === 0;
    if (!isCheckpoint) continue;

    const ground = createDestCanvas(canvasSize);
    renderPaperGround(ground.ctx, canvasSize, world.worldSeed);
    renderScene(ground.ctx, renderer.scene(), canvasSize);

    const liveImageData = (dest.ctx as unknown as { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }).getImageData(0, 0, canvasSize.width, canvasSize.height);
    const groundImageData = (ground.ctx as unknown as { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }).getImageData(0, 0, canvasSize.width, canvasSize.height);

    const { diffPixelCount, bboxPx } = diffPixels(liveImageData.data, groundImageData.data, canvasSize.width, canvasSize.height);
    const worldUnitPx = canvasSize.height;
    const bboxWorld = bboxPx ? pixelBBoxToWorld(bboxPx, worldUnitPx, options.traceMarginWorldUnits ?? 0.15) : null;

    const checkpoint: CheckpointResult = { tick, timeMs: time, canvasSize, diffPixelCount, bboxPx, bboxWorld };
    checkpoints.push(checkpoint);

    if (diffPixelCount > 0 && firstDivergence === null) {
      firstDivergence = checkpoint;
      traceAtFirstDivergence = traceElementsNear(state, bboxWorld!);
      zRangesAtFirstDivergence = zRangesForLayers(layers);

      if (options.dumpPngDir) {
        const fs = require('node:fs');
        const path = require('node:path');
        fs.mkdirSync(options.dumpPngDir, { recursive: true });
        const livePath = path.join(options.dumpPngDir, `${options.seed}-live.png`);
        const groundPath = path.join(options.dumpPngDir, `${options.seed}-ground-truth.png`);
        const diffPath = path.join(options.dumpPngDir, `${options.seed}-diff-mask.png`);
        fs.writeFileSync(livePath, dest.canvas.toBuffer('image/png'));
        fs.writeFileSync(groundPath, ground.canvas.toBuffer('image/png'));
        fs.writeFileSync(diffPath, writeDiffMaskPng(canvasSize.width, canvasSize.height, liveImageData.data, groundImageData.data));
        pngPaths = { live: livePath, groundTruth: groundPath, diffMask: diffPath };
      }
    }
  }

  return { seed: options.seed, checkpoints, firstDivergence, traceAtFirstDivergence, zRangesAtFirstDivergence, pngPaths };
}
