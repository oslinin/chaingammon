// Tests for MatchRegistry.settleWithSessionKeysAndSplit — trustless
// session-key settlement WITH on-chain payout via MatchEscrow.payoutSplit.
//
// Design under test (see MatchRegistry.sol natspec):
//   1. Same auth message as settleWithSessionKeys ("Chaingammon:open").
//   2. Result message uses a distinct prefix ("Chaingammon:result-with-split")
//      and binds escrowMatchId + splitHash so a relayer cannot tamper with
//      the split arrays.
//   3. After auth + result + nonce checks, _doRecord runs and then
//      _payoutFromEscrow calls IMatchEscrow.payoutSplit. Atomic — escrow
//      revert rolls the whole tx back.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;
const STAKE = ethers.parseEther("0.1");

async function signOpen(signer, contractAddress, chainId, { human, nonce, agentId, matchLength, sessionKey }) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "uint256", "uint256", "uint16", "address"],
      ["Chaingammon:open", chainId, contractAddress, human, nonce, agentId, matchLength, sessionKey]
    )
  );
  return signer.signMessage(ethers.getBytes(inner));
}

function computeSplitHash(winners, shares) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]"],
      [winners, shares]
    )
  );
}

async function signResultWithSplit(
  sessionKeySigner,
  contractAddress,
  chainId,
  { human, nonce, agentId, humanWins, gameRecordHash, escrowMatchId, winners, shares }
) {
  const splitHash = computeSplitHash(winners, shares);
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "uint256", "uint256", "bool", "bytes32", "bytes32", "bytes32"],
      ["Chaingammon:result-with-split", chainId, contractAddress, human, nonce, agentId, humanWins, gameRecordHash, escrowMatchId, splitHash]
    )
  );
  return sessionKeySigner.signMessage(ethers.getBytes(inner));
}

