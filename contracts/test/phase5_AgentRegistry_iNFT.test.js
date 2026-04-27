// Phase 5 tests: AgentRegistry takes the ERC-7857-compatible iNFT shape.
//
// Each agent iNFT carries:
//   - tier (uint8)            immutable, set at mint
//   - dataHashes[2]            [baseWeightsHash, overlayHash]
//   - matchCount (uint32)      increments per match
//   - experienceVersion (uint32) increments when overlay updates
//
// dataHashes[0] is the same for every agent — a contract-level constant set
// by the owner. dataHashes[1] is unique per agent and updates after each match.
//
// Full ERC-7857 transfer-with-reencryption flow is out of scope for v1.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const BASE_HASH = "0x" + "ba".repeat(32); // arbitrary placeholder for tests
const OVERLAY_HASH_A = "0x" + "1a".repeat(32);
const OVERLAY_HASH_B = "0x" + "2b".repeat(32);

const TIER_BEGINNER = 0;
const TIER_INTERMEDIATE = 1;
const TIER_ADVANCED = 2;
const TIER_WORLD_CLASS = 3;

describe("Phase 5 — AgentRegistry iNFT (ERC-7857 shape)", function () {
  let agentRegistry;
  let matchRegistry;
  let owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    matchRegistry = await MatchRegistry.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(matchRegistry.target, BASE_HASH);
  });

  describe("baseWeightsHash (shared)", function () {
    it("constructor seeds baseWeightsHash", async function () {
      expect(await agentRegistry.baseWeightsHash()).to.equal(BASE_HASH);
    });

    it("owner can update baseWeightsHash", async function () {
      const NEW_HASH = "0x" + "cc".repeat(32);
      await agentRegistry.setBaseWeightsHash(NEW_HASH);
      expect(await agentRegistry.baseWeightsHash()).to.equal(NEW_HASH);
    });

    it("non-owner cannot update baseWeightsHash", async function () {
      let reverted = false;
      try {
        await agentRegistry.connect(alice).setBaseWeightsHash(ZERO_HASH);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  describe("mintAgent (now takes tier)", function () {
    it("stores tier on the agent", async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://x", TIER_ADVANCED);
      expect(await agentRegistry.tier(1)).to.equal(BigInt(TIER_ADVANCED));
    });

    it("agents at different tiers are independent", async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://b", TIER_BEGINNER);
      await agentRegistry.mintAgent(alice.address, "ipfs://w", TIER_WORLD_CLASS);
      expect(await agentRegistry.tier(1)).to.equal(BigInt(TIER_BEGINNER));
      expect(await agentRegistry.tier(2)).to.equal(BigInt(TIER_WORLD_CLASS));
    });

    it("rejects tier > 3", async function () {
      let reverted = false;
      try {
        await agentRegistry.mintAgent(alice.address, "ipfs://x", 4);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("agent's initial dataHashes are [baseWeightsHash, ZERO]", async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://x", TIER_ADVANCED);
      const hashes = await agentRegistry.dataHashes(1);
      expect(hashes.length).to.equal(2);
      expect(hashes[0]).to.equal(BASE_HASH);
      expect(hashes[1]).to.equal(ZERO_HASH);
    });

    it("agent's matchCount and experienceVersion start at 0", async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://x", TIER_ADVANCED);
      expect(await agentRegistry.matchCount(1)).to.equal(0n);
      expect(await agentRegistry.experienceVersion(1)).to.equal(0n);
    });
  });

  describe("updateOverlayHash (server updates after each match)", function () {
    beforeEach(async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://x", TIER_ADVANCED);
    });

    it("updates dataHashes[1] to the new overlay hash", async function () {
      await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_A);
      const hashes = await agentRegistry.dataHashes(1);
      expect(hashes[1]).to.equal(OVERLAY_HASH_A);
    });

    it("dataHashes[0] is unchanged after overlay update", async function () {
      await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_A);
      const hashes = await agentRegistry.dataHashes(1);
      expect(hashes[0]).to.equal(BASE_HASH);
    });

    it("increments matchCount and experienceVersion per call", async function () {
      await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_A);
      expect(await agentRegistry.matchCount(1)).to.equal(1n);
      expect(await agentRegistry.experienceVersion(1)).to.equal(1n);
      await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_B);
      expect(await agentRegistry.matchCount(1)).to.equal(2n);
      expect(await agentRegistry.experienceVersion(1)).to.equal(2n);
    });

    it("emits OverlayUpdated event", async function () {
      const tx = await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_A);
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "OverlayUpdated");
      expect(evt).to.not.be.undefined;
      expect(evt.args[0]).to.equal(1n);
      expect(evt.args[1]).to.equal(OVERLAY_HASH_A);
    });

    it("non-owner cannot update", async function () {
      let reverted = false;
      try {
        await agentRegistry.connect(alice).updateOverlayHash(1, OVERLAY_HASH_A);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("rejects update on non-existent agent", async function () {
      let reverted = false;
      try {
        await agentRegistry.updateOverlayHash(999, OVERLAY_HASH_A);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  describe("two iNFTs diverge after independent matches", function () {
    it("same tier, different overlay history → different dataHashes[1]", async function () {
      await agentRegistry.mintAgent(alice.address, "ipfs://a", TIER_ADVANCED);
      await agentRegistry.mintAgent(alice.address, "ipfs://b", TIER_ADVANCED);

      // same tier, same base hash, same initial overlay
      const before1 = await agentRegistry.dataHashes(1);
      const before2 = await agentRegistry.dataHashes(2);
      expect(before1[1]).to.equal(before2[1]);

      // diverge: only agent #1 plays a match
      await agentRegistry.updateOverlayHash(1, OVERLAY_HASH_A);

      const after1 = await agentRegistry.dataHashes(1);
      const after2 = await agentRegistry.dataHashes(2);
      expect(after1[1]).to.not.equal(after2[1]);
      expect(after1[1]).to.equal(OVERLAY_HASH_A);
      expect(after2[1]).to.equal(ZERO_HASH);
    });
  });
});
