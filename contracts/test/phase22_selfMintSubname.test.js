// Phase 22: selfMintSubname — open self-registration added to
// PlayerSubnameRegistrar. Any wallet can claim a subname for its own
// address without the contract owner's signature.

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

describe("Phase 22 — selfMintSubname", function () {
  let registrar;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const Registrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
    registrar = await Registrar.deploy(PARENT);
  });

  it("any wallet can claim a subname for itself", async function () {
    await registrar.connect(alice).selfMintSubname("alice");
    const node = await registrar.subnameNode("alice");
    expect(await registrar.ownerOf(node)).to.equal(alice.address);
  });

  it("emits SubnameMinted with the caller as subnameOwner", async function () {
    const tx = await registrar.connect(alice).selfMintSubname("alice");
    const receipt = await tx.wait();
    const evt = receipt.logs.find((l) => l.fragment?.name === "SubnameMinted");
    expect(evt).to.not.be.undefined;
    expect(evt.args.label).to.equal("alice");
    expect(evt.args.subnameOwner).to.equal(alice.address);
    expect(evt.args.node).to.equal(await registrar.subnameNode("alice"));
  });

  it("increments subnameCount", async function () {
    expect(await registrar.subnameCount()).to.equal(0n);
    await registrar.connect(alice).selfMintSubname("alice");
    expect(await registrar.subnameCount()).to.equal(1n);
    await registrar.connect(bob).selfMintSubname("bob");
    expect(await registrar.subnameCount()).to.equal(2n);
  });

  it("rejects duplicate label (collision with selfMintSubname)", async function () {
    await registrar.connect(alice).selfMintSubname("alice");
    let reverted = false;
    try {
      await registrar.connect(bob).selfMintSubname("alice");
    } catch (e) {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("rejects duplicate label (collision with mintSubname)", async function () {
    await registrar.mintSubname("alice", alice.address);
    let reverted = false;
    try {
      await registrar.connect(bob).selfMintSubname("alice");
    } catch (e) {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("rejects empty label", async function () {
    let reverted = false;
    try {
      await registrar.connect(alice).selfMintSubname("");
    } catch (e) {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("subname owner can update their own text record after self-mint", async function () {
    // "elo" is a reserved key (protocol-only) after Phase 31 — use "bio" here
    await registrar.connect(alice).selfMintSubname("alice");
    const node = await registrar.subnameNode("alice");
    await registrar.connect(alice).setText(node, "bio", "my profile");
    expect(await registrar.text(node, "bio")).to.equal("my profile");
  });

  it("alice and bob can each claim their own subname independently", async function () {
    await registrar.connect(alice).selfMintSubname("alice");
    await registrar.connect(bob).selfMintSubname("bob");
    expect(await registrar.ownerOf(await registrar.subnameNode("alice"))).to.equal(alice.address);
    expect(await registrar.ownerOf(await registrar.subnameNode("bob"))).to.equal(bob.address);
    expect(await registrar.subnameCount()).to.equal(2n);
  });
});
