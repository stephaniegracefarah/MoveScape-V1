/**
 * cyrb53: a fast, deterministic, non-cryptographic string hash. Used to turn
 * arbitrary seed/label strings into a numeric seed for a PRNG. Pure 32-bit
 * integer math (via Math.imul), no external dependency.
 *
 * Reference implementation: https://stackoverflow.com/a/52171480
 */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  // Combine the two 32-bit halves into a 53-bit non-negative integer, safely
  // within Number.MAX_SAFE_INTEGER.
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
