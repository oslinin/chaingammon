const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

describe("MatchRegistry", function () {
  let registry;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    registry = await MatchRegistry.deploy();
  });

  describe("default ELO", function () {
    it("agentElo defaults to 1500 for unseen agentId", async function () {
      expect(await registry.agentElo(42)).to.equal(1500n);
    });

    it("humanElo defaults to 1500 for unseen address", async function () {
      expect(await registry.humanElo(alice.address)).to.equal(1500n);
    });
  });

  describe("recordMatch (human vs agent)", function () {
    it("emits MatchRecorded with new ELOs", async function () {
      // alice (human) beats agent #1
      const tx = await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment && l.fragment.name === "MatchRecorded");
      expect(evt).to.not.be.undefined;
    });

    it("updates winner up and loser down equally on equal ratings", async function () {
      // human alice (1500) beats agent #1 (1500)
      await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const aliceElo = await registry.humanElo(alice.address);
      const agentElo = await registry.agentElo(1);
      expect(Number(aliceElo)).to.be.greaterThan(1500);
      expect(Number(agentElo)).to.be.lessThan(1500);
      expect(Number(aliceElo) + Number(agentElo)).to.equal(3000);
    });

    it("multiple matches accumulate", async function () {
      // alice wins twice
      await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const after1 = Number(await registry.humanElo(alice.address));
      await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const after2 = Number(await registry.humanElo(alice.address));
      expect(after2).to.be.greaterThan(after1);
    });

    it("matchId increments", async function () {
      const tx1 = await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const tx2 = await registry.recordMatch(0, bob.address, 1, ZERO, 1, ZERO_HASH);
      const r1 = await tx1.wait();
      const r2 = await tx2.wait();
      const id1 = r1.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];
      const id2 = r2.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];
      expect(id2).to.equal(id1 + 1n);
    });
  });

  describe("recordMatch (agent vs agent)", function () {
    it("agent #1 beats agent #2 — both ELOs change", async function () {
      await registry.recordMatch(1, ZERO, 2, ZERO, 1, ZERO_HASH);
      expect(Number(await registry.agentElo(1))).to.be.greaterThan(1500);
      expect(Number(await registry.agentElo(2))).to.be.lessThan(1500);
    });
  });

  describe("permissioning", function () {
    it("non-owner cannot record matches", async function () {
      let reverted = false;
      try {
        await registry.connect(alice).recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  describe("getMatch (read recorded match)", function () {
    it("returns timestamp, participants, winner flag, and length", async function () {
      const tx = await registry.recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH);
      const receipt = await tx.wait();
      const matchId = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded").args[0];
      const match = await registry.getMatch(matchId);
      expect(match.matchLength).to.equal(1n);
      expect(match.winnerHuman).to.equal(alice.address);
      expect(match.loserAgentId).to.equal(1n);
    });
  });
});
