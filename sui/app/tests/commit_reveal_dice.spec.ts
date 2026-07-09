import { test, expect } from "@playwright/test";
import {
  commitSecret,
  deriveDice,
  deriveDiceVerified,
  DiceCommitmentMismatchError,
  isDouble,
  verifyReveal,
} from "../lib/commit_reveal_dice";
import type { Hex } from "viem";

// Fixed secrets so this test is deterministic across runs.
const SECRET_A: Hex = `0x${"a1".repeat(32)}`;
const SECRET_B: Hex = `0x${"b2".repeat(32)}`;

test("deriveDice is deterministic for fixed secrets and turn index", () => {
  const roll1 = deriveDice(SECRET_A, SECRET_B, 0);
  const roll2 = deriveDice(SECRET_A, SECRET_B, 0);
  expect(roll1).toEqual(roll2);
  expect(roll1.d1).toBeGreaterThanOrEqual(1);
  expect(roll1.d1).toBeLessThanOrEqual(6);
  expect(roll1.d2).toBeGreaterThanOrEqual(1);
  expect(roll1.d2).toBeLessThanOrEqual(6);
});

test("deriveDice changes with turnIndex", () => {
  const rolls = new Set<string>();
  for (let turnIndex = 0; turnIndex < 20; turnIndex++) {
    const roll = deriveDice(SECRET_A, SECRET_B, turnIndex);
    rolls.add(`${roll.d1}-${roll.d2}`);
  }
  // Not every roll need be unique, but 20 turns of a real hash function
  // should not collapse to a single repeated value.
  expect(rolls.size).toBeGreaterThan(1);
});

test("deriveDice changes when either secret changes", () => {
  const rollA = deriveDice(SECRET_A, SECRET_B, 0);
  const rollSwapped = deriveDice(SECRET_B, SECRET_A, 0);
  const otherSecretB: Hex = `0x${"c3".repeat(32)}`;
  const rollDifferentB = deriveDice(SECRET_A, otherSecretB, 0);
  expect(rollSwapped).not.toEqual(rollA);
  expect(rollDifferentB).not.toEqual(rollA);
});

test("commitSecret / verifyReveal round-trip", () => {
  const commitment = commitSecret(SECRET_A);
  expect(verifyReveal(SECRET_A, commitment)).toBe(true);
  expect(verifyReveal(SECRET_B, commitment)).toBe(false);
});

test("deriveDiceVerified succeeds when both reveals match their commitments", () => {
  const a = { secret: SECRET_A, commitment: commitSecret(SECRET_A) };
  const b = { secret: SECRET_B, commitment: commitSecret(SECRET_B) };
  const roll = deriveDiceVerified(0, a, b);
  expect(roll).toEqual(deriveDice(SECRET_A, SECRET_B, 0));
});

test("deriveDiceVerified throws DiceCommitmentMismatchError on a mismatched reveal", () => {
  const a = { secret: SECRET_A, commitment: commitSecret(SECRET_A) };
  // b's commitment doesn't match the revealed secret.
  const b = { secret: SECRET_B, commitment: commitSecret(SECRET_A) };
  expect(() => deriveDiceVerified(0, a, b)).toThrow(DiceCommitmentMismatchError);
});

test("isDouble detects matching dice", () => {
  expect(isDouble({ d1: 3, d2: 3, turnIndex: 0 })).toBe(true);
  expect(isDouble({ d1: 3, d2: 4, turnIndex: 0 })).toBe(false);
});
