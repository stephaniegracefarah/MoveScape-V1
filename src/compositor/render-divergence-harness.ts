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
import {
  createLiveCompositor,
  type LiveCompositorDebugFrameInfo,
  type LiveCompositorDebugLayerInfo,
  type OffscreenBuffer,
  type OffscreenBufferFactory,
} from './live-compositor';
import { renderPaperGround } from './paper-ground';
import { computeCanvasSize, renderScene, type CanvasLike, type CanvasSize } from './render-scene';
import type { Branch } from '../styles/botanical/branch';
import { createBotanicalInternal, type BotanicalState } from '../styles/botanical/botanical';
import type { BotanicalTuningConfig } from '../styles/botanical/tuning-config';
import type { SceneLayer } from '../styles/style-renderer';
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

// --- Permanence oracle (session 022): whole-segment "vanish" detector -----
//
// The founder's own video evidence (docs/HANDOFF.md session 022) is NOT
// gradual fading -- it's a complete, contiguous stroke (hundreds of pixels,
// full taper) disappearing between two consecutive frames, timed to when
// the first branches go final/bake. This is a fundamentally different
// signature from the checkpoint-diff divergence above (which compares the
// live compositor against a fresh renderScene() redraw at sparse
// checkpoints): the oracle below instead compares the live compositor's
// own output, frame to frame, IN CANVAS COORDS (no scroll in this harness
// -- render-scene.ts's own coordinate-convention doc comment: a mark's
// pixel position never moves once drawn, and the canvas only ever grows
// wider, never narrower, so pixel (x,y) means the same world content at
// tick T and T+1 across their shared [0, min(widthT, widthT+1)) region --
// no scroll-compensation needed, matching the founder's own scroll-
// compensated frame diffs).

/**
 * Luminance-based content/background classification, calibrated directly
 * against this project's real palette and paper data (not guessed):
 * palettes.ts's branchColors (what a stroke is ever drawn in) are all near-
 * black/dark maroon -- e.g. default's '#2a0d10' ~ luminance 22, '#2e1518' ~
 * 30 -- while paper-ground.ts's BASE_COLOR/TONE_PALETTE (what's underneath
 * once a mark is gone) are all light creams -- '#f7f0e3' ~ 238, the
 * DARKEST mottle tone '#e8dcc4' ~ 217. A wide, deliberately generous gap
 * (120..200) separates "definitely a real stroke" from "definitely bare
 * paper," leaving a no-man's-land in between that swallows ordinary
 * antialiasing/taper-edge jitter (a still-growing stroke's OWN earlier
 * segments legitimately thin slightly each frame as points.length grows --
 * StrokeElement.taperExponent's own doc comment -- but that's a partial-
 * alpha blend confined to a 1px-wide contour, never a solid >=50px
 * interior region crossing this whole gap in one tick).
 */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Below this, a pixel is unambiguously real (dark) mark content -- see luminance()'s own calibration doc comment. */
const CONTENT_LUMINANCE_MAX = 120;
/** At or above this, a pixel is unambiguously bare paper background. */
const BACKGROUND_LUMINANCE_MIN = 200;
/** A cluster of vanished pixels smaller than this is edge noise, not a whole-segment loss -- the oracle's own calibration knob (docs/HANDOFF.md session 022 asked this be reported, not assumed): tune down if a real, smaller vanish needs catching; the founder's own video shows losses of hundreds of pixels, so this stays comfortably conservative. */
const MIN_VANISH_CLUSTER_PIXELS = 50;

interface VanishCluster {
  pixelCount: number;
  bboxPx: PixelBBox;
}

/**
 * Finds every 8-connected cluster of >= MIN_VANISH_CLUSTER_PIXELS pixels
 * that were unambiguous content in `prev` and are unambiguous background in
 * `curr`, over their shared [0, overlapWidth) x [0, height) region (see
 * this section's own top doc comment for why no scroll-compensation is
 * needed). `prevWidth`/`currWidth` may differ (the canvas only ever grows);
 * each buffer is read using its OWN stride.
 */
