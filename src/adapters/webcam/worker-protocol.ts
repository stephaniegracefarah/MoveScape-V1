/**
 * Message protocol between the webcam adapter (main thread, index.ts) and
 * the pose worker (pose-worker.ts). Kept in its own module so both sides
 * import the same shapes instead of duplicating them.
 */
import type { MovementParams } from '../movement-params';

/**
 * Main thread → worker: a captured frame to run pose detection on. The
 * VideoFrame is transferred (not cloned) — the worker owns it once this
 * message is posted and is responsible for close()-ing it.
 */
export interface WorkerFrameMessage {
  type: 'frame';
  frame: VideoFrame;
  /** Capture-clock timestamp (ms) — becomes the emitted sample's timestamp. */
  captureTimeMs: number;
}

/**
 * Main thread → worker: live-retune the speed jitter floor (dev-only —
 * see main.ts's pose-tuning slider) without restarting the session. Added
 * because this constant can't be calibrated blind (no camera access in the
 * coordinator's own dev environment); a live camera + live slider is the
 * only way to actually dial it in.
 */
export interface WorkerSetSpeedJitterFloorMessage {
  type: 'setSpeedJitterFloor';
  value: number;
}

export type MainToWorkerMessage = WorkerFrameMessage | WorkerSetSpeedJitterFloorMessage;

/** Worker → main thread: the pose landmarker finished loading (GPU or CPU
 *  delegate) and the worker is ready to receive frames. */
export interface WorkerReadyMessage {
  type: 'ready';
}

/** Worker → main thread: one frame's computed MovementParams. */
export interface WorkerResultMessage {
  type: 'result';
  params: MovementParams;
  timestampMs: number;
}

/**
 * Worker → main thread: a frame was processed but no pose was confidently
 * detected (e.g. nobody in view). No params are attached — inventing a
 * sample would be worse than skipping one — but the main thread still needs
 * this message to clear its "worker busy" flag, or a single no-pose frame
 * would permanently stall frame delivery for the rest of the session.
 */
export interface WorkerNoPoseMessage {
  type: 'noPose';
  timestampMs: number;
}

/** Worker → main thread: an error. Fatal if it arrives before 'ready'
 *  (model/wasm failed to load); recoverable per-frame otherwise. */
export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerNoPoseMessage
  | WorkerErrorMessage;
