// Deploy MatchEscrowUsdc and AgentVaultToken to the configured network.
// Reads existing addresses (AgentRegistry, UsdcToken, MatchRegistry) from
// deployments/<network>.json. Writes the new addresses back to the same file.
//
// Usage:
//   pnpm exec hardhat run script/deploy_usdc_contracts.js --network sepolia

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
  const registryAddress = dep.contracts.AgentRegistry;
  const settlerAddress = dep.contracts.MatchRegistry;
  if (!usdcAddress) throw new Error("UsdcToken not in deployment file");
  if (!registryAddress) throw new Error("AgentRegistry not in deployment file");
  if (!settlerAddress) throw new Error("MatchRegistry not in deployment file");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`UsdcToken:     ${usdcAddress}`);
  console.log(`AgentRegistry: ${registryAddress}`);
  console.log(`MatchRegistry (settler): ${settlerAddress}`);

  // ── MatchEscrowUsdc ──────────────────────────────────────────────────────
  const existing = dep.contracts.MatchEscrowUsdc;
  let escrowAddress;
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    const code = await ethers.provider.getCode(existing);
    if (code !== "0x") {
      console.log(`MatchEscrowUsdc already deployed: ${existing} (skipping)`);
      escrowAddress = existing;
    }
  }
  if (!escrowAddress) {
    const Factory = await ethers.getContractFactory("MatchEscrowUsdc");
    const contract = await Factory.deploy(usdcAddress, settlerAddress);
    await contract.waitForDeployment();
    escrowAddress = await contract.getAddress();
    console.log(`MatchEscrowUsdc deployed: ${escrowAddress}`);
    await verify(escrowAddress, [usdcAddress, settlerAddress]);
  }

  // ── AgentVaultToken ──────────────────────────────────────────────────────
  const existingVT = dep.contracts.AgentVaultToken;
  let vaultTokenAddress;
  if (existingVT && existingVT !== "0x0000000000000000000000000000000000000000") {
    const code = await ethers.provider.getCode(existingVT);
    if (code !== "0x") {
      console.log(`AgentVaultToken already deployed: ${existingVT} (skipping)`);
      vaultTokenAddress = existingVT;
    }
  }
  if (!vaultTokenAddress) {
    const Factory = await ethers.getContractFactory("AgentVaultToken");
    const contract = await Factory.deploy(registryAddress, usdcAddress);
    await contract.waitForDeployment();
    vaultTokenAddress = await contract.getAddress();
    console.log(`AgentVaultToken deployed: ${vaultTokenAddress}`);
    await verify(vaultTokenAddress, [registryAddress, usdcAddress]);
  }

  // ── Write back ────────────────────────────────────────────────────────────
  dep.contracts.MatchEscrowUsdc = escrowAddress;
  dep.contracts.AgentVaultToken = vaultTokenAddress;
  dep.matchEscrowUsdcConstructorArgs = { token: usdcAddress, settler: settlerAddress };
  dep.agentVaultTokenConstructorArgs = { registry: registryAddress, token: usdcAddress };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log(`Updated ${depFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
