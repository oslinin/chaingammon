// Phase 3 tests: MatchRegistry stores a gameRecordHash per match.
//
// The hash points to the full game record on 0G Storage (Phase 7).
// recordMatch accepts the hash as its last argument; bytes32(0) is allowed
// for matches recorded before 0G Storage exists (backward compatibility).

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;
const TEST_HASH = "0x" + "ab".repeat(32);

describe("Phase 3 — MatchRegistry gameRecordHash", function () {
  let registry;
  let owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    registry = await MatchRegistry.deploy();
  });

  it("recordMatch accepts a gameRecordHash as the last argument", async function () {
    // Should not revert
    await registry.recordMatch(0, alice.address, 1, ZERO, 1, TEST_HASH);
  });

  it("stores the gameRecordHash in the match struct", async function () {
    const tx = await registry.recordMatch(0, alice.address, 1, ZERO, 1, TEST_HASH);
    const receipt = await tx.wait();
    const matchId = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];
    const match = await registry.getMatch(matchId);
    expect(match.gameRecordHash).to.equal(TEST_HASH);
  });

  it("emits GameRecordStored event with matchId and hash", async function () {
    const tx = await registry.recordMatch(0, alice.address, 1, ZERO, 1, TEST_HASH);
    const receipt = await tx.wait();
    const evt = receipt.logs.find((l) => l.fragment?.name === "GameRecordStored");
    expect(evt).to.not.be.undefined;
    expect(evt.args[1]).to.equal(TEST_HASH);
  });

  it("permits bytes32(0) as gameRecordHash (backward compat)", async function () {
    const tx = await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
    const receipt = await tx.wait();
    const matchId = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];
    const match = await registry.getMatch(matchId);
    expect(match.gameRecordHash).to.equal(ZERO_HASH);
  });

  it("multiple matches store distinct hashes", async function () {
    const HASH_A = "0x" + "11".repeat(32);
    const HASH_B = "0x" + "22".repeat(32);

    const tx1 = await registry.recordMatch(0, alice.address, 1, ZERO, 1, HASH_A);
    const r1 = await tx1.wait();
    const id1 = r1.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];

    const tx2 = await registry.recordMatch(0, alice.address, 2, ZERO, 1, HASH_B);
    const r2 = await tx2.wait();
    const id2 = r2.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];

    const m1 = await registry.getMatch(id1);
    const m2 = await registry.getMatch(id2);
    expect(m1.gameRecordHash).to.equal(HASH_A);
    expect(m2.gameRecordHash).to.equal(HASH_B);
  });
});
