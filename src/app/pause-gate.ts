/**
 * Pause/resume for the readout, implemented purely in the wiring layer
 * (invariant 1: adapters know nothing about this). While paused, samples
 * from the active adapter keep arriving — the adapter itself is untouched,
 * so a camera stays warm — but the gate simply declines to forward them, so
 * whatever is downstream (the readout) freezes at its last values instead
 * of resetting. This is a deliberate precursor to session pause in later
 * milestones.
 */
import type { ParamsListener } from '../adapters/input-adapter';

export interface PauseGate {
  /** Pass this to InputAdapter.start() in place of the real listener. */
  listener: ParamsListener;
  isPaused(): boolean;
  pause(): void;
  resume(): void;
  /** Clear paused state, e.g. when starting or switching adapters. */
  reset(): void;
}

/** Wraps `forward` so it only fires while the gate is not paused. */
export function createPauseGate(forward: ParamsListener): PauseGate {
  let paused = false;

  return {
    listener(params, timestampMs) {
      if (!paused) forward(params, timestampMs);
    },
    isPaused(): boolean {
      return paused;
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
    },
    reset(): void {
      paused = false;
    },
  };
}
