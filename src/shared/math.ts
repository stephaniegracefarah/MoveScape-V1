/** Clamp a value into the normalized 0–1 range used throughout MovementParams. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
