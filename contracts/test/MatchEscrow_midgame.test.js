const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MatchEscrow - Midgame Doubling", function () {
  let escrow, settler, playerA, playerB, stranger;
  const matchId = "0x1234567890123456789012345678901234567890123456789012345678901234";

  before(async function () {
    [settler, playerA, playerB, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MatchEscrow");
    escrow = await Factory.deploy(settler.address);
  });

  it("should allow A and B to open the match", async function () {
    const stake = ethers.parseEther("1.0");
    await escrow.connect(playerA).deposit(matchId, stake, { value: stake });
    await escrow.connect(playerB).deposit(matchId, stake, { value: stake });

    const m = await escrow.getMatch(matchId);
    expect(m.open).to.be.true;
    expect(await escrow.pot(matchId)).to.equal(ethers.parseEther("2.0"));
  });

  it("should allow A to double the stakes mid-game", async function () {
    const doubleAmount = ethers.parseEther("1.0");
    await escrow.connect(playerA).deposit(matchId, doubleAmount, { value: doubleAmount });

    const m = await escrow.getMatch(matchId);
    expect(m.a.amount).to.equal(ethers.parseEther("2.0"));
    expect(await escrow.pot(matchId)).to.equal(ethers.parseEther("3.0"));
  });

  it("should allow B to take the double mid-game", async function () {
    const doubleAmount = ethers.parseEther("1.0");
    await escrow.connect(playerB).deposit(matchId, doubleAmount, { value: doubleAmount });

    const m = await escrow.getMatch(matchId);
    expect(m.b.amount).to.equal(ethers.parseEther("2.0"));
    expect(await escrow.pot(matchId)).to.equal(ethers.parseEther("4.0"));
  });

  it("should revert if stranger tries to deposit mid-game", async function () {
    const amount = ethers.parseEther("1.0");
    await expect(
      escrow.connect(stranger).deposit(matchId, amount, { value: amount })
    ).to.be.revertedWithCustomError(escrow, "MatchAlreadyOpen");
  });
});
