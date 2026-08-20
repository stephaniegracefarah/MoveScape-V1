/**
 * cyrb53: a fast, deterministic, non-cryptographic hash. Used to turn
 * arbitrary seed/label strings (and, via `cyrb53Bytes`, raw pixel bytes)
 * into a numeric digest. Pure 32-bit integer math (via Math.imul), no
 * external dependency.
 *
 * Reference implementation: https://stackoverflow.com/a/52171480
 */

/**
 * The shared mixing loop and finalization, parameterized only by how the
 * i-th "character code" is read -- a string's char code and a byte value
 * are both already 0-255-ish integers feeding the same h1/h2 updates, so
 * `cyrb53` and `cyrb53Bytes` differ only in `at`.
 */
function cyrb53Core(length: number, at: (i: number) => number, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < length; i++) {
    const ch = at(i);
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

export function cyrb53(str: string, seed = 0): number {
  return cyrb53Core(str.length, (i) => str.charCodeAt(i), seed);
}

/**
 * Byte-indexed variant of `cyrb53`, for hashing raw bytes (e.g. pixel data
 * read back from a canvas) without first routing them through `Buffer` or
 * `String.fromCharCode` -- `src/shared/` stays portable to a real browser,
 * where `Buffer` doesn't exist, so byte-array hashing is a first-class
 * supported input type rather than a workaround.
 */
export function cyrb53Bytes(bytes: Uint8Array | Uint8ClampedArray, seed = 0): number {
  // Safe: i is always < bytes.length inside cyrb53Core's loop.
  return cyrb53Core(bytes.length, (i) => bytes[i]!, seed);
}