describe("MatchRegistry.settleWithSessionKeysAndSplit", function () {
  let registry;
  let escrow;
  let owner, human, opponentHuman, sessionKey, relayer, advisor;
  let chainId;
  const agentId = 1n;
  const matchLength = 3;
  const escrowMatchId = ethers.id("session-split-001");

  beforeEach(async function () {
    [owner, human, opponentHuman, sessionKey, relayer, advisor] = await ethers.getSigners();
    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    registry = await MatchRegistry.deploy();
    const MatchEscrow = await ethers.getContractFactory("MatchEscrow");
    escrow = await MatchEscrow.deploy(await registry.getAddress());
    await registry.connect(owner).setMatchEscrow(await escrow.getAddress());

    // Both sides fund the escrow.
    await escrow.connect(human).deposit(escrowMatchId, STAKE, { value: STAKE });
    await escrow.connect(opponentHuman).deposit(escrowMatchId, STAKE, { value: STAKE });

    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  // -------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------

  it("settles solo (single winner = full pot) when human wins", async function () {
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId, winners, shares,
    });

    const humanBefore = await ethers.provider.getBalance(human.address);
    await registry.connect(relayer).settleWithSessionKeysAndSplit(
      human.address, agentId, matchLength, humanWins, ZERO_HASH,
      nonce, sessionKey.address, humanAuthSig, resultSig,
      escrowMatchId, winners, shares
    );
    const humanAfter = await ethers.provider.getBalance(human.address);
    // Human paid no gas (relayer did) — balance up by the full pot.
    expect(humanAfter - humanBefore).to.equal(POT);

    // ELOs updated.
    expect(Number(await registry.humanElo(human.address))).to.be.greaterThan(1500);
    expect(Number(await registry.agentElo(agentId))).to.be.lessThan(1500);

    // Escrow settled.
    const m = await escrow.getMatch(escrowMatchId);
    expect(m.settled).to.equal(true);
  });

  it("settles team-mode (N-way split) when human + advisor win", async function () {
    const POT = STAKE * 2n;
    const captainShare = (POT * 70n) / 100n;
    const advisorShare = POT - captainShare;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address, advisor.address];
    const shares = [captainShare, advisorShare];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId, winners, shares,
    });

    const advisorBefore = await ethers.provider.getBalance(advisor.address);
    await registry.connect(relayer).settleWithSessionKeysAndSplit(
      human.address, agentId, matchLength, humanWins, ZERO_HASH,
      nonce, sessionKey.address, humanAuthSig, resultSig,
      escrowMatchId, winners, shares
    );
    const advisorAfter = await ethers.provider.getBalance(advisor.address);
    expect(advisorAfter - advisorBefore).to.equal(advisorShare);
  });

  // -------------------------------------------------------------------
  // Tampering / replay
  // -------------------------------------------------------------------

  it("reverts if relayer tampers with the split (winners changed)", async function () {
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const signedWinners = [human.address];
    const signedShares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners: signedWinners, shares: signedShares,
    });

    // Relayer submits a different `winners[]` array than what was signed.
    const tamperedWinners = [advisor.address];
    const tamperedShares = [POT];

    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, resultSig,
        escrowMatchId, tamperedWinners, tamperedShares
      )
    ).to.be.revertedWith("resultSig not from sessionKey");
  });

  it("reverts if relayer tampers with the split (shares changed)", async function () {
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const signedShares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners, shares: signedShares,
    });

    // Tampered shares (not what the session key signed).
    const tamperedShares = [POT - 1n];

    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, resultSig,
        escrowMatchId, winners, tamperedShares
      )
    ).to.be.revertedWith("resultSig not from sessionKey");
  });

  it("reverts if relayer tampers with escrowMatchId", async function () {
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners, shares,
    });

    const wrongEscrowId = ethers.id("session-split-002");

    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, resultSig,
        wrongEscrowId, winners, shares
      )
    ).to.be.revertedWith("resultSig not from sessionKey");
  });

  it("non-payout settleWithSessionKeys signature cannot be replayed here", async function () {
    // The non-payout result hash uses prefix "Chaingammon:result"; this
    // function uses "Chaingammon:result-with-split". A signature for one
    // must NOT validate against the other.
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    // Sign the OLD format (no split).
    const oldResultInner = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "uint256", "uint256", "bool", "bytes32"],
        ["Chaingammon:result", chainId, await registry.getAddress(), human.address, nonce, agentId, humanWins, ZERO_HASH]
      )
    );
    const oldResultSig = await sessionKey.signMessage(ethers.getBytes(oldResultInner));

    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, oldResultSig,
        escrowMatchId, winners, shares
      )
    ).to.be.revertedWith("resultSig not from sessionKey");
  });

  // -------------------------------------------------------------------
  // Other revert paths
  // -------------------------------------------------------------------

  it("reverts on nonce mismatch", async function () {
    const POT = STAKE * 2n;
    const wrongNonce = 5n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce: wrongNonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce: wrongNonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners, shares,
    });

    // signOpen with wrongNonce produces a sig the contract will accept
    // for the auth check (the human signed it) but then the on-chain
    // nonce check rejects.
    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        wrongNonce, sessionKey.address, humanAuthSig, resultSig,
        escrowMatchId, winners, shares
      )
    ).to.be.revertedWith("nonce mismatch");
  });

  it("reverts when escrow.payoutSplit rejects the split (sum mismatch)", async function () {
    // Session key is willing to sign a bad split; escrow rejects.
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [STAKE]; // half the pot — will fail ShareSumMismatch

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners, shares,
    });

    const matchCountBefore = await registry.matchCount();
    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, resultSig,
        escrowMatchId, winners, shares
      )
    ).to.be.revertedWithCustomError(escrow, "ShareSumMismatch");
    // Atomic: registry's match record was rolled back.
    expect(await registry.matchCount()).to.equal(matchCountBefore);
  });

  it("nonce increments after a successful settle (replay protection)", async function () {
    const POT = STAKE * 2n;
    const nonce = 0n;
    const humanWins = true;
    const winners = [human.address];
    const shares = [POT];

    const humanAuthSig = await signOpen(human, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, matchLength, sessionKey: sessionKey.address,
    });
    const resultSig = await signResultWithSplit(sessionKey, await registry.getAddress(), chainId, {
      human: human.address, nonce, agentId, humanWins, gameRecordHash: ZERO_HASH, escrowMatchId,
      winners, shares,
    });

    await registry.connect(relayer).settleWithSessionKeysAndSplit(
      human.address, agentId, matchLength, humanWins, ZERO_HASH,
      nonce, sessionKey.address, humanAuthSig, resultSig,
      escrowMatchId, winners, shares
    );
    expect(await registry.nonces(human.address)).to.equal(1n);

    // Replay with the same nonce now reverts.
    await expect(
      registry.connect(relayer).settleWithSessionKeysAndSplit(
        human.address, agentId, matchLength, humanWins, ZERO_HASH,
        nonce, sessionKey.address, humanAuthSig, resultSig,
        escrowMatchId, winners, shares
      )
    ).to.be.revertedWith("nonce mismatch");
  });
});
