/**
 * The World object derived from the day's seed. This is a placeholder shape;
 * M2 builds the real derivation (labeled PRNG streams, palette, growth
 * personality, user-override layering).
 */
export interface World {
  worldSeed: string;
  sessionIndex: number;
}
