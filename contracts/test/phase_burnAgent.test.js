// Tests for AgentRegistry.burnAgent and the supporting pieces:
//
//   - PlayerSubnameRegistrar.revokeSubname (standalone, NameWrapper-backed)
//   - AgentRegistry active-agent index (activeAgentCount / activeAgentAt)
//   - AgentRegistry.burnAgent core behaviour:
//       · ERC-721 token gone
//       · metadata + data cleared
//       · active-agent index updated (swap-and-pop)
//       · ENS subname revoked atomically when registrar is wired
//       · guard: non-existent agent reverts
//       · guard: non-owner reverts
//       · guard: double-burn reverts
//   - Multi-agent index compaction (burn middle / burn first / burn last)
//   - Burn without registrar wired (no revert)
//   - Burn of agent minted before registrar was wired (subname missing — no revert)

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const ZERO_ADDR = ethers.ZeroAddress;

function namehash(name) {
  let node = ZERO_HASH;
  for (const label of name.split(".").reverse()) {
    node = ethers.keccak256(
      ethers.concat([node, ethers.keccak256(ethers.toUtf8Bytes(label))])
    );
  }
  return node;
}

const PARENT = namehash("chaingammon.eth");

function cleanLabel(uri) {
  return uri.replace(/^[^:]+:\/\//, "").replaceAll("/", "-");
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

async function deployAll() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

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

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(
    await matchRegistry.getAddress(),
    ZERO_HASH
  );

  // Wire AgentRegistry ↔ PlayerSubnameRegistrar for atomic mint/burn.
  await agentRegistry.connect(owner).setSubnameRegistrar(await registrar.getAddress());
  await registrar.connect(owner).setAuthorizedMinter(await agentRegistry.getAddress(), true);

  return { owner, alice, bob, carol, matchRegistry, registrar, agentRegistry, nameWrapper, resolver };
}

// ---------------------------------------------------------------------------
// PlayerSubnameRegistrar.revokeSubname — standalone
// ---------------------------------------------------------------------------

describe("PlayerSubnameRegistrar — revokeSubname", function () {
  async function freshRegistrar() {
    const [owner, alice] = await ethers.getSigners();
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
    return { owner, alice, registrar };
  }

  it("owner can revoke an existing subname", async function () {
    const { owner, alice, registrar } = await freshRegistrar();
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    expect(await registrar.ownerOf("alice")).to.equal(alice.address);
    await registrar.connect(owner).revokeSubname("alice");
    expect(await registrar.ownerOf("alice")).to.equal(ZERO_ADDR);
  });

  it("non-owner cannot revoke", async function () {
    const { owner, alice, registrar } = await freshRegistrar();
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    await expect(
      registrar.connect(alice).revokeSubname("alice")
    ).to.be.revertedWithCustomError(registrar, "NotAuthorized");
  });

  it("authorized minter can revoke", async function () {
    const { owner, alice, registrar } = await freshRegistrar();
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    await registrar.connect(owner).setAuthorizedMinter(alice.address, true);
    await registrar.connect(alice).revokeSubname("alice");
    expect(await registrar.ownerOf("alice")).to.equal(ZERO_ADDR);
  });

  it("emits SubnameRevoked event", async function () {
    const { owner, alice, registrar } = await freshRegistrar();
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    const node = await registrar.subnameNode("alice");
    await expect(registrar.connect(owner).revokeSubname("alice"))
      .to.emit(registrar, "SubnameRevoked")
      .withArgs("alice", node);
  });

  it("after revoke the label can be re-minted", async function () {
    const { owner, alice, registrar } = await freshRegistrar();
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    await registrar.connect(owner).revokeSubname("alice");
    await registrar.connect(owner).mintSubname("alice", alice.address, 0);
    expect(await registrar.ownerOf("alice")).to.equal(alice.address);
  });
});

// ---------------------------------------------------------------------------
// AgentRegistry active-agent index
// ---------------------------------------------------------------------------

describe("AgentRegistry — active-agent index", function () {
  it("activeAgentCount starts at 0", async function () {
    const { agentRegistry } = await deployAll();
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });

  it("activeAgentCount increments on each mint", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    expect(await agentRegistry.activeAgentCount()).to.equal(1n);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    expect(await agentRegistry.activeAgentCount()).to.equal(2n);
  });

  it("activeAgentAt returns correct agentId", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier2", 2);
    expect(await agentRegistry.activeAgentAt(0)).to.equal(1n);
    expect(await agentRegistry.activeAgentAt(1)).to.equal(2n);
  });

  it("activeAgentAt reverts when index out of range", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await expect(agentRegistry.activeAgentAt(1)).to.be.reverted;
  });
});

// ---------------------------------------------------------------------------
// AgentRegistry.burnAgent — core behaviour
// ---------------------------------------------------------------------------

