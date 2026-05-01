// Commit 3: deploy script bootstraps the seed agent's subname so
// /play/new has at least one auto-playable entry out of the gate.
//
// The deploy script's seed-agent flow:
//   1. Deploy PlayerSubnameRegistrar with parentNode=namehash("backgammon.eth")
//   2. Deploy AgentRegistry
//   3. Wire: agentRegistry.setSubnameRegistrar(registrar) +
//            registrar.setAuthorizedMinter(agentRegistry, true)
//   4. agentRegistry.mintAgent(deployer, "ipfs://...", 2, "gnubg-default-1")
//      → atomic side-effect: subname minted with kind="agent", inft_id="1"
//      → registrar's _seedDefaults writes elo=1500
//
// These tests assert each invariant on a fresh deployment WITHOUT
// running the deploy script directly (it writes JSON, has env-var
// branches, etc.); we replay the relevant subset inline.

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
const SEED_AGENT_LABEL = "gnubg-default-1";
const SEED_AGENT_TIER = 2;
const SEED_AGENT_METADATA = "ipfs://gnubg-default-placeholder";

describe("Commit 3 — seed-agent subname bootstrap", function () {
  let registrar, agentRegistry, matchRegistry;
  let deployer;
  let seedNode;

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    matchRegistry = await MatchRegistry.deploy();

    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT);

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(
      await matchRegistry.getAddress(),
      ZERO_HASH,
    );

    // Wire (mirrors deploy.js).
    await agentRegistry.setSubnameRegistrar(await registrar.getAddress());
    await registrar.setAuthorizedMinter(await agentRegistry.getAddress(), true);

    // Mint with the explicit label.
    await agentRegistry.mintAgent(
      deployer.address,
      SEED_AGENT_METADATA,
      SEED_AGENT_TIER,
      SEED_AGENT_LABEL,
    );

    seedNode = await registrar.subnameNode(SEED_AGENT_LABEL);
  });

  it("the seed agent's subname is owned by the deployer", async function () {
    expect(await registrar.ownerOf(seedNode)).to.equal(deployer.address);
  });

  it("the seed subname's namehash matches namehash('gnubg-default-1.backgammon.eth')", async function () {
    expect(seedNode).to.equal(namehash(`${SEED_AGENT_LABEL}.backgammon.eth`));
  });

  it("the seed subname has eloOf == 1500 from _seedDefaults", async function () {
    expect(await registrar.eloOf(seedNode)).to.equal(1500n);
  });

  it("the seed subname has kind='agent' (atomic-mint side effect)", async function () {
    expect(await registrar.text(seedNode, "kind")).to.equal("agent");
  });

  it("the seed subname has inft_id='1' (matching agent token id)", async function () {
    expect(await registrar.text(seedNode, "inft_id")).to.equal("1");
  });

  it("deployer cannot directly setElo on the seed subname (lockdown holds)", async function () {
    let reverted = false;
    try {
      await registrar.connect(deployer).setElo(seedNode, 9999n);
    } catch (e) {
      reverted = true;
    }
    expect(
      reverted,
      "deployer is contract owner but not on the minter allowlist for ELO writes",
    ).to.be.true;
  });

  it("deployer attempting setText('elo', ...) reverts unconditionally", async function () {
    let reverted = false;
    try {
      await registrar.connect(deployer).setText(seedNode, "elo", "9999");
    } catch (e) {
      reverted = true;
    }
    expect(reverted, "setText with elo key always reverts; use setElo").to.be.true;
  });
});
