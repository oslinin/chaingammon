// Tests for MatchRegistry.settleWithSessionKeys — trustless session-key settlement.
//
// Design under test:
//   At game start the human wallet signs a "Chaingammon:open" message that
//   authorises an ephemeral session key for one specific match (agentId +
//   matchLength + nonce). At game end the session key signs the result. Either
//   side (or a relayer) submits both signatures; the contract verifies them and
//   records the match without any owner key in the path.
//
//   See MatchRegistry.sol's settleWithSessionKeys natspec for the full message
//   format.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

/**
 * Build and sign the "Chaingammon:open" authorisation message.
 *
 * @param {Wallet} signer      Human wallet — signs the open message.
 * @param {string} contractAddress  Deployed MatchRegistry address.
 * @param {bigint} chainId
 * @param {object} params      {nonce, agentId, matchLength, sessionKey}
 * @returns {string} hex signature
 */
async function signOpen(signer, contractAddress, chainId, { nonce, agentId, matchLength, sessionKey }) {
  const inner = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "address", "uint256", "uint256", "uint16", "address"],
      ["Chaingammon:open", chainId, contractAddress, nonce, agentId, matchLength, sessionKey]
    )
  );
  return signer.signMessage(ethers.getBytes(inner));
}

/**
 * Build and sign the "Chaingammon:result" message.
 *
 * @param {Wallet} sessionKeySigner  Session key — signs the result.
 * @param {string} contractAddress
 * @param {bigint} chainId
 * @param {object} params  {nonce, agentId, humanWins, gameRecordHash}
 * @returns {string} hex signature
 */
async function signResult(sessionKeySigner, contractAddress, chainId, { nonce, agentId, humanWins, gameRecordHash }) {
  const inner = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "address", "uint256", "uint256", "uint8", "bytes32"],
      ["Chaingammon:result", chainId, contractAddress, nonce, agentId, humanWins ? 1 : 0, gameRecordHash]
    )
  );
  return sessionKeySigner.signMessage(ethers.getBytes(inner));
}

describe("Phase 26 — MatchRegistry.settleWithSessionKeys", function () {
  let registry;
  let owner, human, sessionKey, relayer;
  let chainId;
  const agentId = 1n;
  const matchLength = 3;

  beforeEach(async function () {
    [owner, human, sessionKey, relayer] = await ethers.getSigners();
    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    registry = await MatchRegistry.deploy();
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  // ── Happy path — human wins ────────────────────────────────────────────────

  it("settles when human wins and updates ELOs", async function () {
    const nonce = 0n;
    const humanWins = true;

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins, gameRecordHash: ZERO_HASH,
    });

    await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, humanWins, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
    );

    expect(Number(await registry.humanElo(human.address))).to.be.greaterThan(1500);
    expect(Number(await registry.agentElo(agentId))).to.be.lessThan(1500);
  });

  // ── Happy path — agent wins ────────────────────────────────────────────────

  it("settles when agent wins and updates ELOs", async function () {
    const nonce = 0n;
    const humanWins = false;

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins, gameRecordHash: ZERO_HASH,
    });

    await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, humanWins, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
    );

    expect(Number(await registry.humanElo(human.address))).to.be.lessThan(1500);
    expect(Number(await registry.agentElo(agentId))).to.be.greaterThan(1500);
  });

  // ── Nonce increments (replay protection) ─────────────────────────────────

  it("increments nonce after settlement", async function () {
    const nonce = 0n;
    expect(await registry.nonces(human.address)).to.equal(0n);

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
    );

    expect(await registry.nonces(human.address)).to.equal(1n);
  });

  it("rejects replay of the same nonce", async function () {
    const nonce = 0n;
    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
    );

    // Replay with the same nonce must fail.
    let reverted = false;
    try {
      await registry.connect(relayer).settleWithSessionKeys(
        agentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  // ── Match record integrity ─────────────────────────────────────────────────

  it("stores gameRecordHash in the match struct", async function () {
    const hash = ethers.id("some-game-record");
    const nonce = 0n;

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins: true, gameRecordHash: hash,
    });

    const tx = await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, true, hash, nonce, sessionKey.address, humanAuthSig, resultSig
    );
    const receipt = await tx.wait();
    const evt = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded");
    const matchId = evt.args[0];
    const info = await registry.getMatch(matchId);
    expect(info.gameRecordHash).to.equal(hash);
  });

  // ── Tamper detection ───────────────────────────────────────────────────────

  it("rejects if resultSig is from a different address than sessionKey", async function () {
    const nonce = 0n;
    const imposter = relayer; // signs the result but isn't the declared session key

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    // resultSig produced by `imposter`, not `sessionKey`
    const resultSig = await signResult(imposter, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    let reverted = false;
    try {
      await registry.connect(relayer).settleWithSessionKeys(
        agentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("rejects if humanAuthSig outcome differs from resultSig (wrong agentId)", async function () {
    const nonce = 0n;
    const wrongAgentId = 999n;

    // human signed for agentId=1 but we submit agentId=999
    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId: wrongAgentId, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    let reverted = false;
    try {
      await registry.connect(relayer).settleWithSessionKeys(
        wrongAgentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("rejects agentId = 0", async function () {
    const nonce = 0n;
    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId: 0n, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId: 0n, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    let reverted = false;
    try {
      await registry.connect(relayer).settleWithSessionKeys(
        0n, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  // ── emits MatchRecorded ────────────────────────────────────────────────────

  it("emits MatchRecorded event", async function () {
    const nonce = 0n;
    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResult(sessionKey, await registry.getAddress(), chainId, {
      nonce, agentId, humanWins: true, gameRecordHash: ZERO_HASH,
    });

    const tx = await registry.connect(relayer).settleWithSessionKeys(
      agentId, matchLength, true, ZERO_HASH, nonce, sessionKey.address, humanAuthSig, resultSig
    );
    const receipt = await tx.wait();
    const evt = receipt.logs.find((l) => l.fragment?.name === "MatchRecorded");
    expect(evt).to.not.be.undefined;
  });

  // ── recordMatch (owner path) still works ──────────────────────────────────

  it("existing recordMatch still works alongside settleWithSessionKeys", async function () {
    await registry.connect(owner).recordMatch(0, human.address, agentId, ZERO, matchLength, ZERO_HASH);
    expect(Number(await registry.humanElo(human.address))).to.be.greaterThan(1500);
  });
});
