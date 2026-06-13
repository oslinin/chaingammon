// Deploy AgentDividendVault to the configured network.
// Reads UsdcToken address from deployments/<network>.json.
// Writes AgentDividendVault address back to the same file.
//
// Usage:
//   pnpm exec hardhat run script/deploy_dividend_vault.js --network sepolia

const fs = require("fs");
const path = require("path");
const { ethers, network, run } = require("hardhat");

const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments");

async function verify(address, constructorArguments) {
  if (network.name === "localhost" || network.name === "hardhat") return;
  console.log(`Verifying ${address}…`);
  try {
    await run("verify:verify", { address, constructorArguments });
  } catch (e) {
    if (e.message?.toLowerCase().includes("already verified")) {
      console.log("  already verified");
    } else {
      console.warn(`  verification failed: ${e.message}`);
    }
  }
}

async function main() {
  const depFile = path.join(DEPLOYMENTS_DIR, `${network.name}.json`);
  if (!fs.existsSync(depFile)) {
    throw new Error(`No deployment file for ${network.name}. Run deploy.js first.`);
  }
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));

  const usdcAddress = dep.contracts.UsdcToken;
  if (!usdcAddress) throw new Error("UsdcToken not in deployment file — deploy USDC contracts first");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`UsdcToken: ${usdcAddress}`);
  // Deployer is the initial operator; can transfer via setOperator() after.
  const operatorAddress = deployer.address;

  // Skip if already deployed.
  const existing = dep.contracts.AgentDividendVault;
  let vaultAddress;
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    const code = await ethers.provider.getCode(existing);
    if (code !== "0x") {
      console.log(`AgentDividendVault already deployed: ${existing} (skipping)`);
      vaultAddress = existing;
    }
  }
  if (!vaultAddress) {
    const Factory = await ethers.getContractFactory("AgentDividendVault");
    const contract = await Factory.deploy(usdcAddress, operatorAddress);
    await contract.waitForDeployment();
    vaultAddress = await contract.getAddress();
    console.log(`AgentDividendVault deployed: ${vaultAddress}`);
    await verify(vaultAddress, [usdcAddress, operatorAddress]);
  }

  dep.contracts.AgentDividendVault = vaultAddress;
  dep.agentDividendVaultConstructorArgs = { usdc: usdcAddress, operator: operatorAddress };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log(`Updated ${depFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
