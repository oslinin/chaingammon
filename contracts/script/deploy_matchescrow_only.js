// Redeploys MatchEscrow alone, pointing it at the configured settler
// (typically the current MatchRegistry address). Updates
// deployments/<network>.json's contracts.MatchEscrow field while
// preserving the rest of the file.
//
// Use when MatchRegistry has been redeployed and MatchEscrow's settler
// (which is immutable) needs to point at the new MatchRegistry. The
// old MatchEscrow stays deployed and addressable so anyone with funds
// in it can still refund — it's just disconnected from the new
// MatchRegistry.
//
// Usage:
//   SETTLER_ADDRESS=0x... pnpm exec hardhat run script/deploy_matchescrow_only.js --network sepolia

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const settlerInput = process.env.SETTLER_ADDRESS;
  if (!settlerInput) throw new Error("SETTLER_ADDRESS env var required");
  const settlerAddr = ethers.getAddress(settlerInput);

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address} on network ${network.name}`);
  console.log(`Settler:  ${settlerAddr}`);

  const deployedBlock = await ethers.provider.getBlockNumber();

  const MatchEscrow = await ethers.getContractFactory("MatchEscrow");
  const escrow = await MatchEscrow.deploy(settlerAddr);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`MatchEscrow deployed: ${escrowAddr} (block ${deployedBlock})`);

  // Sanity: read back the settler.
  const stored = await escrow.settler();
  if (stored.toLowerCase() !== settlerAddr.toLowerCase()) {
    throw new Error(`settler readback mismatch: got ${stored}, expected ${settlerAddr}`);
  }

  const outDir = path.join(__dirname, "..", "deployments");
  const outPath = path.join(outDir, `${network.name}.json`);
  if (!fs.existsSync(outPath)) {
    throw new Error(`${outPath} not found — run script/deploy.js first to seed the deployment file.`);
  }
  const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const next = {
    ...prev,
    contracts: {
      ...prev.contracts,
      MatchEscrow: escrowAddr,
    },
    matchEscrowPrevious: prev.contracts.MatchEscrow,
    matchEscrowConstructorArgs: { settler: settlerAddr },
    matchEscrowRedeployedAt: new Date().toISOString(),
    matchEscrowRedeployedBlock: deployedBlock,
  };
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`Updated ${outPath}: contracts.MatchEscrow → ${escrowAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
