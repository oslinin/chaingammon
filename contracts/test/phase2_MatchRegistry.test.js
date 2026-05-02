const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

describe("Phase 2 — MatchRegistry", function () {
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
      await expect(
        registry.connect(alice).recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH)
      ).to.be.revertedWithCustomError(registry, "NotOwnerOrSettler");
    });
  });

  describe("settler role", function () {
    it("settler defaults to zero address", async function () {
      expect(await registry.settler()).to.equal(ZERO);
    });

    it("owner can set the settler and emits SettlerSet", async function () {
      await expect(registry.connect(owner).setSettler(alice.address))
        .to.emit(registry, "SettlerSet")
        .withArgs(ZERO, alice.address);
      expect(await registry.settler()).to.equal(alice.address);
    });

    it("non-owner cannot set the settler", async function () {
      await expect(
        registry.connect(alice).setSettler(alice.address)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("settler can record matches", async function () {
      await registry.connect(owner).setSettler(alice.address);
      // alice (now settler) records a match between bob (human) and agent #1.
      const tx = await registry.connect(alice).recordMatch(
        0, bob.address, 1, ZERO, 1, ZERO_HASH
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded");
      expect(evt).to.not.be.undefined;
    });

    it("non-settler non-owner still cannot record matches after a settler is set", async function () {
      await registry.connect(owner).setSettler(alice.address);
      // bob is neither owner nor settler.
      await expect(
        registry.connect(bob).recordMatch(0, bob.address, 1, ZERO, 1, ZERO_HASH)
      ).to.be.revertedWithCustomError(registry, "NotOwnerOrSettler");
    });

    it("owner can revoke the settler by setting address(0)", async function () {
      await registry.connect(owner).setSettler(alice.address);
      await expect(registry.connect(owner).setSettler(ZERO))
        .to.emit(registry, "SettlerSet")
        .withArgs(alice.address, ZERO);
      // alice can no longer record.
      await expect(
        registry.connect(alice).recordMatch(0, alice.address, 1, ZERO, 1, ZERO_HASH)
      ).to.be.revertedWithCustomError(registry, "NotOwnerOrSettler");
    });

    it("owner can still record matches when a settler is set", async function () {
      await registry.connect(owner).setSettler(alice.address);
      const tx = await registry.connect(owner).recordMatch(
        0, bob.address, 1, ZERO, 1, ZERO_HASH
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded");
      expect(evt).to.not.be.undefined;
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
