/**
 * Constant-time string equality.
 *
 * Prevents timing oracles that leak secrets one byte at a time via JS `===`
 * short-circuit. Returns false immediately if lengths differ — length itself
 * is not considered secret (callers should ensure both inputs are of expected
 * length before comparing).
 *
 * Safe for ASCII/hex/base64 strings. For raw bytes, compare Uint8Arrays.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
