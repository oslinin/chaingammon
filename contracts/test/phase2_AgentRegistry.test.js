const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const TIER_ADVANCED = 2;

describe("Phase 2 — AgentRegistry (iNFT)", function () {
  let agentRegistry;
  let matchRegistry;
  let owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    matchRegistry = await MatchRegistry.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(matchRegistry.target, ZERO_HASH);
  });

  it("mints a new agent iNFT and increments agentId starting at 1", async function () {
    await (await agentRegistry.mintAgent(alice.address, "ipfs://test-uri", TIER_ADVANCED, "")).wait();
    expect(await agentRegistry.balanceOf(alice.address)).to.equal(1n);
    expect(await agentRegistry.ownerOf(1)).to.equal(alice.address);
  });

  it("stores and returns the agent metadata URI", async function () {
    await agentRegistry.mintAgent(alice.address, "ipfs://metadata-123", TIER_ADVANCED, "");
    expect(await agentRegistry.agentMetadata(1)).to.equal("ipfs://metadata-123");
  });

  it("returns ELO from MatchRegistry (default 1500 for new agent)", async function () {
    await agentRegistry.mintAgent(alice.address, "ipfs://test-uri", TIER_ADVANCED, "");
    expect(await agentRegistry.agentElo(1)).to.equal(1500n);
  });

  it("only owner can mint", async function () {
    let reverted = false;
    try {
      await agentRegistry.connect(alice).mintAgent(alice.address, "ipfs://x", TIER_ADVANCED, "");
    } catch (e) {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("auto-increments agentId across mints", async function () {
    await agentRegistry.mintAgent(alice.address, "ipfs://a", TIER_ADVANCED, "");
    await agentRegistry.mintAgent(alice.address, "ipfs://b", TIER_ADVANCED, "");
    await agentRegistry.mintAgent(alice.address, "ipfs://c", TIER_ADVANCED, "");
    expect(await agentRegistry.agentCount()).to.equal(3n);
    expect(await agentRegistry.ownerOf(3)).to.equal(alice.address);
  });
});
