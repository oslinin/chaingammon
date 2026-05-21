// Deploy AgentVault and wire it into the deployment record.
//
// Usage:
//   pnpm exec hardhat run script/deploy_agent_vault.js --network sepolia
//   pnpm exec hardhat run script/deploy_agent_vault.js --network localhost
//
// Reads AgentRegistry address from the existing deployments/<network>.json.
// Writes AgentVault address back to the same file.

const fs = require("fs");
const path = require("path");
const { ethers, network, run } = require("hardhat");

const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments");

async function main() {
  const depFile = path.join(DEPLOYMENTS_DIR, `${network.name}.json`);
  if (!fs.existsSync(depFile)) {
    throw new Error(`No deployment file for network ${network.name}. Run deploy.js first.`);
  }
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const registryAddress = dep.contracts.AgentRegistry;
  if (!registryAddress) throw new Error("AgentRegistry not found in deployment file");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`AgentRegistry: ${registryAddress}`);

  const AgentVault = await ethers.getContractFactory("AgentVault");
  const vault = await AgentVault.deploy(registryAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`AgentVault deployed: ${vaultAddress}`);

  dep.contracts.AgentVault = vaultAddress;
  dep.agentVaultConstructorArgs = { registry: registryAddress };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log(`Updated ${depFile}`);

  if (network.name !== "localhost" && network.name !== "hardhat") {
    console.log("Verifying on Etherscan…");
    try {
      await run("verify:verify", {
        address: vaultAddress,
        constructorArguments: [registryAddress],
      });
    } catch (e) {
      if (e.message?.toLowerCase().includes("already verified")) {
        console.log("Already verified.");
      } else {
        console.warn(`Verification failed: ${e.message}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
