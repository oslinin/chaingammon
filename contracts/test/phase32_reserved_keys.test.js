// Phase 31: reserved keys + authorized minters + enumerable index on
// PlayerSubnameRegistrar.
//
// Tests go red against the current contract (none of these features exist yet).
// They go green once the Phase 31 contract changes land.

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

describe("Phase 31 — reserved keys, authorized minters, enumerable index", function () {
  let registrar;
  let owner, alice, bob, minter;

  beforeEach(async function () {
    [owner, alice, bob, minter] = await ethers.getSigners();
    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT);
    // mint alice's subname as owner (reserved-keys tests need an existing subname)
    await registrar.mintSubname("alice", alice.address);
  });

  // -------------------------------------------------------------------------
  // Reserved-key enforcement
  // -------------------------------------------------------------------------

  describe("reserved keys — subname owner CANNOT write", function () {
    let aliceNode;

    beforeEach(async function () {
      aliceNode = await registrar.subnameNode("alice");
    });

    for (const key of ["elo", "match_count", "last_match_id", "kind", "inft_id"]) {
      it(`subname owner cannot setText("${key}", ...)`, async function () {
        let reverted = false;
        try {
          await registrar.connect(alice).setText(aliceNode, key, "some-value");
        } catch (e) {
          reverted = true;
        }
        expect(reverted, `setText("${key}") should have reverted for subname owner`).to.be.true;
      });
    }
  });

  describe("reserved keys — contract owner CAN write", function () {
    let aliceNode;

    beforeEach(async function () {
      aliceNode = await registrar.subnameNode("alice");
    });

    for (const [key, val] of [
      ["elo", "1600"],
      ["match_count", "5"],
      ["last_match_id", "42"],
      ["kind", "human"],
      ["inft_id", ""],
    ]) {
      it(`contract owner can setText("${key}", ...)`, async function () {
        await registrar.connect(owner).setText(aliceNode, key, val);
        expect(await registrar.text(aliceNode, key)).to.equal(val);
      });
    }
  });

  describe("user-writable keys — subname owner CAN write", function () {
    let aliceNode;

    beforeEach(async function () {
      aliceNode = await registrar.subnameNode("alice");
    });

    for (const [key, val] of [
      ["bio", "Hello backgammon world"],
      ["avatar", "https://example.com/avatar.png"],
      ["style_uri", "0g://abc123"],
      ["endpoint", "http://localhost:8001"],
    ]) {
      it(`subname owner can setText("${key}", ...)`, async function () {
        await registrar.connect(alice).setText(aliceNode, key, val);
        expect(await registrar.text(aliceNode, key)).to.equal(val);
      });
    }

    it("contract owner can also write non-reserved keys", async function () {
      await registrar.connect(owner).setText(aliceNode, "bio", "written by owner");
      expect(await registrar.text(aliceNode, "bio")).to.equal("written by owner");
    });

    it("stranger cannot write any key (reserved or not)", async function () {
      let reverted = false;
      try {
        await registrar.connect(bob).setText(aliceNode, "bio", "hacked");
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // setAuthorizedMinter
  // -------------------------------------------------------------------------

  describe("setAuthorizedMinter", function () {
    it("owner can grant a minter", async function () {
      await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
      // no revert = pass
    });

    it("non-owner cannot grant a minter", async function () {
      let reverted = false;
      try {
        await registrar.connect(alice).setAuthorizedMinter(minter.address, true);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("granted minter can call mintSubname", async function () {
      await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
      await registrar.connect(minter).mintSubname("bob", bob.address);
      const node = await registrar.subnameNode("bob");
      expect(await registrar.ownerOf(node)).to.equal(bob.address);
    });

    it("unauthorized address cannot call mintSubname", async function () {
      let reverted = false;
      try {
        await registrar.connect(alice).mintSubname("charlie", alice.address);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("revoked minter cannot call mintSubname", async function () {
      await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
      await registrar.connect(owner).setAuthorizedMinter(minter.address, false);
      let reverted = false;
      try {
        await registrar.connect(minter).mintSubname("bob", bob.address);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("granted minter cannot grant another minter", async function () {
      await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
      let reverted = false;
      try {
        await registrar.connect(minter).setAuthorizedMinter(alice.address, true);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // subnameAt — enumerable index
  // -------------------------------------------------------------------------

  describe("subnameAt — enumerable index", function () {
    it("subnameAt(0) returns the first minted node", async function () {
      // alice was minted in beforeEach at index 0
      const aliceNode = await registrar.subnameNode("alice");
      expect(await registrar.subnameAt(0)).to.equal(aliceNode);
    });

    it("subnameAt(count-1) returns the last minted node", async function () {
      await registrar.mintSubname("bob", bob.address);
      const bobNode = await registrar.subnameNode("bob");
      const count = Number(await registrar.subnameCount());
      expect(await registrar.subnameAt(count - 1)).to.equal(bobNode);
    });

    it("subnameAt(out-of-range) reverts", async function () {
      let reverted = false;
      try {
        await registrar.subnameAt(99);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("insertion order is preserved across multiple mints", async function () {
      await registrar.mintSubname("bob", bob.address);
      await registrar.mintSubname("charlie", minter.address);
      const aliceNode = await registrar.subnameNode("alice");
      const bobNode = await registrar.subnameNode("bob");
      const charlieNode = await registrar.subnameNode("charlie");
      expect(await registrar.subnameAt(0)).to.equal(aliceNode);
      expect(await registrar.subnameAt(1)).to.equal(bobNode);
      expect(await registrar.subnameAt(2)).to.equal(charlieNode);
    });

    it("node minted by authorized minter appears in the index", async function () {
      await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
      await registrar.connect(minter).mintSubname("bob", bob.address);
      const bobNode = await registrar.subnameNode("bob");
      expect(await registrar.subnameAt(1)).to.equal(bobNode);
    });

    it("node minted via selfMintSubname appears in the index", async function () {
      await registrar.connect(bob).selfMintSubname("bob");
      const bobNode = await registrar.subnameNode("bob");
      expect(await registrar.subnameAt(1)).to.equal(bobNode);
    });
  });
});