function findVanishClusters(
  prev: Uint8ClampedArray,
  prevWidth: number,
  curr: Uint8ClampedArray,
  currWidth: number,
  height: number,
): VanishCluster[] {
  const overlapWidth = Math.min(prevWidth, currWidth);
  const vanished = new Uint8Array(overlapWidth * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < overlapWidth; x++) {
      const pi = (y * prevWidth + x) * 4;
      const ci = (y * currWidth + x) * 4;
      const prevLum = luminance(prev[pi]!, prev[pi + 1]!, prev[pi + 2]!);
      const currLum = luminance(curr[ci]!, curr[ci + 1]!, curr[ci + 2]!);
      if (prevLum < CONTENT_LUMINANCE_MAX && currLum >= BACKGROUND_LUMINANCE_MIN) {
        vanished[y * overlapWidth + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(overlapWidth * height);
  const clusters: VanishCluster[] = [];
  const stackX: number[] = [];
  const stackY: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < overlapWidth; x++) {
      const idx = y * overlapWidth + x;
      if (!vanished[idx] || visited[idx]) continue;

      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      stackX.push(x);
      stackY.push(y);
      visited[idx] = 1;

      while (stackX.length > 0) {
        const cx = stackX.pop()!;
        const cy = stackY.pop()!;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= overlapWidth || ny < 0 || ny >= height) continue;
            const nIdx = ny * overlapWidth + nx;
            if (vanished[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1;
              stackX.push(nx);
              stackY.push(ny);
            }
          }
        }
      }

      if (count >= MIN_VANISH_CLUSTER_PIXELS) {
        clusters.push({ pixelCount: count, bboxPx: { minX, minY, maxX, maxY } });
      }
    }
  }
  return clusters;
}

