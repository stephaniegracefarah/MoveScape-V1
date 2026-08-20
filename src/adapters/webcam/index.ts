/**
 * Webcam + pose input adapter (M1). Acquires the camera, captures frames
 * through the visibility-independent pipeline (capture.ts), and runs pose
 * inference off-thread (pose-worker.ts) to emit MovementParams samples at
 * the camera's native rate. See params-from-landmarks.ts for the landmark
 * → params math itself.
 */
import type { InputAdapter, ParamsListener } from '../input-adapter';
import { startFrameCapture, type FrameCaptureHandle } from './capture';
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker-protocol';

function describeGetUserMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera permission was denied. Allow camera access and try again.';
      case 'NotFoundError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
        return 'The camera is already in use by another application.';
      default:
        return `Camera access failed (${err.name}): ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Webcam + pose adapter. */
export function createWebcamAdapter(): InputAdapter {
  let stream: MediaStream | null = null;
  let capture: FrameCaptureHandle | null = null;
  let worker: Worker | null = null;
  let workerBusy = false;
  let running = false;

  function teardown(): void {
    capture?.stop();
    capture = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    worker?.terminate();
    worker = null;
    workerBusy = false;
    running = false;
  }

  async function start(onParams: ParamsListener): Promise<void> {
    if (running) {
      throw new Error('Webcam adapter is already running; call stop() first.');
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      throw new Error(describeGetUserMediaError(err), { cause: err });
    }

    // A MODULE worker — required for `npm run dev`, where Vite serves the
    // worker's `import` statements as real ES modules that only a module
    // worker can execute (a classic worker throws `Cannot use import
    // statement outside a module`; known open Vite gap, vitejs/vite issues
    // #8470, #7019, #2550 — verified here 2026-08-20 in headless Edge and
    // Chrome). MediaPipe's wasm loading normally requires importScripts(),
    // which module workers lack ("ModuleFactory not set."); pose-worker.ts
    // works around that by pre-executing the wasm loader itself — see
    // preloadWasmModuleFactory() there. Production `vite build` bundles the
    // worker either way. Do not change this worker's type or remove that
    // preload without re-verifying BOTH `npm run dev` AND `vite preview`.
    const poseWorker = new Worker(new URL('./pose-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker = poseWorker;

    // Wait for the worker to finish loading the pose model (GPU or CPU
    // delegate) before starting capture, so start() only resolves once the
    // adapter is actually live — and so any load failure rejects start()
    // instead of surfacing later as silent missing frames. The native
    // `error` and `messageerror` listeners and the timeout are load-bearing:
    // a worker script that fails to PARSE (e.g. the dev-mode classic-worker
    // regression this file's comments describe) never runs any worker code,
    // so it never posts a `{type:'error'}` message — only the native `error`
    // event fires. Without these, start() hangs forever while the camera
    // light is on, which looks deceptively like success.
    const READY_TIMEOUT_MS = 20_000;
    try {
      await new Promise<void>((resolve, reject) => {
        const settle = (result: { ok: true } | { ok: false; error: Error }): void => {
          clearTimeout(timer);
          poseWorker.removeEventListener('message', onMessage);
          poseWorker.removeEventListener('error', onError);
          poseWorker.removeEventListener('messageerror', onMessageError);
          if (result.ok) resolve();
          else reject(result.error);
        };
        const timer = setTimeout(() => {
          settle({
            ok: false,
            error: new Error(
              `Pose tracking failed to start: timed out after ${READY_TIMEOUT_MS / 1000}s waiting for the pose model to load (slow network fetching the model/wasm from CDN, or a silently crashed worker).`,
            ),
          });
        }, READY_TIMEOUT_MS);
        const onMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
          const message = event.data;
          if (message.type === 'ready') {
            settle({ ok: true });
          } else if (message.type === 'error') {
            settle({ ok: false, error: new Error(`Pose tracking failed to start: ${message.message}`) });
          }
        };
        const onError = (event: ErrorEvent): void => {
          settle({
            ok: false,
            error: new Error(`Pose tracking failed to start: pose worker crashed: ${event.message || 'unknown worker error'}`),
          });
        };
        const onMessageError = (): void => {
          settle({ ok: false, error: new Error('Pose tracking failed to start: pose worker message could not be deserialized.') });
        };
        poseWorker.addEventListener('message', onMessage);
        poseWorker.addEventListener('error', onError);
        poseWorker.addEventListener('messageerror', onMessageError);
      });
    } catch (err) {
      teardown();
      throw err;
    }

    // Post-ready: a worker crash can no longer reject start(), but it must
    // still be loud, not silent.
    poseWorker.addEventListener('error', (event: ErrorEvent) => {
      console.error('[webcam adapter] pose worker crashed:', event.message || event);
    });
    poseWorker.addEventListener('messageerror', () => {
      console.error('[webcam adapter] pose worker message could not be deserialized.');
    });

    poseWorker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (message.type === 'result') {
        workerBusy = false;
        onParams(message.params, message.timestampMs);
      } else if (message.type === 'noPose') {
        // No confidently detected pose this frame — no params to emit, but
        // the busy flag must still clear or frame delivery stalls forever.
        workerBusy = false;
      } else if (message.type === 'error') {
        workerBusy = false;
        // Per-frame errors (e.g. one bad detection) shouldn't end the
        // session — log and keep going.
        console.error('[webcam adapter] pose worker error:', message.message);
      }
    });

    const activeStream = stream;
    if (!activeStream) {
      teardown();
      throw new Error('Camera stream was released before capture could start.');
    }

    running = true;
    capture = startFrameCapture(activeStream, {
      onFrame: (frame) => {
        // Pose inference can't necessarily keep up with the camera's native
        // rate; drop frames while the worker is still busy rather than
        // queuing them, so params stay a live readout instead of lagging.
        if (!running || !worker || workerBusy) {
          frame.close();
          return;
        }
        workerBusy = true;
        const message: MainToWorkerMessage = { type: 'frame', frame, captureTimeMs: performance.now() };
        worker.postMessage(message, [frame]);
      },
      onError: (err) => {
        console.error('[webcam adapter] capture error:', err);
      },
    });
  }

  function stop(): void {
    teardown();
  }

  /** Live preview stream while running; null before start(), after stop(), or on start() failure. */
  function previewStream(): MediaStream | null {
    return running ? stream : null;
  }

  return { id: 'webcam', start, stop, previewStream };
}
