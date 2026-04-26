// Phase 0 scaffold tests — contracts sub-project
// Run with: npx hardhat test test/scaffold.test.js

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const CONTRACTS = path.resolve(__dirname, "..");

describe("Phase 0 — Scaffold", function () {
  describe("hardhat config", function () {
    let config;

    before(function () {
      config = require(path.join(CONTRACTS, "hardhat.config.js"));
    });

    it("targets Solidity 0.8.24", function () {
      expect(config.solidity.version).to.equal("0.8.24");
    });

    it("uses evmVersion cancun", function () {
      expect(config.solidity.settings.evmVersion).to.equal("cancun");
    });

    it("has optimizer enabled", function () {
      expect(config.solidity.settings.optimizer.enabled).to.be.true;
    });

    it("declares 0g-testnet network", function () {
      expect(config.networks).to.have.property("0g-testnet");
    });

    it("0g-testnet has correct chainId", function () {
      expect(config.networks["0g-testnet"].chainId).to.equal(16602);
    });
  });

  describe("directory structure", function () {
    it("src/ exists", function () {
      expect(fs.existsSync(path.join(CONTRACTS, "src"))).to.be.true;
    });

    it("test/ exists", function () {
      expect(fs.existsSync(path.join(CONTRACTS, "test"))).to.be.true;
    });

    it("script/ exists", function () {
      expect(fs.existsSync(path.join(CONTRACTS, "script"))).to.be.true;
    });
  });

  describe(".env.example", function () {
    let content;

    before(function () {
      content = fs.readFileSync(path.join(CONTRACTS, ".env.example"), "utf8");
    });

    it("exists", function () {
      expect(fs.existsSync(path.join(CONTRACTS, ".env.example"))).to.be.true;
    });

    it("contains DEPLOYER_PRIVATE_KEY", function () {
      expect(content).to.include("DEPLOYER_PRIVATE_KEY");
    });

    it("contains RPC_URL", function () {
      expect(content).to.include("RPC_URL");
    });
  });

  describe("compilation", function () {
    it("compiles with no errors", async function () {
      // hre is globally available in Hardhat test context
      await hre.run("compile");
    });
  });
});
