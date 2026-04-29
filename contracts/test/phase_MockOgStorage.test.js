// localhost dev mode — MockOgStorage unit tests.
//
// Written BEFORE the contract so they fail red first (TDD). Each case covers
// one behaviour slice: content-addressing, retrieval, event emission,
// existence flip, idempotency, distinct-content isolation, and error paths.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase — MockOgStorage", function () {
  let mock;

  beforeEach(async function () {
    const MockOgStorage = await ethers.getContractFactory("MockOgStorage");
    mock = await MockOgStorage.deploy();
  });

  it("put returns keccak256(data)", async function () {
    const data = ethers.toUtf8Bytes("hello chaingammon");
    const expected = ethers.keccak256(data);
    // staticCall makes the return value observable without consuming state.
    const actual = await mock.put.staticCall(data);
    expect(actual).to.equal(expected);
  });

  it("get returns the bytes that were put", async function () {
    const data = ethers.toUtf8Bytes("round trip data");
    await mock.put(data);
    const rootHash = ethers.keccak256(data);
    const returned = await mock.get(rootHash);
    expect(returned).to.equal(ethers.hexlify(data));
  });

  it("put emits Stored(rootHash, length)", async function () {
    const data = ethers.toUtf8Bytes("emit test payload");
    const rootHash = ethers.keccak256(data);
    await expect(mock.put(data))
      .to.emit(mock, "Stored")
      .withArgs(rootHash, data.length);
  });

  it("exists flips false to true after a put", async function () {
    const data = ethers.toUtf8Bytes("existence check");
    const rootHash = ethers.keccak256(data);
    expect(await mock.exists(rootHash)).to.equal(false);
    await mock.put(data);
    expect(await mock.exists(rootHash)).to.equal(true);
  });

  it("identical-content puts are idempotent", async function () {
    const data = ethers.toUtf8Bytes("idempotent content");
    const rootHash = ethers.keccak256(data);
    await mock.put(data);
    await expect(mock.put(data)).not.to.be.reverted;
    const returned = await mock.get(rootHash);
    expect(returned).to.equal(ethers.hexlify(data));
  });

  it("distinct content yields distinct hashes and bytes", async function () {
    const dataA = ethers.toUtf8Bytes("payload A");
    const dataB = ethers.toUtf8Bytes("payload B");
    await mock.put(dataA);
    await mock.put(dataB);
    const hashA = ethers.keccak256(dataA);
    const hashB = ethers.keccak256(dataB);
    expect(hashA).to.not.equal(hashB);
    expect(await mock.get(hashA)).to.equal(ethers.hexlify(dataA));
    expect(await mock.get(hashB)).to.equal(ethers.hexlify(dataB));
  });

  it("get reverts 'MockOgStorage: blob not found' for an unknown hash", async function () {
    const unknownHash = ethers.keccak256(ethers.toUtf8Bytes("never stored"));
    await expect(mock.get(unknownHash)).to.be.revertedWith(
      "MockOgStorage: blob not found",
    );
  });

  it("put('0x') reverts 'MockOgStorage: empty data'", async function () {
    await expect(mock.put("0x")).to.be.revertedWith("MockOgStorage: empty data");
  });
});