describe("AgentRegistry.burnAgent — core", function () {
  it("burns the ERC-721 token (ownerOf reverts after burn)", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    await expect(agentRegistry.ownerOf(1)).to.be.reverted;
  });

  it("clears agentMetadata after burn", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.agentMetadata(1)).to.equal("");
  });

  it("clears tier after burn", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 2);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.tier(1)).to.equal(0n);
  });

  it("agentCount is unchanged after burn (total-ever counter)", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.agentCount()).to.equal(1n);
  });

  it("activeAgentCount decrements after burn", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    expect(await agentRegistry.activeAgentCount()).to.equal(1n);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });

  it("emits AgentBurned event", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await expect(agentRegistry.connect(owner).burnAgent(1))
      .to.emit(agentRegistry, "AgentBurned")
      .withArgs(1n);
  });

  it("reverts when burning a non-existent agent", async function () {
    const { owner, agentRegistry } = await deployAll();
    await expect(agentRegistry.connect(owner).burnAgent(99)).to.be.reverted;
  });

  it("reverts on double-burn", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    await expect(agentRegistry.connect(owner).burnAgent(1)).to.be.reverted;
  });

  it("non-owner cannot burn", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await expect(agentRegistry.connect(alice).burnAgent(1)).to.be.reverted;
  });
});

// ---------------------------------------------------------------------------
// AgentRegistry.burnAgent — ENS subname revocation
// ---------------------------------------------------------------------------

describe("AgentRegistry.burnAgent — ENS subname", function () {
  it("revokes the ENS subname atomically", async function () {
    const { owner, alice, registrar, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    expect(await registrar.ownerOf("tier1")).to.equal(alice.address);

    await agentRegistry.connect(owner).burnAgent(1);
    expect(await registrar.ownerOf("tier1")).to.equal(ZERO_ADDR);
  });
});

// ---------------------------------------------------------------------------
// AgentRegistry.burnAgent — without registrar wired
// ---------------------------------------------------------------------------

describe("AgentRegistry.burnAgent — no registrar", function () {
  it("burns cleanly when no registrar is configured", async function () {
    const [owner, alice] = await ethers.getSigners();
    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    const matchRegistry = await MatchRegistry.deploy();
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const agentRegistry = await AgentRegistry.deploy(
      await matchRegistry.getAddress(),
      ZERO_HASH
    );
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// AgentRegistry.burnAgent — agent minted before registrar was wired
// (the real Sepolia scenario: subname may not exist in the registrar)
// ---------------------------------------------------------------------------

describe("AgentRegistry.burnAgent — agent has no subname (pre-wire mint)", function () {
  it("burns without reverting when subname was never minted", async function () {
    const [owner, alice] = await ethers.getSigners();
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
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const agentRegistry = await AgentRegistry.deploy(
      await matchRegistry.getAddress(),
      ZERO_HASH
    );

    // Mint agent BEFORE wiring the registrar — no subname is created
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://tier1", 1);

    // Now wire it up
    await agentRegistry.connect(owner).setSubnameRegistrar(await registrar.getAddress());
    await registrar.connect(owner).setAuthorizedMinter(await agentRegistry.getAddress(), true);

    // Burn should not revert even though the subname never existed
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// Active-agent index compaction — swap-and-pop correctness
// ---------------------------------------------------------------------------

describe("AgentRegistry active-agent index compaction", function () {
  it("burning the only agent leaves an empty index", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });

  it("burning the last agent shrinks the array correctly", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    await agentRegistry.connect(owner).burnAgent(2); // burn last
    expect(await agentRegistry.activeAgentCount()).to.equal(1n);
    expect(await agentRegistry.activeAgentAt(0)).to.equal(1n);
  });

  it("burning the first agent moves the last into its slot", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://c", 1);
    await agentRegistry.connect(owner).burnAgent(1); // burn first
    const ids = [
      Number(await agentRegistry.activeAgentAt(0)),
      Number(await agentRegistry.activeAgentAt(1)),
    ];
    expect(ids.sort()).to.deep.equal([2, 3]);
    expect(await agentRegistry.activeAgentCount()).to.equal(2n);
  });

  it("burning the middle agent compacts correctly", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://c", 1);
    await agentRegistry.connect(owner).burnAgent(2); // burn middle
    const ids = [
      Number(await agentRegistry.activeAgentAt(0)),
      Number(await agentRegistry.activeAgentAt(1)),
    ];
    expect(ids.sort()).to.deep.equal([1, 3]);
    expect(await agentRegistry.activeAgentCount()).to.equal(2n);
  });

  it("can burn all agents one by one without errors", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://c", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    await agentRegistry.connect(owner).burnAgent(2);
    await agentRegistry.connect(owner).burnAgent(3);
    expect(await agentRegistry.activeAgentCount()).to.equal(0n);
  });

  it("minting after burns assigns new ids correctly and index stays consistent", async function () {
    const { owner, alice, agentRegistry } = await deployAll();
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://a", 1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://b", 1);
    await agentRegistry.connect(owner).burnAgent(1);
    await agentRegistry.connect(owner).mintAgent(alice.address, "ipfs://c", 1);
    const ids = [
      Number(await agentRegistry.activeAgentAt(0)),
      Number(await agentRegistry.activeAgentAt(1)),
    ];
    expect(ids.sort()).to.deep.equal([2, 3]);
    expect(await agentRegistry.activeAgentCount()).to.equal(2n);
  });
});