/** Complete bookkeeping for one element (branch or blossom) whose path/position falls in or near a vanish event's bbox -- every field the investigation contract asked for. */
export interface OracleElementDump {
  layerId: string;
  bucket: 'echo0' | 'echo1' | 'foreground';
  kind: 'stroke' | 'circle';
  /** This element's own index among this layer's same-kind elements ONLY -- exactly the quantity live-compositor.ts's bakedStrokeIndices/circlesBaked track (see style-renderer.ts's sceneLayers doc comment). */
  kindIndex: number;
  /** branch.id or blossom.branchId. */
  id: string;
  z: number;
  /** Present for strokes (branches) only. */
  lifecycle?: 'growing' | 'mature';
  /** The emitted SceneElement's own `final` flag THIS tick. */
  finalInScene: boolean;
  /** The owning Branch/Blossom's own `bakeResolved` flag in state THIS tick (should always agree with finalInScene when applyBakeSafety=true -- a mismatch is itself evidence). */
  bakeResolvedInState: boolean;
  /** Whether live-compositor.ts's OWN internal bookkeeping (not just the emitted `final` flag) actually recorded this element as baked -- stroke: its kindIndex is in that layer's bakedStrokeIndices; circle: its kindIndex is under that layer's circlesBaked. This is the ground truth for hypothesis (b) (the final-flip handoff landing in the buffer) and (a) (kind-index aliasing). */
  bakedAccordingToCompositor: boolean;
  /** True iff finalInScene differs from what it was on the PREVIOUS tick (i.e. this element's final flag changed THIS tick). */
  flippedFinalThisTick: boolean;
  rootIndex: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** One detected whole-segment vanish event, with full bookkeeping for every element near it. */
export interface OracleEvent {
  tick: number;
  timeMs: number;
  bboxPx: PixelBBox;
  pixelCount: number;
  canvasSize: CanvasSize;
  /** Did live-compositor.ts's persistent buffers actually growTo() THIS tick (hypothesis: a grow racing a bake could lose content)? */
  buffersGrewThisFrame: boolean;
  /** Did canvasSize itself change THIS tick (width and/or height)? */
  canvasSizeChangedThisFrame: boolean;
  elements: OracleElementDump[];
  /** The RAW per-layer compositor debug snapshot for every layer this tick (not just layers with elements near the vanish bbox) -- lets a caller directly check for kind-index gaps (hypothesis 4a) without re-deriving it. */
  layerDebugSnapshots: LiveCompositorDebugLayerInfo[];
  pngPaths?: { before: string; after: string; diffMask: string };
}

function buildFinalByKeyMap(layers: SceneLayer[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const layer of layers) {
    let strokeIndex = 0;
    let circleIndex = 0;
    for (const element of layer.elements) {
      if (element.kind === 'stroke') {
        map.set(`${layer.layerId}:stroke:${strokeIndex}`, element.final === true);
        strokeIndex++;
      } else {
        map.set(`${layer.layerId}:circle:${circleIndex}`, element.final === true);
        circleIndex++;
      }
    }
  }
  return map;
}

/**
 * Dumps every branch/blossom (across every system, foreground AND echoes)
 * whose own path/position overlaps `worldBBox`, cross-referencing THREE
 * independent sources for each: the state object itself (bakeResolved,
 * lifecycle), the emitted SceneElement (`final`), and live-compositor.ts's
 * own internal bookkeeping (`bakedAccordingToCompositor`, via `debugInfo`).
 * Iterates branches/blossoms in the EXACT same filter/order emitGrowthSystem
 * uses (botanical.ts) so `kindIndex` here means the same thing
 * live-compositor.ts's own bakedStrokeIndices/circlesBaked do.
 */
function dumpElementsNearBBox(
  state: BotanicalState,
  layers: SceneLayer[],
  debugByLayer: Map<string, LiveCompositorDebugLayerInfo>,
  prevFinalByKey: Map<string, boolean>,
  worldBBox: PixelBBox,
): OracleElementDump[] {
  const dumps: OracleElementDump[] = [];

  function systemFor(layerId: string): { branches: Branch[]; blossoms: BotanicalState['foregroundSystems'][number]['blossoms'] } | undefined {
    const fg = state.foregroundSystems.find((s) => s.systemId === layerId);
    if (fg) return fg;
    return state.echoes.find((s) => s.systemId === layerId);
  }

  for (const layer of layers) {
    const system = systemFor(layer.layerId);
    if (!system) continue;
    const debugInfo = debugByLayer.get(layer.layerId);
    const strokeBranches = system.branches.filter((b) => b.segments.length >= 2);
    const circleBlossoms = system.blossoms;

    let strokeIdx = 0;
    let circleIdx = 0;
    for (const element of layer.elements) {
      if (element.kind === 'stroke') {
        const branch = strokeBranches[strokeIdx];
        if (branch) {
          let xMin = branch.rootX;
          let xMax = branch.rootX;
          let yMin = branch.rootY;
          let yMax = branch.rootY;
          for (const p of branch.segments) {
            if (p.x < xMin) xMin = p.x;
            if (p.x > xMax) xMax = p.x;
            if (p.y < yMin) yMin = p.y;
            if (p.y > yMax) yMax = p.y;
          }
          if (overlaps(xMin, xMax, worldBBox.minX, worldBBox.maxX) && overlaps(yMin, yMax, worldBBox.minY, worldBBox.maxY)) {
            const key = `${layer.layerId}:stroke:${strokeIdx}`;
            const prevFinal = prevFinalByKey.get(key);
            const nowFinal = element.final === true;
            dumps.push({
              layerId: layer.layerId,
              bucket: bucketForLayerId(layer.layerId),
              kind: 'stroke',
              kindIndex: strokeIdx,
              id: branch.id,
              z: branch.z,
              lifecycle: branch.lifecycle,
              finalInScene: nowFinal,
              bakeResolvedInState: branch.bakeResolved,
              bakedAccordingToCompositor: debugInfo ? debugInfo.bakedStrokeIndices.includes(strokeIdx) : false,
              flippedFinalThisTick: prevFinal !== undefined && prevFinal !== nowFinal,
              rootIndex: branch.rootIndex,
              xMin,
              xMax,
              yMin,
              yMax,
            });
          }
        }
        strokeIdx++;
      } else {
        const blossom = circleBlossoms[circleIdx];
        if (blossom && overlaps(blossom.x, blossom.x, worldBBox.minX, worldBBox.maxX) && overlaps(blossom.y, blossom.y, worldBBox.minY, worldBBox.maxY)) {
          const key = `${layer.layerId}:circle:${circleIdx}`;
          const prevFinal = prevFinalByKey.get(key);
          const nowFinal = element.final === true;
          dumps.push({
            layerId: layer.layerId,
            bucket: bucketForLayerId(layer.layerId),
            kind: 'circle',
            kindIndex: circleIdx,
            id: blossom.branchId,
            z: blossom.z,
            finalInScene: nowFinal,
            bakeResolvedInState: blossom.bakeResolved,
            bakedAccordingToCompositor: debugInfo ? circleIdx < debugInfo.circlesBaked : false,
            flippedFinalThisTick: prevFinal !== undefined && prevFinal !== nowFinal,
            rootIndex: blossom.rootIndex,
            xMin: blossom.x,
            xMax: blossom.x,
            yMin: blossom.y,
            yMax: blossom.y,
          });
        }
        circleIdx++;
      }
    }
  }
  return dumps;
}

function writeVanishMaskPng(
  overlapWidth: number,
  height: number,
  prevData: Uint8ClampedArray,
  prevWidth: number,
  currData: Uint8ClampedArray,
  currWidth: number,
) {
  const canvas = createCanvas(overlapWidth, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(overlapWidth, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < overlapWidth; x++) {
      const pi = (y * prevWidth + x) * 4;
      const ci = (y * currWidth + x) * 4;
      const prevLum = luminance(prevData[pi]!, prevData[pi + 1]!, prevData[pi + 2]!);
      const currLum = luminance(currData[ci]!, currData[ci + 1]!, currData[ci + 2]!);
      const outIdx = (y * overlapWidth + x) * 4;
      if (prevLum < CONTENT_LUMINANCE_MAX && currLum >= BACKGROUND_LUMINANCE_MIN) {
        imageData.data[outIdx] = 255;
        imageData.data[outIdx + 1] = 0;
        imageData.data[outIdx + 2] = 0;
        imageData.data[outIdx + 3] = 255;
      } else {
        const gray = Math.round((currData[ci]! + currData[ci + 1]! + currData[ci + 2]!) / 3);
        imageData.data[outIdx] = gray;
        imageData.data[outIdx + 1] = gray;
        imageData.data[outIdx + 2] = gray;
        imageData.data[outIdx + 3] = 255;
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

export interface RunPermanenceOracleOptions {
  seed: string;
  worldOverrides?: WorldOverrides;
  tuning?: Partial<BotanicalTuningConfig>;
  totalTicks: number;
  fixedHeightPx: number;
  movementScript: MovementScript;
  /** If provided, before/after/diff-mask PNGs are written here for the first `maxEventsToDumpPngsFor` events. */
  dumpPngDir?: string;
  /** Caps PNG writes (each event's evidence is still recorded in `events`, PNGs are just the expensive part) -- default 12. */
  maxEventsToDumpPngsFor?: number;
  /** World-unit margin used when collecting element dumps "near" a vanish bbox -- default 0.15, matching traceElementsNear's own default. */
  traceMarginWorldUnits?: number;
}

export interface OracleRunResult {
  seed: string;
  events: OracleEvent[];
  totalTicksRun: number;
  finalCanvasSize: CanvasSize;
}

/**
 * Runs one botanical session tick-by-tick through the REAL live path (same
 * technique as runDivergenceScenario), but instead of comparing against a
 * renderScene() ground truth, compares the live compositor's own output
 * frame-to-frame to catch whole-segment "vanish" events (see this
 * section's own top doc comment) -- session 022's investigation into the
 * founder's "entire branch segments disappear in a single step" report.
 */
export function runPermanenceOracleScenario(options: RunPermanenceOracleOptions): OracleRunResult {
  const world = createWorld(options.seed, 0, options.worldOverrides);
  const { renderer, state } = createBotanicalInternal(options.tuning);
  renderer.init(world);

  const bufferFactory = createNodeCanvasBufferFactory();
  const compositor = createLiveCompositor(bufferFactory);
  const accumulator = createSessionParamsAccumulator();

  const sceneLayersFn = renderer.sceneLayers;
  if (!sceneLayersFn) {
    throw new Error('runPermanenceOracleScenario requires a StyleRenderer with sceneLayers() (Botanical implements it)');
  }

  const events: OracleEvent[] = [];
  let prevCanvas: Canvas | null = null;
  let prevImageData: Uint8ClampedArray | null = null;
  let prevWidth = 0;
  let prevFinalByKey: Map<string, boolean> = new Map();
  let pngDumpCount = 0;
  const maxPngDumps = options.maxEventsToDumpPngsFor ?? 12;
  let lastCanvasSize: CanvasSize = { width: options.fixedHeightPx, height: options.fixedHeightPx };

  for (let tick = 0; tick < options.totalTicks; tick++) {
    const time = tick * SIMULATION_TICK_MS;
    const params = options.movementScript.paramsAtTick(tick);
    accumulator.update(params.speed, time);
    renderer.step(params, accumulator.current(), time, SIMULATION_TICK_MS);

    const layers = sceneLayersFn();
    const canvasSize = computeCanvasSize({ elements: layers.flatMap((l) => l.elements) }, options.fixedHeightPx);
    lastCanvasSize = canvasSize;
    const dest = createCanvas(canvasSize.width, canvasSize.height);
    const destCtx = dest.getContext('2d') as unknown as CanvasLike;

    const debugHolder: { info: LiveCompositorDebugFrameInfo | undefined } = { info: undefined };
    compositor.renderFrame(layers, destCtx, canvasSize, world.worldSeed, (info: LiveCompositorDebugFrameInfo) => {
      debugHolder.info = info;
    });

    const currImageData = (
      destCtx as unknown as { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }
    ).getImageData(0, 0, canvasSize.width, canvasSize.height);

    const debugByLayer = new Map<string, LiveCompositorDebugLayerInfo>();
    if (debugHolder.info) {
      for (const l of debugHolder.info.layers) debugByLayer.set(l.layerId, l);
    }

    const currFinalByKey = buildFinalByKeyMap(layers);

    if (prevImageData !== null && prevCanvas !== null) {
      const clusters = findVanishClusters(prevImageData, prevWidth, currImageData.data, canvasSize.width, canvasSize.height);
      for (const cluster of clusters) {
        const worldUnitPx = canvasSize.height;
        const worldBBox = pixelBBoxToWorld(cluster.bboxPx, worldUnitPx, options.traceMarginWorldUnits ?? 0.15);
        const elements = dumpElementsNearBBox(state, layers, debugByLayer, prevFinalByKey, worldBBox);

        const event: OracleEvent = {
          tick,
          timeMs: time,
          bboxPx: cluster.bboxPx,
          pixelCount: cluster.pixelCount,
          canvasSize,
          buffersGrewThisFrame: debugHolder.info?.buffersGrewThisFrame ?? false,
          canvasSizeChangedThisFrame: debugHolder.info?.canvasSizeChangedThisFrame ?? false,
          elements,
          layerDebugSnapshots: debugHolder.info?.layers ?? [],
        };

        if (options.dumpPngDir && pngDumpCount < maxPngDumps) {
          const fs = require('node:fs');
          const path = require('node:path');
          fs.mkdirSync(options.dumpPngDir, { recursive: true });
          const tag = `${options.seed}-t${tick}-${pngDumpCount}`;
          const beforePath = path.join(options.dumpPngDir, `${tag}-before.png`);
          const afterPath = path.join(options.dumpPngDir, `${tag}-after.png`);
          const diffPath = path.join(options.dumpPngDir, `${tag}-diff-mask.png`);
          fs.writeFileSync(beforePath, prevCanvas.toBuffer('image/png'));
          fs.writeFileSync(afterPath, dest.toBuffer('image/png'));
          fs.writeFileSync(
            diffPath,
            writeVanishMaskPng(
              Math.min(prevWidth, canvasSize.width),
              canvasSize.height,
              prevImageData,
              prevWidth,
              currImageData.data,
              canvasSize.width,
            ),
          );
          event.pngPaths = { before: beforePath, after: afterPath, diffMask: diffPath };
          pngDumpCount++;
        }

        events.push(event);
      }
    }

    prevCanvas = dest;
    prevImageData = currImageData.data;
    prevWidth = canvasSize.width;
    prevFinalByKey = currFinalByKey;
  }

  return { seed: options.seed, events, totalTicksRun: options.totalTicks, finalCanvasSize: lastCanvasSize };
}
