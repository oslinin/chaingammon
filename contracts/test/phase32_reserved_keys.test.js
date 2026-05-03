// Phase 31: authorized minters on PlayerSubnameRegistrar.
//
// (Reserved keys + enumerable index were removed when the registrar was
// migrated to delegate to ENS NameWrapper / Resolver — text records now
// live on the resolver and ownership lives in NameWrapper, so the registrar
// no longer carries internal storage to enforce reserved-key writes or
// to enumerate. The authorized-minter ACL remains relevant for both
// mintSubname and revokeSubname.)

const { expect } = require("chai");
const { ethers } = require("hardhat");

function namehash(name) {
  let node = ethers.ZeroHash;
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
  const [owner, alice, bob, minter] = await ethers.getSigners();

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

  return { owner, alice, bob, minter, registrar };
}

describe("Phase 31 — authorized minters", function () {
  it("owner can grant a minter", async function () {
    const { registrar, owner, minter } = await deployFixture();
    await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
    expect(await registrar.isAuthorizedMinter(minter.address)).to.be.true;
  });

  it("non-owner cannot grant a minter", async function () {
    const { registrar, alice, minter } = await deployFixture();
    let reverted = false;
    try {
      await registrar.connect(alice).setAuthorizedMinter(minter.address, true);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("granted minter can call mintSubname", async function () {
    const { registrar, owner, minter, bob } = await deployFixture();
    await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
    await registrar.connect(minter).mintSubname("bob", bob.address, 0);
    expect(await registrar.ownerOf("bob")).to.equal(bob.address);
  });

  it("unauthorized address cannot call mintSubname", async function () {
    const { registrar, alice } = await deployFixture();
    let reverted = false;
    try {
      await registrar.connect(alice).mintSubname("charlie", alice.address, 0);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("revoked minter cannot call mintSubname", async function () {
    const { registrar, owner, minter, bob } = await deployFixture();
    await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
    await registrar.connect(owner).setAuthorizedMinter(minter.address, false);
    let reverted = false;
    try {
      await registrar.connect(minter).mintSubname("bob", bob.address, 0);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("granted minter cannot grant another minter", async function () {
    const { registrar, owner, alice, minter } = await deployFixture();
    await registrar.connect(owner).setAuthorizedMinter(minter.address, true);
    let reverted = false;
    try {
      await registrar.connect(minter).setAuthorizedMinter(alice.address, true);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });
});
