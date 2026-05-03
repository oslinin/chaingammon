const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const ZERO_ADDR = ethers.ZeroAddress;

// ENS namehash for "chaingammon.eth" — computed off-chain so the contract
// can pin the parent node as an immutable on construction.
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

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

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

  return { owner, alice, bob, nameWrapper, resolver, registrar };
}

describe("Phase 10 — PlayerSubnameRegistrar (NameWrapper-backed)", function () {
  describe("constructor", function () {
    it("pins the parent node, NameWrapper, and resolver", async function () {
      const { registrar, nameWrapper, resolver } = await deployFixture();
      expect(await registrar.parentNode()).to.equal(PARENT);
      expect(await registrar.nameWrapper()).to.equal(await nameWrapper.getAddress());
      expect(await registrar.resolver()).to.equal(await resolver.getAddress());
    });

    it("sets the deployer as owner", async function () {
      const { registrar, owner } = await deployFixture();
      expect(await registrar.owner()).to.equal(owner.address);
    });
  });

  describe("namehash helper", function () {
    it("computes ENS-style namehash for a subname under the parent", async function () {
      const { registrar } = await deployFixture();
      const expected = namehash("alice.chaingammon.eth");
      expect(await registrar.subnameNode("alice")).to.equal(expected);
    });

    it("different labels produce different nodes", async function () {
      const { registrar } = await deployFixture();
      const a = await registrar.subnameNode("alice");
      const b = await registrar.subnameNode("bob");
      expect(a).to.not.equal(b);
    });
  });

  describe("mintSubname", function () {
    it("records the subname owner in NameWrapper", async function () {
      const { registrar, alice } = await deployFixture();
      await registrar.mintSubname("alice", alice.address, 0);
      expect(await registrar.ownerOf("alice")).to.equal(alice.address);
    });

    it("emits SubnameMinted with label, node, owner, and inftId", async function () {
      const { registrar, alice } = await deployFixture();
      const tx = await registrar.mintSubname("alice", alice.address, 7);
      const receipt = await tx.wait();
      const evt = receipt.logs
        .map((l) => {
          try { return registrar.interface.parseLog(l); } catch { return null; }
        })
        .find((p) => p?.name === "SubnameMinted");
      expect(evt).to.not.be.null;
      expect(evt.args.label).to.equal("alice");
      expect(evt.args.subnameOwner).to.equal(alice.address);
      expect(evt.args.node).to.equal(await registrar.subnameNode("alice"));
      expect(evt.args.inftId).to.equal(7n);
    });

    it("only owner or authorized minter can mint", async function () {
      const { registrar, alice } = await deployFixture();
      let reverted = false;
      try {
        await registrar.connect(alice).mintSubname("alice", alice.address, 0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("rejects empty labels", async function () {
      const { registrar, alice } = await deployFixture();
      let reverted = false;
      try {
        await registrar.mintSubname("", alice.address, 0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("rejects mint to zero address", async function () {
      const { registrar } = await deployFixture();
      let reverted = false;
      try {
        await registrar.mintSubname("alice", ZERO_ADDR, 0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  describe("ownerOf", function () {
    it("returns zero address for an un-minted label", async function () {
      const { registrar } = await deployFixture();
      expect(await registrar.ownerOf("ghost")).to.equal(ZERO_ADDR);
    });

    it("returns the subname owner after mint", async function () {
      const { registrar, alice } = await deployFixture();
      await registrar.mintSubname("alice", alice.address, 0);
      expect(await registrar.ownerOf("alice")).to.equal(alice.address);
    });
  });
});
