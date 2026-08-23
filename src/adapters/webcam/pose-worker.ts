/**
 * Pose inference worker (spec Part 3, "Pose tracking" + "Capture
 * pipeline"). Loads MediaPipe Tasks PoseLandmarker off the main thread and
 * turns each transferred VideoFrame into a MovementParams sample. Runs
 * regardless of anything on screen — the whole point of moving capture and
 * inference off the main thread and off any <video> element.
 *
 * Instantiated from index.ts via the Vite worker pattern as a MODULE worker
 * (`type: 'module'` — required for `npm run dev`, where Vite serves this
 * file's imports as real ES modules that only a module worker can execute):
 *   new Worker(new URL('./pose-worker.ts', import.meta.url), { type: 'module' })
 * MediaPipe's importScripts()-based wasm loading doesn't work in module
 * workers; see the pre-loading workaround in createLandmarker() below.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { computeMovementParams, nextStateAfterNoPose, POSE_PARAM_TUNING, type PoseFrameState } from './params-from-landmarks';
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker-protocol';

/**
 * Where the pose model and its WASM runtime are fetched from. Both are
 * static assets — invariant 5 explicitly allows fetching the pose model
 * over the network; no video data ever leaves this worker. Pinned to the
 * installed @mediapipe/tasks-vision version so the WASM runtime matches
 * these bindings.
 */
const WASM_FILESET_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * `self` in an ES module worker is the worker global scope at runtime, but
 * this project's tsconfig only includes the "dom" lib (not "webworker" —
 * the two can't be mixed), so TypeScript sees `self` as `Window`. Shadowing
 * it locally with the minimal shape actually used here avoids that
 * mismatch (Window.postMessage has an incompatible signature) without
 * touching the shared tsconfig.
 */
interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<MainToWorkerMessage>) => void): void;
}
const scope = self as unknown as WorkerScope;

let landmarker: PoseLandmarker | null = null;
let frameState: PoseFrameState | null = null;
/** Frames in a row with no confidently detected pose (see
 *  nextStateAfterNoPose / POSE_PARAM_TUNING.NO_POSE_RESET_THRESHOLD). */
let consecutiveNoPoseFrames = 0;
/** Live-overridable via WorkerSetSpeedJitterFloorMessage (dev-only pose-tuning slider, main.ts) -- starts at the shipped default. */
let speedJitterFloor: number = POSE_PARAM_TUNING.SPEED_JITTER_FLOOR;

/**
 * Pre-executes MediaPipe's Emscripten wasm loader in this worker's global
 * scope, working around a known tasks-vision limitation in module workers
 * (google-ai-edge/mediapipe issues #5527, #4694, #5479, #5257).
 *
 * Mechanism (read from the installed vision_bundle.mjs, v1.0.1): MediaPipe
 * loads its wasm glue by calling importScripts(wasmLoaderPath) — which in an
 * ES module worker throws a TypeError that MediaPipe SWALLOWS — and then
 * fails with "ModuleFactory not set.". But it only needs that script to have
 * defined `ModuleFactory` on the worker's global scope, and it uses a
 * pre-existing one happily. So we fetch the exact loader script the fileset
 * resolved (SIMD or non-SIMD variant) and execute it at global scope
 * ourselves. Indirect eval — `(0, eval)(...)` — evaluates at global scope,
 * so the loader's top-level `var ModuleFactory = ...` lands on globalThis
 * exactly where importScripts() would have put it.
 *
 * Why not a classic worker (where importScripts exists)? Verified 2026-08-20:
 * Vite's dev server serves this file's `import` statements as-is, which a
 * classic worker cannot parse (`Cannot use import statement outside a
 * module`) — a known open Vite gap (vitejs/vite issues #8470, #7019, #2550).
 * Module worker + this pre-load is the one combination that works in BOTH
 * `npm run dev` and the production build.
 */
async function preloadWasmModuleFactory(wasmLoaderPath: string): Promise<void> {
  const scope = globalThis as { ModuleFactory?: unknown };
  if (typeof scope.ModuleFactory === 'function') return; // already loaded
  const response = await fetch(wasmLoaderPath);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm loader (HTTP ${response.status}): ${wasmLoaderPath}`);
  }
  const loaderSource = await response.text();
  // Deliberate eval: executes MediaPipe's own wasm loader (the same static
  // CDN asset MediaPipe itself would have run via importScripts) at global
  // scope; see the function comment above.
  (0, eval)(loaderSource);
  if (typeof scope.ModuleFactory !== 'function') {
    throw new Error(`wasm loader did not define ModuleFactory: ${wasmLoaderPath}`);
  }
}

async function createLandmarker(): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_FILESET_BASE_URL);
  await preloadWasmModuleFactory(vision.wasmLoaderPath);
  // Required for the GPU delegate to bind textures inside a worker, where
  // there is no document canvas to fall back on.
  const canvas = new OffscreenCanvas(1, 1);

  try {
    return await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      canvas,
    });
  } catch (gpuError) {
    console.warn('[pose-worker] GPU delegate unavailable, falling back to CPU:', gpuError);
    // MediaPipe clears self.ModuleFactory after consuming it (verified in
    // vision_bundle.mjs: `self.ModuleFactory=self.Module=void 0`), so the
    // retry needs the loader pre-executed again.
    await preloadWasmModuleFactory(vision.wasmLoaderPath);
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      canvas,
    });
  }
}

function handleFrame(frame: VideoFrame, captureTimeMs: number): void {
  if (!landmarker) {
    frame.close();
    return;
  }
  try {
    const result = landmarker.detectForVideo(frame, captureTimeMs);
    const landmarks = result.landmarks[0];
    if (landmarks && landmarks.length >= 33) {
      consecutiveNoPoseFrames = 0;
      const { params, state } = computeMovementParams(landmarks, captureTimeMs, frameState, speedJitterFloor);
      frameState = state;
      scope.postMessage({ type: 'result', params, timestampMs: captureTimeMs });
    } else {
      // No pose confidently detected this frame (e.g. nobody in view yet,
      // or the user stepped out of frame) — emit nothing rather than
      // inventing a sample, but the main thread still needs a message to
      // clear its "worker busy" flag or frame delivery stalls permanently.
      consecutiveNoPoseFrames += 1;
      frameState = nextStateAfterNoPose(consecutiveNoPoseFrames, frameState);
      scope.postMessage({ type: 'noPose', timestampMs: captureTimeMs });
    }
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    frame.close();
  }
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'frame') {
    handleFrame(message.frame, message.captureTimeMs);
  } else if (message.type === 'setSpeedJitterFloor') {
    speedJitterFloor = message.value;
  }
});

createLandmarker()
  .then((created) => {
    landmarker = created;
    scope.postMessage({ type: 'ready' });
  })
  .catch((err: unknown) => {
    scope.postMessage({
      type: 'error',
      message: `pose model failed to load: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
