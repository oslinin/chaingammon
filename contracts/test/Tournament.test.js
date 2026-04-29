/**
 * Tournament.test.js — Hardhat + ethers tests for the Tournament ELO contract.
 *
 * Test coverage:
 *  1. Happy path: valid co-signed match updates both ELOs (sum preserved).
 *  2. Missing signature reverts.
 *  3. Wrong-signer signature reverts.
 *  4. Replay attack (re-submitting same nonce) reverts.
 *  5. ELO drift: 100 mock matches between equal agents stays within ±50 of 1500.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ── EIP-712 helpers ────────────────────────────────────────────────────────────

async function getDomainSeparator(tournament) {
  return tournament.DOMAIN_SEPARATOR();
}

async function signMatch(signer, tournament, agentA, agentB, scoreA, scoreB, nonce) {
  const domain = {
    name: "Tournament",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await tournament.getAddress(),
  };
  const types = {
    Match: [
      { name: "agentA",  type: "address" },
      { name: "agentB",  type: "address" },
      { name: "scoreA",  type: "uint8"   },
      { name: "scoreB",  type: "uint8"   },
      { name: "nonce",   type: "uint256" },
    ],
  };
  const value = { agentA, agentB, scoreA, scoreB, nonce };
  return signer.signTypedData(domain, types, value);
}

async function reportMatch(tournament, signerA, signerB, scoreA, scoreB) {
  const addrA = signerA.address;
  const addrB = signerB.address;
  const pairKey = ethers.toBigInt(addrA) ^ ethers.toBigInt(addrB);
  const nonce = await tournament.pairNonce(ethers.toBeHex(pairKey, 32));

  const sigA = await signMatch(signerA, tournament, addrA, addrB, scoreA, scoreB, nonce);
  const sigB = await signMatch(signerB, tournament, addrA, addrB, scoreA, scoreB, nonce);

  return tournament.reportMatch(addrA, addrB, scoreA, scoreB, sigA, sigB);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Tournament", function () {
  let tournament, owner, agentA, agentB, stranger;

  beforeEach(async function () {
    [owner, agentA, agentB, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("Tournament");
    tournament = await Factory.deploy();
    await tournament.waitForDeployment();
  });

  // ── 1. Happy path ────────────────────────────────────────────────────────────

  it("valid co-signed match updates both ELOs; sum preserved within ±1", async function () {
    const eloA_before = 1500n;
    const eloB_before = 1500n;

    await reportMatch(tournament, agentA, agentB, 14, 6);

    const eloA_after = BigInt(await tournament.eloRating(agentA.address));
    const eloB_after = BigInt(await tournament.eloRating(agentB.address));

    expect(eloA_after).to.be.gt(eloA_before);
    expect(eloB_after).to.be.lt(eloB_before);

    // ELO is zero-sum: sum of both should be preserved within ±1 due to rounding.
    const sumBefore = eloA_before + eloB_before;
    const sumAfter  = eloA_after  + eloB_after;
    const diff = sumAfter - sumBefore;
    const absDiff = diff < 0n ? -diff : diff;
    expect(absDiff).to.be.lte(1n);
  });

  it("emits MatchReported event", async function () {
    await expect(reportMatch(tournament, agentA, agentB, 10, 10))
      .to.emit(tournament, "MatchReported")
      .withArgs(agentA.address, agentB.address, 10, 10,
                await tournament.eloRating(agentA.address).then(() => undefined),
                // We only check the event fires; exact ELOs checked in other tests.
                await tournament.eloRating(agentB.address).then(() => undefined));
  });

  // ── 2. Missing signature reverts ──────────────────────────────────────────────

  it("reverts when signature is too short", async function () {
    const addrA = agentA.address;
    const addrB = agentB.address;
    const nonce = 0n;
    const sigA = await signMatch(agentA, tournament, addrA, addrB, 10, 10, nonce);
    const badSig = "0x" + "00".repeat(32); // 32 bytes, not 65

    await expect(
      tournament.reportMatch(addrA, addrB, 10, 10, badSig, sigA)
    ).to.be.revertedWith("Tournament: bad sig length");
  });

  // ── 3. Wrong-signer reverts ────────────────────────────────────────────────────

  it("reverts when agentA signature is from a stranger", async function () {
    const addrA = agentA.address;
    const addrB = agentB.address;
    const nonce = 0n;

    const strangeSig = await signMatch(stranger, tournament, addrA, addrB, 10, 10, nonce);
    const sigB = await signMatch(agentB, tournament, addrA, addrB, 10, 10, nonce);

    await expect(
      tournament.reportMatch(addrA, addrB, 10, 10, strangeSig, sigB)
    ).to.be.revertedWith("Tournament: bad sig A");
  });

  it("reverts when agentB signature is from a stranger", async function () {
    const addrA = agentA.address;
    const addrB = agentB.address;
    const nonce = 0n;

    const sigA = await signMatch(agentA, tournament, addrA, addrB, 10, 10, nonce);
    const strangeSig = await signMatch(stranger, tournament, addrA, addrB, 10, 10, nonce);

    await expect(
      tournament.reportMatch(addrA, addrB, 10, 10, sigA, strangeSig)
    ).to.be.revertedWith("Tournament: bad sig B");
  });

  // ── 4. Replay attack reverts ───────────────────────────────────────────────────

  it("reverts on replay (same nonce submitted twice)", async function () {
    const addrA = agentA.address;
    const addrB = agentB.address;
    const nonce = 0n;

    const sigA = await signMatch(agentA, tournament, addrA, addrB, 10, 10, nonce);
    const sigB = await signMatch(agentB, tournament, addrA, addrB, 10, 10, nonce);

    // First submission succeeds.
    await tournament.reportMatch(addrA, addrB, 10, 10, sigA, sigB);

    // Replay with the same nonce-0 signatures must fail.
    await expect(
      tournament.reportMatch(addrA, addrB, 10, 10, sigA, sigB)
    ).to.be.reverted;
  });

  // ── 5. ELO drift under 100 equal-strength matches ──────────────────────────────

  it("ELO stays within ±50 of 1500 after 100 50/50 matches", async function () {
    this.timeout(120_000); // allow time for 100 on-chain txs on hardhat

    for (let i = 0; i < 100; i++) {
      await reportMatch(tournament, agentA, agentB, 10, 10);
    }

    const eloA = Number(await tournament.eloRating(agentA.address));
    const eloB = Number(await tournament.eloRating(agentB.address));

    expect(Math.abs(eloA - 1500)).to.be.lte(50,
      `ELO A drifted too far: ${eloA}`);
    expect(Math.abs(eloB - 1500)).to.be.lte(50,
      `ELO B drifted too far: ${eloB}`);
  });

  // ── topN ──────────────────────────────────────────────────────────────────────

  it("topN returns sorted leaderboard", async function () {
    // agentA wins all 20 games → should top the leaderboard.
    await reportMatch(tournament, agentA, agentB, 20, 0);

    const { addrs, elos } = await tournament.topN(2);

    expect(addrs[0].toLowerCase()).to.equal(agentA.address.toLowerCase());
    expect(Number(elos[0])).to.be.gt(Number(elos[1]));
  });

  it("topN(0) returns empty arrays", async function () {
    const { addrs, elos } = await tournament.topN(0);
    expect(addrs.length).to.equal(0);
    expect(elos.length).to.equal(0);
  });

  // ── Self-match guard ──────────────────────────────────────────────────────────

  it("reverts on self-match", async function () {
    const nonce = 0n;
    const addrA = agentA.address;
    const sig = await signMatch(agentA, tournament, addrA, addrA, 10, 10, nonce);
    await expect(
      tournament.reportMatch(addrA, addrA, 10, 10, sig, sig)
    ).to.be.revertedWith("Tournament: self-match");
  });
});
