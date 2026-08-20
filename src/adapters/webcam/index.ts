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

    const poseWorker = new Worker(new URL('./pose-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker = poseWorker;

    // Wait for the worker to finish loading the pose model (GPU or CPU
    // delegate) before starting capture, so start() only resolves once the
    // adapter is actually live — and so any load failure rejects start()
    // instead of surfacing later as silent missing frames.
    try {
      await new Promise<void>((resolve, reject) => {
        const onReadyOrError = (event: MessageEvent<WorkerToMainMessage>): void => {
          const message = event.data;
          if (message.type === 'ready') {
            poseWorker.removeEventListener('message', onReadyOrError);
            resolve();
          } else if (message.type === 'error') {
            poseWorker.removeEventListener('message', onReadyOrError);
            reject(new Error(`Pose tracking failed to start: ${message.message}`));
          }
        };
        poseWorker.addEventListener('message', onReadyOrError);
      });
    } catch (err) {
      teardown();
      throw err;
    }

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

  return { id: 'webcam', start, stop };
}
