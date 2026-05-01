const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;
const STAKE = ethers.parseEther("0.1");

// MatchRegistry → MatchEscrow wiring (closes the on-chain settlement
// loop laid out in docs/team-mode.md). Covers the setter, atomic
// record + payout via recordMatchAndSplit (single-winner solo case
// AND team-mode N-way split), and revert paths.
describe("MatchRegistry × MatchEscrow wiring", function () {
  let registry;
  let escrow;
  let owner, alice, bob, charlie, dave;

  // Opaque escrow id; off-chain it's keccak256(playerA || playerB || nonce).
  const escrowMatchId = ethers.id("escrow-match-001");

  beforeEach(async function () {
    [owner, alice, bob, charlie, dave] = await ethers.getSigners();

    const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
    registry = await MatchRegistry.deploy();
    const registryAddr = await registry.getAddress();

    const MatchEscrow = await ethers.getContractFactory("MatchEscrow");
    escrow = await MatchEscrow.deploy(registryAddr);
  });

  // -------------------------------------------------------------------
  // setMatchEscrow
  // -------------------------------------------------------------------

  describe("setMatchEscrow", function () {
    it("starts at zero address", async function () {
      expect(await registry.matchEscrow()).to.equal(ZERO);
    });

    it("owner can set the escrow address and emits MatchEscrowSet", async function () {
      const escrowAddr = await escrow.getAddress();
      await expect(registry.connect(owner).setMatchEscrow(escrowAddr))
        .to.emit(registry, "MatchEscrowSet")
        .withArgs(ZERO, escrowAddr);
      expect(await registry.matchEscrow()).to.equal(escrowAddr);
    });

    it("rejects non-owner", async function () {
      const escrowAddr = await escrow.getAddress();
      await expect(
        registry.connect(alice).setMatchEscrow(escrowAddr)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("can be re-wired (e.g. point at a new escrow)", async function () {
      const escrowAddrA = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddrA);

      const MatchEscrow = await ethers.getContractFactory("MatchEscrow");
      const escrowB = await MatchEscrow.deploy(await registry.getAddress());
      const escrowAddrB = await escrowB.getAddress();

      await expect(registry.connect(owner).setMatchEscrow(escrowAddrB))
        .to.emit(registry, "MatchEscrowSet")
        .withArgs(escrowAddrA, escrowAddrB);
      expect(await registry.matchEscrow()).to.equal(escrowAddrB);
    });
  });

  // -------------------------------------------------------------------
  // recordMatchAndSplit — solo (single-winner) flow
  // -------------------------------------------------------------------

  describe("recordMatchAndSplit (solo: single winner)", function () {
    beforeEach(async function () {
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);
      // Both sides fund the escrow.
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });
    });

    it("records the match AND pays out the full pot to the single winner", async function () {
      const POT = STAKE * 2n;
      const aliceBefore = await ethers.provider.getBalance(alice.address);

      await expect(
        registry.connect(owner).recordMatchAndSplit(
          0, alice.address,        // winner: human alice
          1, ZERO,                  // loser: agent #1
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [POT],
        )
      )
        .to.emit(registry, "MatchRecorded")
        .and.to.emit(escrow, "PaidOut").withArgs(escrowMatchId, alice.address, POT);

      const aliceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceAfter - aliceBefore).to.equal(POT);

      // Match was recorded too — counter advanced, escrow settled.
      expect(await registry.matchCount()).to.equal(1n);
      const m = await escrow.getMatch(escrowMatchId);
      expect(m.settled).to.equal(true);
    });
  });

  // -------------------------------------------------------------------
  // recordMatchAndSplit — team-mode flow
  // -------------------------------------------------------------------

  describe("recordMatchAndSplit (team-mode: N-way split)", function () {
    beforeEach(async function () {
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });
    });

    it("splits the pot 70/30 between captain and non-depositor advisor", async function () {
      // Team-mode case: alice captains the winning team; dave is the
      // agent's owner who never staked but is on the team and gets 30%.
      const POT = STAKE * 2n;
      const captainShare = (POT * 70n) / 100n;
      const advisorShare = POT - captainShare;
      const daveBefore = await ethers.provider.getBalance(dave.address);

      await registry.connect(owner).recordMatchAndSplit(
        0, alice.address,
        1, ZERO,
        1, ZERO_HASH,
        escrowMatchId,
        [alice.address, dave.address],
        [captainShare, advisorShare],
      );

      const daveAfter = await ethers.provider.getBalance(dave.address);
      expect(daveAfter - daveBefore).to.equal(advisorShare);
    });
  });

  // -------------------------------------------------------------------
  // Revert paths
  // -------------------------------------------------------------------

  describe("recordMatchAndSplit reverts", function () {
    it("reverts with NoEscrowConfigured when escrow not wired", async function () {
      // Note: did NOT call setMatchEscrow.
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });

      await expect(
        registry.connect(owner).recordMatchAndSplit(
          0, alice.address,
          1, ZERO,
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWithCustomError(registry, "NoEscrowConfigured");
    });

    it("reverts and rolls back the match record when escrow.payoutSplit fails", async function () {
      // Escrow wired but match never opened in escrow → payoutSplit reverts
      // with MatchNotOpen, and the registry's _doRecord must roll back.
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);

      const countBefore = await registry.matchCount();
      await expect(
        registry.connect(owner).recordMatchAndSplit(
          0, alice.address,
          1, ZERO,
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWithCustomError(escrow, "MatchNotOpen");
      // No record was written — atomic.
      expect(await registry.matchCount()).to.equal(countBefore);
    });

    it("non-owner cannot call recordMatchAndSplit", async function () {
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });

      await expect(
        registry.connect(alice).recordMatchAndSplit(
          0, alice.address,
          1, ZERO,
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("bubbles up ShareSumMismatch from the escrow", async function () {
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });

      await expect(
        registry.connect(owner).recordMatchAndSplit(
          0, alice.address,
          1, ZERO,
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [STAKE], // half the pot — mismatch
        )
      ).to.be.revertedWithCustomError(escrow, "ShareSumMismatch");
    });

    it("rejects malformed winner/loser pair (existing recordMatch invariants)", async function () {
      const escrowAddr = await escrow.getAddress();
      await registry.connect(owner).setMatchEscrow(escrowAddr);
      await escrow.connect(alice).deposit(escrowMatchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(escrowMatchId, STAKE, { value: STAKE });

      // Both winnerAgentId and winnerHuman set — invalid.
      await expect(
        registry.connect(owner).recordMatchAndSplit(
          1, alice.address,
          1, ZERO,
          1, ZERO_HASH,
          escrowMatchId,
          [alice.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWith("winner must be exactly one of agent or human");
    });
  });
});
