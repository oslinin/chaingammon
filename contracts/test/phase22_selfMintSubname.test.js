// Phase 22: selfMintSubname — open self-registration on
// PlayerSubnameRegistrar. Any wallet can claim a subname for itself
// without the contract owner's signature.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO_HASH = ethers.ZeroHash;

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

  return { owner, alice, bob, registrar };
}

describe("Phase 22 — selfMintSubname", function () {
  it("any wallet can claim a subname for itself", async function () {
    const { registrar, alice } = await deployFixture();
    await registrar.connect(alice).selfMintSubname("alice");
    expect(await registrar.ownerOf("alice")).to.equal(alice.address);
  });

  it("emits SubnameMinted with the caller as subnameOwner", async function () {
    const { registrar, alice } = await deployFixture();
    const tx = await registrar.connect(alice).selfMintSubname("alice");
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
    expect(evt.args.inftId).to.equal(0n);
  });

  it("rejects empty label", async function () {
    const { registrar, alice } = await deployFixture();
    let reverted = false;
    try {
      await registrar.connect(alice).selfMintSubname("");
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("alice and bob can each claim their own subname independently", async function () {
    const { registrar, alice, bob } = await deployFixture();
    await registrar.connect(alice).selfMintSubname("alice");
    await registrar.connect(bob).selfMintSubname("bob");
    expect(await registrar.ownerOf("alice")).to.equal(alice.address);
    expect(await registrar.ownerOf("bob")).to.equal(bob.address);
  });
});
