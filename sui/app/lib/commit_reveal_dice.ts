// commit_reveal_dice.ts — commit-reveal dice for unrated peer-to-peer play.
//
// No drand round is available here (this app has no chain/beacon dependency
// at all — see design spec §5), so each turn both peers generate a random
// 32-byte secret and exchange:
//   1. { type: "dice-commit", h: keccak256(secret) }   (both directions)
//   2. { type: "dice-reveal", secret }                  (both directions, only
//      after both commitments are received)
// Once both secrets are known:
//   bucket = keccak256(secret_a ‖ secret_b ‖ turnIndexBE8) mod 36
//   d1 = bucket // 6 + 1   d2 = bucket % 6 + 1
// This is the same mod-36 -> (d1, d2) mapping as `frontend/lib/drand_dice.ts`'s
// `deriveDice`, so downstream game code (move generation, GNU Backgammon state)
// is unchanged between the drand-based (EVM) and commit-reveal (Sui) paths.
//
// Neither peer can bias the roll: each commits to its secret before either
// reveals, and a mismatched reveal (hash doesn't match the earlier commitment)
// is detected and rejected rather than silently accepted.

import { keccak256, type Hex } from "viem";

export const DICE_FACE_COUNT = 6;
export const DICE_PAIR_COUNT = DICE_FACE_COUNT * DICE_FACE_COUNT; // 36
export const SECRET_BYTE_LENGTH = 32;

export interface DiceRoll {
  d1: number;
  d2: number;
  turnIndex: number;
}

export function isDouble(roll: DiceRoll): boolean {
  return roll.d1 === roll.d2;
}

export class DiceCommitmentMismatchError extends Error {
  constructor(turnIndex: number) {
    super(`revealed secret does not match the earlier commitment (turn ${turnIndex})`);
    this.name = "DiceCommitmentMismatchError";
  }
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function hexToBytes(hex: Hex): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
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

/** Generate a fresh random 32-byte secret for one turn's commitment. */
export function generateSecret(): Hex {
  const bytes = new Uint8Array(SECRET_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** The commitment to broadcast before revealing the secret. */
export function commitSecret(secret: Hex): Hex {
  return keccak256(secret);
}

/** Verify a revealed secret matches an earlier commitment. */
export function verifyReveal(secret: Hex, commitment: Hex): boolean {
  return commitSecret(secret).toLowerCase() === commitment.toLowerCase();
}

/**
 * Derive this turn's `(d1, d2)` roll from both peers' revealed secrets.
 * Order of `secretA`/`secretB` doesn't matter to the caller as long as both
 * sides use the same fixed ordering (e.g. always creator-then-joiner) for a
 * given match, since swapping the order changes the digest.
 */
export function deriveDice(secretA: Hex, secretB: Hex, turnIndex: number): DiceRoll {
  const a = hexToBytes(secretA);
  const b = hexToBytes(secretB);
  const input = new Uint8Array(a.length + b.length + 8);
  input.set(a, 0);
  input.set(b, a.length);
  input.set(turnIndexBE8(turnIndex), a.length + b.length);

  const bucket = Number(BigInt(keccak256(input)) % BigInt(DICE_PAIR_COUNT));
  return {
    d1: Math.floor(bucket / DICE_FACE_COUNT) + 1,
    d2: (bucket % DICE_FACE_COUNT) + 1,
    turnIndex,
  };
}

/**
 * Derive dice for a turn, verifying the reveal against its commitment first.
 * Throws `DiceCommitmentMismatchError` if either side's reveal doesn't match
 * its earlier commitment.
 */
export function deriveDiceVerified(
  turnIndex: number,
  a: { secret: Hex; commitment: Hex },
  b: { secret: Hex; commitment: Hex },
): DiceRoll {
  if (!verifyReveal(a.secret, a.commitment) || !verifyReveal(b.secret, b.commitment)) {
    throw new DiceCommitmentMismatchError(turnIndex);
  }
  return deriveDice(a.secret, b.secret, turnIndex);
}
