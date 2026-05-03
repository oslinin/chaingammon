// Phase 31: unified mint — AgentRegistry.mintAgent automatically mints a
// corresponding PlayerSubnameRegistrar subname. After the NameWrapper
// migration the agent's iNFT id is recorded in the SubnameMinted event's
// inftId field rather than in resolver text records.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const ZERO_ADDR = ethers.ZeroAddress;

function namehash(name) {
  let node = ZERO_HASH;
  if (name) {
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = ethers.keccak256(ethers.toUtf8Bytes(labels[i]));
      node = ethers.keccak256(ethers.concat([node, labelHash]));
    }
  }
  return node;
}

const PARENT = namehash("chaingammon.eth");

function cleanLabel(uri) {
  return uri.replace(/^[^:]+:\/\//, "").replaceAll("/", "-");
}

async function findMintedEvents(registrar, fromBlock = 0) {
  const filter = registrar.filters.SubnameMinted();
  return await registrar.queryFilter(filter, fromBlock);
}

describe("Phase 31 — unified mint (AgentRegistry → PlayerSubnameRegistrar)", function () {
  let registrar, agentRegistry, matchRegistry, nameWrapper, resolver;
  let owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    matchRegistry = await MatchRegistry.deploy();

    const NameWrapper = await ethers.getContractFactory("MockNameWrapper");
    nameWrapper = await NameWrapper.deploy();

    const Resolver = await ethers.getContractFactory("MockResolver");
    resolver = await Resolver.deploy();

    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(
      PARENT,
      await nameWrapper.getAddress(),
      await resolver.getAddress()
    );

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(
      await matchRegistry.getAddress(),
      ZERO_HASH
    );

    await agentRegistry.connect(owner).setSubnameRegistrar(await registrar.getAddress());
    await registrar.connect(owner).setAuthorizedMinter(await agentRegistry.getAddress(), true);
  });

  it("after mintAgent a corresponding subname exists in PlayerSubnameRegistrar", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
    const label = cleanLabel("ipfs://gnubg-tier1");
    expect(await registrar.ownerOf(label)).to.equal(alice.address);
  });

  it("the SubnameMinted event records inftId matching the minted agent id", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
    const events = await findMintedEvents(registrar);
    expect(events.length).to.equal(1);
    expect(events[0].args.label).to.equal("gnubg-tier1");
    expect(events[0].args.inftId).to.equal(1n);
  });

  it("subname label is the cleaned agentMetadata (no scheme prefix)", async function () {
    const uri = "ipfs://gnubg-tier1";
    await agentRegistry.connect(owner).mintAgent(alice.address, uri, 1);
    const expected = cleanLabel(uri); // "gnubg-tier1"
    expect(await registrar.ownerOf(expected)).to.equal(alice.address);
  });

  it("second agent gets inftId=2 in its SubnameMinted event", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier2", 2);
    const events = await findMintedEvents(registrar);
    expect(events.length).to.equal(2);
    expect(events[1].args.label).to.equal("gnubg-tier2");
    expect(events[1].args.inftId).to.equal(2n);
  });

  it("mintAgent does not revert when no registrar is configured", async function () {
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const ar = await AgentRegistry.deploy(await matchRegistry.getAddress(), ZERO_HASH);
    await ar.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
    expect(await ar.agentCount()).to.equal(1n);
  });

  it("agent subname owner equals the 'to' wallet address", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
    expect(await registrar.ownerOf("gnubg-tier1")).to.equal(alice.address);
  });
});
