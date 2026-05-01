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

  // ---------------------------------------------------------------------
  // payoutSplit — team-mode settlement (see docs/team-mode.md).
  // ---------------------------------------------------------------------

  describe("payoutSplit", function () {
    let dave;

    beforeEach(async function () {
      [, , , , , dave] = await ethers.getSigners();
      await escrow.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await escrow.connect(bob).deposit(matchId, STAKE, { value: STAKE });
    });

    it("splits the pot 50/50 between two winners", async function () {
      const POT = STAKE * 2n;
      const half = POT / 2n;
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const charlieBefore = await ethers.provider.getBalance(charlie.address);

      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, charlie.address],
          [half, half],
        )
      )
        .to.emit(escrow, "PaidOut").withArgs(matchId, alice.address, half)
        .and.to.emit(escrow, "PaidOut").withArgs(matchId, charlie.address, half);

      const aliceAfter = await ethers.provider.getBalance(alice.address);
      const charlieAfter = await ethers.provider.getBalance(charlie.address);
      expect(aliceAfter - aliceBefore).to.equal(half);
      expect(charlieAfter - charlieBefore).to.equal(half);
    });

    it("supports an arbitrary 3-way split summing to the pot", async function () {
      const POT = STAKE * 2n;
      // 60/30/10 split. Pot is 0.2 ETH so shares are 0.12, 0.06, 0.02.
      const s1 = (POT * 60n) / 100n;
      const s2 = (POT * 30n) / 100n;
      const s3 = POT - s1 - s2;
      expect(s1 + s2 + s3).to.equal(POT);

      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, bob.address, charlie.address],
          [s1, s2, s3],
        )
      ).to.emit(escrow, "PaidOut");

      const m = await escrow.getMatch(matchId);
      expect(m.settled).to.equal(true);
    });

    it("allows winners who are NOT depositors (team-mode case)", async function () {
      // The captain (alice) deposited; dave is the agent's owner who
      // never staked but is on the winning team per the settler.
      const POT = STAKE * 2n;
      const captainShare = (POT * 70n) / 100n;
      const advisorShare = POT - captainShare;
      const daveBefore = await ethers.provider.getBalance(dave.address);

      await escrow.connect(settler).payoutSplit(
        matchId,
        [alice.address, dave.address],
        [captainShare, advisorShare],
      );

      const daveAfter = await ethers.provider.getBalance(dave.address);
      expect(daveAfter - daveBefore).to.equal(advisorShare);
    });

    it("skips zero-share entries without emitting PaidOut for them", async function () {
      // Settler may include team members with 0 share for record-keeping.
      const POT = STAKE * 2n;

      const tx = await escrow.connect(settler).payoutSplit(
        matchId,
        [alice.address, charlie.address],
        [POT, 0n],
      );
      const receipt = await tx.wait();
      // Exactly one PaidOut event — the zero-share entry is skipped.
      const paidOuts = receipt.logs.filter((l) => {
        try {
          return escrow.interface.parseLog(l)?.name === "PaidOut";
        } catch {
          return false;
        }
      });
      expect(paidOuts).to.have.lengthOf(1);
    });

    it("rejects non-settler caller", async function () {
      await expect(
        escrow.connect(alice).payoutSplit(matchId,
          [alice.address], [STAKE * 2n])
      ).to.be.revertedWithCustomError(escrow, "NotSettler");
    });

    it("rejects empty winners array", async function () {
      await expect(
        escrow.connect(settler).payoutSplit(matchId, [], [])
      ).to.be.revertedWithCustomError(escrow, "EmptyWinners");
    });

    it("rejects winners.length != shares.length", async function () {
      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, bob.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWithCustomError(escrow, "LengthMismatch");
    });

    it("rejects zero-address winner", async function () {
      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, ZERO],
          [STAKE, STAKE],
        )
      ).to.be.revertedWithCustomError(escrow, "ZeroAddressWinner");
    });

    it("rejects share sum greater than pot", async function () {
      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, bob.address],
          [STAKE * 2n, 1n],
        )
      ).to.be.revertedWithCustomError(escrow, "ShareSumMismatch");
    });

    it("rejects share sum less than pot", async function () {
      await expect(
        escrow.connect(settler).payoutSplit(
          matchId,
          [alice.address, bob.address],
          [STAKE, STAKE - 1n],
        )
      ).to.be.revertedWithCustomError(escrow, "ShareSumMismatch");
    });

    it("rejects payout when match isn't open", async function () {
      const otherMatch = ethers.id("match-002");
      await expect(
        escrow.connect(settler).payoutSplit(
          otherMatch,
          [alice.address],
          [STAKE * 2n],
        )
      ).to.be.revertedWithCustomError(escrow, "MatchNotOpen");
    });

    it("rejects double payoutSplit", async function () {
      const POT = STAKE * 2n;
      await escrow.connect(settler).payoutSplit(
        matchId, [alice.address], [POT]
      );
      await expect(
        escrow.connect(settler).payoutSplit(matchId, [alice.address], [POT])
      ).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("payoutSplit then payoutWinner reverts with AlreadySettled", async function () {
      const POT = STAKE * 2n;
      await escrow.connect(settler).payoutSplit(
        matchId, [alice.address], [POT]
      );
      await expect(
        escrow.connect(settler).payoutWinner(matchId, alice.address)
      ).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("payoutWinner then payoutSplit reverts with AlreadySettled", async function () {
      await escrow.connect(settler).payoutWinner(matchId, alice.address);
      await expect(
        escrow.connect(settler).payoutSplit(
          matchId, [alice.address], [STAKE * 2n]
        )
      ).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("settler == 0 disables payoutSplit entirely", async function () {
      const Disabled = await ethers.getContractFactory("MatchEscrow");
      const disabled = await Disabled.deploy(ZERO);
      await disabled.connect(alice).deposit(matchId, STAKE, { value: STAKE });
      await disabled.connect(bob).deposit(matchId, STAKE, { value: STAKE });
      await expect(
        disabled.connect(settler).payoutSplit(
          matchId, [alice.address], [STAKE * 2n]
        )
      ).to.be.revertedWithCustomError(disabled, "NoSettlerConfigured");
    });

    it("flips status to PaidOut and zeros amounts", async function () {
      const POT = STAKE * 2n;
      await escrow.connect(settler).payoutSplit(
        matchId,
        [alice.address, bob.address],
        [POT / 2n, POT / 2n],
      );
      const m = await escrow.getMatch(matchId);
      expect(m.settled).to.equal(true);
      expect(m.a.status).to.equal(Status.PaidOut);
      expect(m.b.status).to.equal(Status.PaidOut);
      expect(m.a.amount).to.equal(0n);
      expect(m.b.amount).to.equal(0n);
    });
  });
});
