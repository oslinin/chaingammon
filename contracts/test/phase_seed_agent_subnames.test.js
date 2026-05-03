// Tests for script/seed_agent_subnames.js
//
// The script cannot be unit-tested by importing it directly (it calls
// hardhat's ethers and process.exitCode). Instead we reproduce its exact
// logic against a local hardhat environment so every branch is exercised:
//
//   1. setSubnameRegistrar — skipped when already set, called when zero
//   2. mintSubname backfill — called when subname missing, skipped when present
//   3. setText("kind")    — called when missing/wrong, skipped when correct
//   4. setText("inft_id") — called when missing/wrong, skipped when correct
//   5. Multiple agents — each gets its own subname
//   6. cleanLabel helper — mirrors AgentCard.tsx + AgentRegistry._cleanLabel
//   7. Idempotency — running the whole backfill twice is a no-op on the second pass

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// Helpers — mirror the script's cleanLabel and the contract's _cleanLabel
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Simulate the backfill logic exactly as the script executes it.
// Returns counts of actions taken so tests can assert on side-effect counts.
// ---------------------------------------------------------------------------

async function runBackfill(agentRegistry, registrar, deployer) {
  let registrarSet = false;
  let subnameMinted = 0;
  let kindSet = 0;
  let inftIdSet = 0;

  // Step 1 — wire registrar if not already set
  const registrarAddr = await registrar.getAddress();
  const currentRegistrar = await agentRegistry.subnameRegistrar();
  if (currentRegistrar.toLowerCase() !== registrarAddr.toLowerCase()) {
    await agentRegistry.connect(deployer).setSubnameRegistrar(registrarAddr);
    registrarSet = true;
  }

  // Step 2 — backfill per-agent
  const agentCount = Number(await agentRegistry.agentCount());
  for (let agentId = 1; agentId <= agentCount; agentId++) {
    const metadataUri = await agentRegistry.agentMetadata(agentId);
    const agentOwner = await agentRegistry.ownerOf(agentId);
    const label = cleanLabel(metadataUri);
    const node = await registrar.subnameNode(label);

    // Mint subname if missing
    const subnameOwner = await registrar.ownerOf(node);
    if (subnameOwner === ethers.ZeroAddress) {
      await registrar.connect(deployer).mintSubname(label, agentOwner);
      subnameMinted++;
    }

    // Set kind if wrong/missing
    const existingKind = await registrar.text(node, "kind");
    if (existingKind !== "agent") {
      await registrar.connect(deployer).setText(node, "kind", "agent");
      kindSet++;
    }

    // Set inft_id if wrong/missing
    const existingInftId = await registrar.text(node, "inft_id");
    if (existingInftId !== String(agentId)) {
      await registrar.connect(deployer).setText(node, "inft_id", String(agentId));
      inftIdSet++;
    }
  }

  return { registrarSet, subnameMinted, kindSet, inftIdSet };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployAll() {
  const [owner, alice, bob] = await ethers.getSigners();

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();

  const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const registrar = await Registrar.deploy(PARENT);

  // Deploy AgentRegistry WITHOUT wiring the registrar — matches the real
  // Sepolia scenario where agents were minted before the registrar existed.
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(
    await matchRegistry.getAddress(),
    ethers.ZeroHash
  );

  return { owner, alice, bob, matchRegistry, registrar, agentRegistry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seed_agent_subnames — backfill script logic", function () {
  // -------------------------------------------------------------------------
  // cleanLabel helper
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // setSubnameRegistrar wiring
  // -------------------------------------------------------------------------
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

      // The backfill should not call setSubnameRegistrar again
      expect(result.registrarSet).to.be.false;
    });
  });

  // -------------------------------------------------------------------------
  // Single agent — normal backfill
  // -------------------------------------------------------------------------
  describe("single pre-existing agent (no subname)", function () {
    it("mints the subname for the agent", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-default-placeholder", 2);

      await runBackfill(agentRegistry, registrar, owner);

      const label = cleanLabel("ipfs://gnubg-default-placeholder");
      const node = await registrar.subnameNode(label);
      expect(await registrar.ownerOf(node)).to.equal(alice.address);
    });

    it("sets kind='agent' text record", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);

      const node = await registrar.subnameNode(cleanLabel("ipfs://gnubg-tier1"));
      expect(await registrar.text(node, "kind")).to.equal("agent");
    });

    it("sets inft_id='1' text record", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);

      const node = await registrar.subnameNode(cleanLabel("ipfs://gnubg-tier1"));
      expect(await registrar.text(node, "inft_id")).to.equal("1");
    });

    it("subnameCount increments to 1", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      expect(await registrar.subnameCount()).to.equal(0n);
      await runBackfill(agentRegistry, registrar, owner);
      expect(await registrar.subnameCount()).to.equal(1n);
    });

    it("subname is enumerable via subnameAt(0)", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);

      const node = await registrar.subnameNode(cleanLabel("ipfs://gnubg-tier1"));
      expect(await registrar.subnameAt(0)).to.equal(node);
    });

    it("reports 1 subname minted and 1 each of kind/inft_id set", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(1);
      expect(result.kindSet).to.equal(1);
      expect(result.inftIdSet).to.equal(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple agents
  // -------------------------------------------------------------------------
  describe("two pre-existing agents", function () {
    it("mints subnames for both agents", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      await runBackfill(agentRegistry, registrar, owner);

      const node1 = await registrar.subnameNode("gnubg-tier1");
      const node2 = await registrar.subnameNode("gnubg-tier2");
      expect(await registrar.ownerOf(node1)).to.equal(alice.address);
      expect(await registrar.ownerOf(node2)).to.equal(bob.address);
    });

    it("sets correct inft_id for each agent (1 and 2)", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      await runBackfill(agentRegistry, registrar, owner);

      const node1 = await registrar.subnameNode("gnubg-tier1");
      const node2 = await registrar.subnameNode("gnubg-tier2");
      expect(await registrar.text(node1, "inft_id")).to.equal("1");
      expect(await registrar.text(node2, "inft_id")).to.equal("2");
    });

    it("subnameCount is 2 after backfill", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      await runBackfill(agentRegistry, registrar, owner);

      expect(await registrar.subnameCount()).to.equal(2n);
    });

    it("reports 2 minted and 2 kind/inft_id sets", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(2);
      expect(result.kindSet).to.equal(2);
      expect(result.inftIdSet).to.equal(2);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — running the backfill a second time is a no-op
  // -------------------------------------------------------------------------
  describe("idempotency", function () {
    it("second run mints nothing and sets no records", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      // First run
      await runBackfill(agentRegistry, registrar, owner);
      // Second run
      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.registrarSet).to.be.false;
      expect(result.subnameMinted).to.equal(0);
      expect(result.kindSet).to.equal(0);
      expect(result.inftIdSet).to.equal(0);
    });

    it("subnameCount stays the same on second run", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);
      const countAfterFirst = await registrar.subnameCount();

      await runBackfill(agentRegistry, registrar, owner);
      const countAfterSecond = await registrar.subnameCount();

      expect(countAfterSecond).to.equal(countAfterFirst);
    });

    it("text records are unchanged on second run", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      await runBackfill(agentRegistry, registrar, owner);
      const node = await registrar.subnameNode("gnubg-tier1");
      const kindAfterFirst = await registrar.text(node, "kind");
      const inftIdAfterFirst = await registrar.text(node, "inft_id");

      await runBackfill(agentRegistry, registrar, owner);
      expect(await registrar.text(node, "kind")).to.equal(kindAfterFirst);
      expect(await registrar.text(node, "inft_id")).to.equal(inftIdAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // Partial state — subname exists but text records are missing
  // (e.g. someone called mintSubname manually but didn't set records)
  // -------------------------------------------------------------------------
  describe("partial state — subname present but records missing", function () {
    it("sets kind and inft_id without re-minting the subname", async function () {
      const { owner, alice, registrar, agentRegistry } = await deployAll();
      await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://gnubg-tier1", 1);

      // Manually mint the subname but don't set text records
      await registrar.connect(owner).mintSubname("gnubg-tier1", alice.address);

      const result = await runBackfill(agentRegistry, registrar, owner);

      // No new mint, but text records should be set
      expect(result.subnameMinted).to.equal(0);
      expect(result.kindSet).to.equal(1);
      expect(result.inftIdSet).to.equal(1);

      const node = await registrar.subnameNode("gnubg-tier1");
      expect(await registrar.text(node, "kind")).to.equal("agent");
      expect(await registrar.text(node, "inft_id")).to.equal("1");
    });
  });

  // -------------------------------------------------------------------------
  // No agents — backfill on a fresh registry is a no-op
  // -------------------------------------------------------------------------
  describe("no agents registered", function () {
    it("runs without error and mints nothing", async function () {
      const { owner, registrar, agentRegistry } = await deployAll();

      const result = await runBackfill(agentRegistry, registrar, owner);

      expect(result.subnameMinted).to.equal(0);
      expect(result.kindSet).to.equal(0);
      expect(result.inftIdSet).to.equal(0);
      expect(await registrar.subnameCount()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Future atomic mints — after backfill, new mintAgent calls are atomic
  // -------------------------------------------------------------------------
  describe("post-backfill: new agents are registered atomically", function () {
    it("mintAgent after wiring registers the subname immediately", async function () {
      const { owner, alice, bob, registrar, agentRegistry } = await deployAll();
      // Backfill wires the registrar
      await runBackfill(agentRegistry, registrar, owner);

      // Authorize AgentRegistry to mint on the registrar
      await registrar
        .connect(owner)
        .setAuthorizedMinter(await agentRegistry.getAddress(), true);

      // New agent minted after the wire-up
      await agentRegistry.connect(owner).mintAgent(bob.address, "ipfs://gnubg-tier2", 2);

      const node = await registrar.subnameNode("gnubg-tier2");
      expect(await registrar.ownerOf(node)).to.equal(bob.address);
      expect(await registrar.text(node, "kind")).to.equal("agent");
      expect(await registrar.text(node, "inft_id")).to.equal("1");
    });
  });
});
