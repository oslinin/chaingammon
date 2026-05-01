// Phase 31: unified mint — AgentRegistry.mintAgent automatically mints a
// corresponding PlayerSubnameRegistrar subname with kind="agent" and
// inft_id=<id>.
//
// Wire-up: deploy MatchRegistry + PlayerSubnameRegistrar + AgentRegistry;
// call agentRegistry.setSubnameRegistrar(registrar.address) and
// registrar.setAuthorizedMinter(agentRegistry.address, true).

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

const PARENT = namehash("backgammon.eth");

// Mirror the label-cleaning logic from AgentCard.tsx:
//   strip scheme (e.g. "ipfs://") and replace "/" with "-"
function cleanLabel(uri) {
  return uri.replace(/^[^:]+:\/\//, "").replaceAll("/", "-");
}

describe("Phase 31 — unified mint (AgentRegistry → PlayerSubnameRegistrar)", function () {
  let registrar, agentRegistry, matchRegistry;
  let owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    matchRegistry = await MatchRegistry.deploy();

    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT);

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(
      await matchRegistry.getAddress(),
      ZERO_HASH
    );

    // Wire: tell AgentRegistry where the registrar lives and authorize it to mint
    await agentRegistry.connect(owner).setSubnameRegistrar(await registrar.getAddress());
    await registrar.connect(owner).setAuthorizedMinter(await agentRegistry.getAddress(), true);
  });

  // Helper: existing call sites passed metadataURI + tier (3 args). Commit 0
  // adds a 4th arg `label_`; passing "" preserves the legacy `_cleanLabel`
  // behaviour. The test suite uses both forms below.
  const EMPTY_LABEL = "";

  it("after mintAgent a corresponding subname exists in PlayerSubnameRegistrar", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    const label = cleanLabel("ipfs://gnubg-tier1");
    const node = await registrar.subnameNode(label);
    expect(await registrar.ownerOf(node)).to.not.equal(ZERO_ADDR);
  });

  it("the subname's kind text record is 'agent'", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    const label = cleanLabel("ipfs://gnubg-tier1");
    const node = await registrar.subnameNode(label);
    expect(await registrar.text(node, "kind")).to.equal("agent");
  });

  it("the subname's inft_id text record matches the minted token id", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    const label = cleanLabel("ipfs://gnubg-tier1");
    const node = await registrar.subnameNode(label);
    expect(await registrar.text(node, "inft_id")).to.equal("1");
  });

  it("with empty label_, subname label is the cleaned agentMetadata (legacy fallback)", async function () {
    const uri = "ipfs://gnubg-tier1";
    await agentRegistry.connect(owner).mintAgent(alice.address, uri, 1, EMPTY_LABEL);
    const expected = cleanLabel(uri); // "gnubg-tier1"
    const node = await registrar.subnameNode(expected);
    expect(await registrar.ownerOf(node)).to.not.equal(ZERO_ADDR);
  });

  it("with explicit label_, the subname uses that label (not _cleanLabel(metadataURI))", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, "cleopatra");
    const explicitNode = await registrar.subnameNode("cleopatra");
    expect(await registrar.ownerOf(explicitNode)).to.equal(alice.address);
    // The auto-derived label should NOT have been used.
    const derivedNode = await registrar.subnameNode(cleanLabel("ipfs://gnubg-tier1"));
    expect(await registrar.ownerOf(derivedNode)).to.equal(ZERO_ADDR);
  });

  it("explicit label still gets kind='agent' and matching inft_id", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://meta", 2, "cleopatra");
    const node = await registrar.subnameNode("cleopatra");
    expect(await registrar.text(node, "kind")).to.equal("agent");
    expect(await registrar.text(node, "inft_id")).to.equal("1");
  });

  it("subnameCount increments from 0 to 1 to 2 across two mintAgent calls", async function () {
    expect(await registrar.subnameCount()).to.equal(0n);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    expect(await registrar.subnameCount()).to.equal(1n);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier2", 2, EMPTY_LABEL);
    expect(await registrar.subnameCount()).to.equal(2n);
  });

  it("second agent gets inft_id '2'", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier2", 2, EMPTY_LABEL);
    const label = cleanLabel("ipfs://gnubg-tier2");
    const node = await registrar.subnameNode(label);
    expect(await registrar.text(node, "inft_id")).to.equal("2");
  });

  it("mintAgent does not revert when no registrar is configured", async function () {
    // Deploy a fresh AgentRegistry with no registrar wired
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const ar = await AgentRegistry.deploy(await matchRegistry.getAddress(), ZERO_HASH);
    // No setSubnameRegistrar call — should still mint cleanly
    await ar.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    expect(await ar.agentCount()).to.equal(1n);
  });

  it("agent subname owner equals the 'to' wallet address", async function () {
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1, EMPTY_LABEL);
    const label = cleanLabel("ipfs://gnubg-tier1");
    const node = await registrar.subnameNode(label);
    expect(await registrar.ownerOf(node)).to.equal(alice.address);
  });
});
