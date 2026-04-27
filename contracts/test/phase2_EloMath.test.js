const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase 2 — EloMath", function () {
  let elo;

  before(async function () {
    const EloHarness = await ethers.getContractFactory("EloMathHarness");
    elo = await EloHarness.deploy();
  });

  describe("constants", function () {
    it("K factor is 32", async function () {
      expect(await elo.K()).to.equal(32n);
    });

    it("INITIAL rating is 1500", async function () {
      expect(await elo.INITIAL()).to.equal(1500n);
    });
  });

  describe("expectedScorePct (rating A vs rating B, returns A's expected score 0-100)", function () {
    it("equal ratings -> 50", async function () {
      expect(await elo.expectedScorePct(1500, 1500)).to.equal(50n);
    });

    it("higher A by 100 -> ~64", async function () {
      const v = await elo.expectedScorePct(1600, 1500);
      expect(Number(v)).to.be.within(63, 65);
    });

    it("higher A by 400 -> ~91", async function () {
      const v = await elo.expectedScorePct(1900, 1500);
      expect(Number(v)).to.be.within(89, 92);
    });

    it("lower A by 100 -> ~36", async function () {
      const v = await elo.expectedScorePct(1500, 1600);
      expect(Number(v)).to.be.within(35, 37);
    });

    it("very large gap clamped near 0/100", async function () {
      expect(Number(await elo.expectedScorePct(2500, 1000))).to.be.greaterThan(95);
      expect(Number(await elo.expectedScorePct(1000, 2500))).to.be.lessThan(5);
    });
  });

  describe("newRating (current, expectedPct, won) — applies K * (S - E) / 100", function () {
    it("equal opponents, winner gains K/2 = 16", async function () {
      expect(await elo.newRating(1500, 50, true)).to.equal(1516n);
    });

    it("equal opponents, loser loses K/2 = 16", async function () {
      expect(await elo.newRating(1500, 50, false)).to.equal(1484n);
    });

    it("favorite winning gains less than K/2", async function () {
      // expected ~91 (400 above), won → delta = 32 * 9 / 100 ≈ 2-3
      const expectedPct = 91;
      const newR = await elo.newRating(1900, expectedPct, true);
      expect(Number(newR) - 1900).to.be.within(1, 4);
    });

    it("underdog winning gains more than K/2", async function () {
      // expected ~9 (400 below), won → delta = 32 * 91 / 100 ≈ 29
      const expectedPct = 9;
      const newR = await elo.newRating(1500, expectedPct, true);
      expect(Number(newR) - 1500).to.be.within(28, 30);
    });

    it("rating cannot go negative", async function () {
      expect(await elo.newRating(10, 50, false)).to.equal(0n);
    });
  });

  describe("symmetry — winner gain equals loser loss", function () {
    it("equal ratings, sum unchanged", async function () {
      const winnerNew = await elo.newRating(1500, 50, true);
      const loserNew = await elo.newRating(1500, 50, false);
      expect(Number(winnerNew) + Number(loserNew)).to.equal(3000);
    });

    it("400 gap upset, sum unchanged", async function () {
      const winnerExp = await elo.expectedScorePct(1500, 1900); // ~9
      const loserExp = await elo.expectedScorePct(1900, 1500);  // ~91
      const winnerNew = await elo.newRating(1500, Number(winnerExp), true);
      const loserNew = await elo.newRating(1900, Number(loserExp), false);
      expect(Number(winnerNew) + Number(loserNew)).to.equal(3400);
    });
  });
});
