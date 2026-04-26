const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

describe("Phase 0 Scaffolding", function () {
  const rootDir = path.join(__dirname, "..", "..");

  it("Should have Hardhat installed and compile without errors", function () {
    const hardhat = require("hardhat");
    expect(hardhat).to.not.be.undefined;
    
    try {
      execSync("npx hardhat compile", { cwd: path.join(rootDir, "contracts"), stdio: "pipe" });
      expect(true).to.be.true;
    } catch (error) {
      expect.fail(`Hardhat compile failed: ${error.message}\n${error.stderr?.toString()}`);
    }
  });

  it("Should have directory structure", function () {
    expect(fs.existsSync(path.join(rootDir, "server"))).to.be.true;
    expect(fs.existsSync(path.join(rootDir, "contracts"))).to.be.true;
    expect(fs.existsSync(path.join(rootDir, "frontend"))).to.be.true;
  });

  it("Should have .env.example files in each sub-project", function () {
    expect(fs.existsSync(path.join(rootDir, "server", ".env.example"))).to.be.true;
    expect(fs.existsSync(path.join(rootDir, "contracts", ".env.example"))).to.be.true;
    expect(fs.existsSync(path.join(rootDir, "frontend", ".env.example"))).to.be.true;
  });

  it("Frontend should have Next.js, wagmi, viem, and typescript installed", function () {
    const frontendPkgPath = path.join(rootDir, "frontend", "package.json");
    expect(fs.existsSync(frontendPkgPath)).to.be.true;
    
    const pkg = JSON.parse(fs.readFileSync(frontendPkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    expect(deps).to.have.property("next");
    expect(deps).to.have.property("typescript");
    expect(deps).to.have.property("wagmi");
    expect(deps).to.have.property("viem");
  });
});
