const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;
const ZERO_ADDR = ethers.ZeroAddress;

// ENS namehash for "chaingammon.eth" — computed off-chain so the contract
// can pin the parent node as an immutable on construction.
//   namehash("eth") = keccak256(0x00...0 || keccak256("eth"))
//   namehash("chaingammon.eth") = keccak256(namehash("eth") || keccak256("chaingammon"))
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

describe("Phase 10 — PlayerSubnameRegistrar", function () {
  let registrar;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT);
  });

  describe("constructor", function () {
    it("pins the parent node", async function () {
      expect(await registrar.parentNode()).to.equal(PARENT);
    });

    it("sets the deployer as owner", async function () {
      expect(await registrar.owner()).to.equal(owner.address);
    });
  });

  describe("namehash helper", function () {
    it("computes ENS-style namehash for a subname under the parent", async function () {
      const expected = namehash("alice.chaingammon.eth");
      expect(await registrar.subnameNode("alice")).to.equal(expected);
    });

    it("different labels produce different nodes", async function () {
      const a = await registrar.subnameNode("alice");
      const b = await registrar.subnameNode("bob");
      expect(a).to.not.equal(b);
    });
  });

  describe("mintSubname", function () {
    it("records the subname owner", async function () {
      await registrar.mintSubname("alice", alice.address);
      const node = await registrar.subnameNode("alice");
      expect(await registrar.ownerOf(node)).to.equal(alice.address);
    });

    it("emits SubnameMinted with the label and node", async function () {
      const tx = await registrar.mintSubname("alice", alice.address);
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "SubnameMinted");
      expect(evt).to.not.be.undefined;
      expect(evt.args.label).to.equal("alice");
      expect(evt.args.subnameOwner).to.equal(alice.address);
      expect(evt.args.node).to.equal(await registrar.subnameNode("alice"));
    });

    it("rejects duplicate labels", async function () {
      await registrar.mintSubname("alice", alice.address);
      let reverted = false;
      try {
        await registrar.mintSubname("alice", bob.address);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("only owner can mint", async function () {
      let reverted = false;
      try {
        await registrar.connect(alice).mintSubname("alice", alice.address);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("rejects empty labels", async function () {
      let reverted = false;
      try {
        await registrar.mintSubname("", alice.address);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("rejects mint to zero address", async function () {
      let reverted = false;
      try {
        await registrar.mintSubname("alice", ZERO_ADDR);
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("auto-increments subnameCount", async function () {
      expect(await registrar.subnameCount()).to.equal(0n);
      await registrar.mintSubname("alice", alice.address);
      expect(await registrar.subnameCount()).to.equal(1n);
      await registrar.mintSubname("bob", bob.address);
      expect(await registrar.subnameCount()).to.equal(2n);
    });
  });

  describe("text records", function () {
    let aliceNode;

    beforeEach(async function () {
      await registrar.mintSubname("alice", alice.address);
      aliceNode = await registrar.subnameNode("alice");
    });

    it("text() returns empty string for unset key", async function () {
      expect(await registrar.text(aliceNode, "elo")).to.equal("");
    });

    it("setText stores and text() returns the value", async function () {
      await registrar.setText(aliceNode, "elo", "1547");
      expect(await registrar.text(aliceNode, "elo")).to.equal("1547");
    });

    it("setText emits TextRecordSet", async function () {
      const tx = await registrar.setText(aliceNode, "elo", "1547");
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "TextRecordSet");
      expect(evt).to.not.be.undefined;
      expect(evt.args.node).to.equal(aliceNode);
      expect(evt.args.key).to.equal("elo");
      expect(evt.args.value).to.equal("1547");
    });

    it("subname owner can update their own text record", async function () {
      // "elo" is a reserved key (protocol-only) after Phase 31 — use "bio" here
      await registrar.connect(alice).setText(aliceNode, "bio", "hello world");
      expect(await registrar.text(aliceNode, "bio")).to.equal("hello world");
    });

    it("contract owner can update any text record", async function () {
      // owner is the deployer (server). Server needs to push ELO updates
      // after every match.
      await registrar.connect(owner).setText(aliceNode, "elo", "1612");
      expect(await registrar.text(aliceNode, "elo")).to.equal("1612");
    });

    it("strangers cannot update text records", async function () {
      let reverted = false;
      try {
        await registrar.connect(bob).setText(aliceNode, "elo", "9999");
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("setText reverts for non-existent subname", async function () {
      const fake = namehash("nonexistent.chaingammon.eth");
      let reverted = false;
      try {
        await registrar.connect(owner).setText(fake, "elo", "1500");
      } catch (e) {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("multiple keys per subname coexist", async function () {
      await registrar.setText(aliceNode, "elo", "1547");
      await registrar.setText(aliceNode, "match_count", "12");
      await registrar.setText(aliceNode, "archive_uri", "0g://abc...");
      expect(await registrar.text(aliceNode, "elo")).to.equal("1547");
      expect(await registrar.text(aliceNode, "match_count")).to.equal("12");
      expect(await registrar.text(aliceNode, "archive_uri")).to.equal("0g://abc...");
    });

    it("overwriting a text record replaces the old value", async function () {
      await registrar.setText(aliceNode, "elo", "1500");
      await registrar.setText(aliceNode, "elo", "1547");
      expect(await registrar.text(aliceNode, "elo")).to.equal("1547");
    });
  });

  describe("ownerOf for non-existent subname returns zero address", function () {
    it("zero address signals no such subname", async function () {
      const fake = namehash("ghost.chaingammon.eth");
      expect(await registrar.ownerOf(fake)).to.equal(ZERO_ADDR);
    });
  });
});
