const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const STAKE = ethers.parseEther("0.1");

const Status = {
  Empty: 0n,
  Deposited: 1n,
  Refunded: 2n,
  PaidOut: 3n,
};

describe("MatchEscrow", function () {
  let escrow;
  let owner, alice, bob, charlie, settler;

  // matchId is opaque; the contract treats it as an off-chain
  // keccak256(playerA || playerB || nonce). For tests we use a
  // human-readable hash so failures are easier to read.
  const matchId = ethers.id("match-001");

  beforeEach(async function () {
    [owner, alice, bob, charlie, settler] = await ethers.getSigners();
    const MatchEscrow = await ethers.getContractFactory("MatchEscrow");
    escrow = await MatchEscrow.deploy(settler.address);
  });

  // ---------------------------------------------------------------------
  // deposit
  // ---------------------------------------------------------------------

  describe("deposit", function () {
    it("first deposit fills side A and emits Deposited", async function () {
      await expect(
        escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE })
      )
        .to.emit(escrow, "Deposited")
        .withArgs(matchId, alice.address, STAKE);

      const m = await escrow.getMatch(matchId);
      expect(m.a.player).to.equal(alice.address);
      expect(m.a.amount).to.equal(STAKE);
      expect(m.a.status).to.equal(Status.Deposited);
      expect(m.b.player).to.equal(ZERO);
      expect(m.open).to.equal(false);
      expect(m.settled).to.equal(false);
    });

    it("second deposit opens the match and emits Opened", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(bob).deposit(matchId, STAKE, { value: STAKE })
      )
        .to.emit(escrow, "Opened")
        .withArgs(matchId, alice.address, bob.address, STAKE * 2n);

      const m = await escrow.getMatch(matchId);
      expect(m.open).to.equal(true);
      expect(m.b.player).to.equal(bob.address);
      expect(await escrow.pot(matchId)).to.equal(STAKE * 2n);
    });

    it("rejects msg.value not equal to expected", async function () {
      await expect(
        escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE - 1n })
      ).to.be.revertedWithCustomError(escrow, "WrongStakeAmount");
    });

    it("second deposit must match the first side's stake", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(bob).deposit(matchId, STAKE * 2n, { value: STAKE * 2n })
      ).to.be.revertedWithCustomError(escrow, "WrongStakeAmount");
    });

    it("rejects same address depositing twice", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE })
      ).to.be.revertedWithCustomError(escrow, "AlreadyDeposited");
    });

    it("rejects a third depositor once the match is open", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(charlie).deposit(matchId, STAKE, { value: STAKE })
      ).to.be.revertedWithCustomError(escrow, "MatchAlreadyOpen");
    });
  });

  // ---------------------------------------------------------------------
  // refund
  // ---------------------------------------------------------------------

  describe("refund", function () {
    it("first depositor can refund before second deposits", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await escrow.connect(alice).refund(matchId);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);
      // Allow for gas; the refund should bring the balance back to
      // approximately (before + STAKE).
      expect(after).to.equal(before + STAKE - gas);
    });

    it("refund flips status to Refunded and clears amount", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(alice).refund(matchId);
      const m = await escrow.getMatch(matchId);
      expect(m.a.status).to.equal(Status.Refunded);
      expect(m.a.amount).to.equal(0n);
    });

    it("rejects refund once both sides have deposited", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(alice).refund(matchId)
      ).to.be.revertedWithCustomError(escrow, "MatchAlreadyOpen");
    });

    it("rejects refund from non-depositor", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        escrow.connect(charlie).refund(matchId)
      ).to.be.revertedWithCustomError(escrow, "NothingToRefund");
    });

    it("rejects double refund", async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(alice).refund(matchId);
      await expect(
        escrow.connect(alice).refund(matchId)
      ).to.be.revertedWithCustomError(escrow, "NothingToRefund");
    });
  });

  // ---------------------------------------------------------------------
  // payoutWinner
  // ---------------------------------------------------------------------

  describe("payoutWinner", function () {
    beforeEach(async function () {
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(matchId, STAKE, { value: STAKE });
    });

    it("settler can pay out the full pot to a depositor", async function () {
      const before = await ethers.provider.getBalance(alice.address);
      await expect(
        escrow.connect(settler).payoutWinner(matchId, alice.address)
      )
        .to.emit(escrow, "PaidOut")
        .withArgs(matchId, alice.address, STAKE * 2n);
      const after = await ethers.provider.getBalance(alice.address);
      // alice didn't pay any gas (settler did); her balance should go
      // up by exactly the pot.
      expect(after - before).to.equal(STAKE * 2n);
    });

    it("rejects non-settler caller", async function () {
      await expect(
        escrow.connect(alice).payoutWinner(matchId, alice.address)
      ).to.be.revertedWithCustomError(escrow, "NotSettler");
    });

    it("rejects winner who isn't a depositor", async function () {
      await expect(
        escrow.connect(settler).payoutWinner(matchId, charlie.address)
      ).to.be.revertedWithCustomError(escrow, "NotDepositor");
    });

    it("rejects double payout", async function () {
      await escrow.connect(settler).payoutWinner(matchId, alice.address);
      await expect(
        escrow.connect(settler).payoutWinner(matchId, alice.address)
      ).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("rejects payout when match isn't open", async function () {
      const otherMatch = ethers.id("match-002");
      await expect(
        escrow.connect(settler).payoutWinner(otherMatch, alice.address)
      ).to.be.revertedWithCustomError(escrow, "MatchNotOpen");
    });

    it("settler == 0 disables payouts entirely", async function () {
      const Disabled = await ethers.getContractFactory("MatchEscrow");
      const disabled = await Disabled.deploy(ZERO);
      await disabled.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await disabled.connect(bob).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        disabled.connect(settler).payoutWinner(matchId, alice.address)
      ).to.be.revertedWithCustomError(disabled, "NoSettlerConfigured");
    });
  });
});
