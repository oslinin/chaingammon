// Tests for script/seed_agent_subnames.js
//
// After the NameWrapper migration the registrar has no internal storage
// — text records (kind, inft_id) live in resolver state and are no
// longer set by the script. The script's job is now simpler:
//
//   1. Wire AgentRegistry → PlayerSubnameRegistrar (idempotent)
//   2. For each existing agent: if ownerOf(label) is zero, mintSubname(label, owner, agentId)
//
// Idempotency: a second run is a no-op (every existing subname already
// has a non-zero owner in NameWrapper).

const { expect } = require("chai");
const { ethers } = require("hardhat");

function cleanLabel(metadataUri) {
  return metadataUri.replace(/^[^:]+:\/\//, "").replaceAll("/", "-");
}

function namehash(name) {
  let node = ethers.ZeroHash;
  if (name) {
    for (const label of name.split(".").reverse()) {
      node = ethers.keccak256(
        ethers.concat([node, ethers.keccak256(ethers.toUtf8Bytes(label))])
      );
    }
  }
  return node;
}

const PARENT = namehash("chaingammon.eth");

// Mirror of the script's backfill logic. Returns counts of side effects.
async function runBackfill(agentRegistry, registrar, deployer) {
  let registrarSet = false;
  let subnameMinted = 0;

  const registrarAddr = await registrar.getAddress();
  const currentRegistrar = await agentRegistry.subnameRegistrar();
  if (currentRegistrar.toLowerCase() !== registrarAddr.toLowerCase()) {
    await agentRegistry.connect(deployer).setSubnameRegistrar(registrarAddr);
    registrarSet = true;
  }

  const agentCount = Number(await agentRegistry.agentCount());
  for (let agentId = 1; agentId <= agentCount; agentId++) {
    const metadataUri = await agentRegistry.agentMetadata(agentId);
    const agentOwner = await agentRegistry.ownerOf(agentId);
    const label = cleanLabel(metadataUri);

    const subnameOwner = await registrar.ownerOf(label);
    if (subnameOwner === ethers.ZeroAddress) {
      await registrar.connect(deployer).mintSubname(label, agentOwner, agentId);
      subnameMinted++;
    }
  }

  return { registrarSet, subnameMinted };
}

async function deployAll() {
  const [owner, alice, bob] = await ethers.getSigners();

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();

  const NameWrapper = await ethers.getContractFactory("MockNameWrapper");
  const nameWrapper = await NameWrapper.deploy();

  const Resolver = await ethers.getContractFactory("MockResolver");
  const resolver = await Resolver.deploy();

  const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const registrar = await Registrar.deploy(
    PARENT,
    await nameWrapper.getAddress(),
    await resolver.getAddress()
  );

  // AgentRegistry deployed without registrar wired — matches the real Sepolia
  // scenario where agents predate the registrar.
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(
    await matchRegistry.getAddress(),
    ethers.ZeroHash
  );

  return { owner, alice, bob, matchRegistry, registrar, agentRegistry };
}

describe("seed_agent_subnames — backfill script logic", function () {
  describe("cleanLabel helper", function () {
    it("strips ipfs:// prefix", function () {
      expect(cleanLabel("ipfs://gnubg-default-placeholder")).to.equal(
        "gnubg-default-placeholder"
      );
    });

    it("strips arbitrary scheme prefix", function () {
      expect(cleanLabel("ar://some-label")).to.equal("some-label");
    });

    it("replaces slashes with hyphens", function () {
      expect(cleanLabel("ipfs://foo/bar/baz")).to.equal("foo-bar-baz");
    });

    it("returns the string unchanged when no scheme is present", function () {
      expect(cleanLabel("gnubg-tier1")).to.equal("gnubg-tier1");
    });
  });

  describe("setSubnameRegistrar step", function () {
    it("sets the registrar when it is not yet configured (zero address)", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.registrarSet).to.be.true;
      expect(await agentRegistry.subnameRegistrar()).to.equal(
        await registrar.getAddress()
      );
    });

    it("skips setSubnameRegistrar when the registrar is already wired", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry
        .connect(owner)
        .setSubnameRegistrar(await registrar.getAddress());
      await registrar
        .connect(owner)
        .setAuthorizedMinter(await agentRegistry.getAddress(), true);
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.registrarSet).to.be.false;
    });
  });

  describe("single pre-existing agent (no subname)", function () {
    it("mints the subname for the agent, owned by the agent's wallet", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-default-placeholder", 2);

      await runBackfill(agentRegistry, registrar, owner);

      const label = cleanLabel("ipfs://gnubg-default-placeholder");
      expect(await registrar.ownerOf(label)).to.equal(alice.address);
    });

    it("emits SubnameMinted with the correct inftId", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);

      const events = await registrar.queryFilter(registrar.filters.SubnameMinted());
      expect(events.length).to.equal(1);
      expect(events[0].args.label).to.equal("gnubg-tier1");
      expect(events[0].args.inftId).to.equal(1n);
    });

    it("reports 1 subname minted", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(1);
    });
  });

  describe("two pre-existing agents", function () {
    it("mints subnames for both agents", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      await runBackfill(agentRegistry, registrar, owner);

      expect(await registrar.ownerOf("gnubg-tier1")).to.equal(alice.address);
      expect(await registrar.ownerOf("gnubg-tier2")).to.equal(bob.address);
    });

    it("records correct inftId for each agent in SubnameMinted events", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      await runBackfill(agentRegistry, registrar, owner);

      const events = await registrar.queryFilter(registrar.filters.SubnameMinted());
      expect(events.length).to.equal(2);
      const inftIds = events.map((e) => Number(e.args.inftId)).sort();
      expect(inftIds).to.deep.equal([1, 2]);
    });

    it("reports 2 minted", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(2);
    });
  });

  describe("idempotency", function () {
    it("second run mints nothing", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);
      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.registrarSet).to.be.false;
      expect(result.subnameMinted).to.equal(0);
    });

    it("subname owner is unchanged on second run", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);
      const ownerAfterFirst = await registrar.ownerOf("gnubg-tier1");

      await runBackfill(agentRegistry, registrar, owner);
      expect(await registrar.ownerOf("gnubg-tier1")).to.equal(ownerAfterFirst);
    });
  });

  describe("no agents registered", function () {
    it("runs without error and mints nothing", async function () {
      const { owner, registrar, agentRegistry } = await deployAll();

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(0);
    });
  });

  describe("post-backfill: new agents are registered atomically", function () {
    it("mintAgent after wiring registers the subname immediately", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await runBackfill(agentRegistry, registrar, owner);

      await registrar
        .connect(owner)
        .setAuthorizedMinter(await agentRegistry.getAddress(), true);

      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      expect(await registrar.ownerOf("gnubg-tier2")).to.equal(bob.address);
    });
  });
});
