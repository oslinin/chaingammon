// Pure dice-rolling helper. Browser-side dice for v1 (human-vs-agent):
// the human is rolling for themselves, so trust is local.
//
// Uses `crypto.getRandomValues` — distinguishes from `Math.random` so a
// future swap to commit-reveal / VRF-backed dice is a single-file change
// with no transitive call-site updates. v2 (human-vs-human) will need
// commit-reveal here.

const SIDES = 6;

/**
 * Roll two six-sided dice. Returns `[d1, d2]` where each value is in
 * [1, 6]. Uniform distribution per crypto.getRandomValues.
 */
export function rollDice(): [number, number] {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // Modulo would skew the distribution — use floor of (n / (UINT32_MAX+1))
  // multiplied by SIDES. JS numbers are doubles so this is exact for
  // 32-bit inputs. UINT32_MAX+1 = 0x100000000 = 4294967296.
  const d1 = Math.floor((buf[0] / 0x100000000) * SIDES) + 1;
  const d2 = Math.floor((buf[1] / 0x100000000) * SIDES) + 1;
  return [d1, d2];
}
