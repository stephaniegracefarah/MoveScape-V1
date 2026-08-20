/**
 * The adapter interface every input source implements (invariant 1: the
 * MovementParams contract is the only coupling between adapters and
 * everything downstream).
 */
import type { MovementParams } from './movement-params';

/** Receives each new sample as the adapter produces it. */
export type ParamsListener = (params: MovementParams, timestampMs: number) => void;

export interface InputAdapter {
  id: string;
  /** Begin producing samples; resolves once the adapter is live. */
  start(onParams: ParamsListener): Promise<void>;
  /** Stop producing samples and release resources (camera, workers, timers). */
  stop(): void;
}
