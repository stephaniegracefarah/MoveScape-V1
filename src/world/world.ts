/**
 * The World object derived from the day's seed (spec Part 3). World-level
 * knobs are labeled streams derived from worldSeed -- stable across
 * sessions on the same day ("Tuesday is Tuesday"). sessionSeed is exposed
 * for styles that need session-level jitter, derived via their own
 * createLabeledStream(world.sessionSeed, someLabel) call.
 */
import { createLabeledStream } from './labeled-stream';
import { deriveSessionSeed } from './seed';

export type WorldOverrides = Readonly<Record<string, number>>;

export interface World {
  worldSeed: string;
  sessionSeed: string;
  sessionIndex: number;
  knob(name: string): number;
}

export function createWorld(
  worldSeed: string,
  sessionIndex: number,
  overrides?: WorldOverrides,
): World {
  const sessionSeed = deriveSessionSeed(worldSeed, sessionIndex);

  return {
    worldSeed,
    sessionSeed,
    sessionIndex,
    knob(name: string): number {
      return overrides?.[name] ?? createLabeledStream(worldSeed, name)();
    },
  };
}
