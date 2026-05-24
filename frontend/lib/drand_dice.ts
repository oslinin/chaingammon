// drand_dice.ts — verifiable backgammon dice from a drand round.
//
// TypeScript port of `agent/drand_dice.py`. Each turn's dice are
//   bucket = keccak256(round_digest ‖ turn_index_be8) mod 36
//   d1 = bucket // 6 + 1   d2 = bucket % 6 + 1
// keccak256 is FIPS-202 SHA3-256 by spec, matching the Python (hashlib.sha3_256)
// and Solidity, so a roll derived here re-derives identically on any side.
//
// Why drand (not commit-reveal): a drand round is publicly attested by the
// League of Entropy and cannot be predicted before publication or forged after,
// so neither peer controls the roll and either can verify it — without a server
// or any per-match coordination. For human-vs-human each browser fetches the
// SAME round and derives identical dice; the round is a public decentralized
// beacon, so it stays serverless / off-chain like the Nostr relays.
//
// NOTE: both peers (and, for replay parity, the KeeperHub/Python path) must
// agree on which drand field is the "digest". We use the per-round `randomness`
// output here; keep `agent/drand_dice.py`'s caller aligned with the same field.

import { keccak256, type Hex } from "viem";

export const DICE_FACE_COUNT = 6;
export const DICE_PAIR_COUNT = DICE_FACE_COUNT * DICE_FACE_COUNT; // 36

export interface DiceRoll {
  d1: number;
  d2: number;
  roundNumber: number;
  turnIndex: number;
}

export function isDouble(roll: DiceRoll): boolean {
  return roll.d1 === roll.d2;
}

function hexToBytes(hex: Hex): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function turnIndexBE8(turnIndex: number): Uint8Array {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error(`turnIndex must be a non-negative integer, got ${turnIndex}`);
  }
  const buf = new Uint8Array(8);
  let n = BigInt(turnIndex);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

/**
 * Derive a `(d1, d2)` roll from a drand round digest (hex, e.g. the round's
 * `randomness`) and a per-match `turnIndex` (counter from 0). Deterministic and
 * verifiable: anyone with the same round + turnIndex recovers the same dice.
 */
export function deriveDice(
  roundDigest: Hex,
  turnIndex: number,
  roundNumber = -1,
): DiceRoll {
  const digest = hexToBytes(roundDigest);
  const input = new Uint8Array(digest.length + 8);
  input.set(digest, 0);
  input.set(turnIndexBE8(turnIndex), digest.length);

  const bucket = Number(BigInt(keccak256(input)) % BigInt(DICE_PAIR_COUNT));
  return {
    d1: Math.floor(bucket / DICE_FACE_COUNT) + 1,
    d2: (bucket % DICE_FACE_COUNT) + 1,
    roundNumber,
    turnIndex,
  };
}

// ── drand HTTP fetch ────────────────────────────────────────────────────────
//
// Default to drand "quicknet" (3s rounds) via the public api.drand.sh mirror so
// per-turn roll latency is ~3s rather than mainnet's 30s. Both peers MUST use
// the same beacon (chain hash) for dice to agree. Verify the chain hash /
// endpoint against https://drand.love when wiring this up.
export const DRAND_QUICKNET_CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const DRAND_BASE = `https://api.drand.sh/${DRAND_QUICKNET_CHAIN_HASH}`;

export interface DrandRound {
  round: number;
  randomness: Hex;
}

/** Fetch a drand round (defaults to the latest published round). */
export async function fetchDrandRound(round?: number): Promise<DrandRound> {
  const res = await fetch(`${DRAND_BASE}/public/${round ?? "latest"}`);
  if (!res.ok) throw new Error(`drand fetch failed: ${res.status}`);
  const j = (await res.json()) as { round: number; randomness: string };
  return { round: j.round, randomness: `0x${j.randomness}` as Hex };
}
