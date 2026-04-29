/**
 * deploy_tournament.js — Deploy the Tournament ELO contract and write
 * the address + ABI to deployments/0g_testnet.json (repo root).
 *
 * Usage:
 *   npx hardhat run contracts/script/deploy_tournament.js --network hardhat
 *   npx hardhat run contracts/script/deploy_tournament.js --network 0g-testnet
 */

const { ethers, artifacts, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying Tournament from ${deployer.address} on network: ${network.name}`);

  const Tournament = await ethers.getContractFactory("Tournament");
  const tournament = await Tournament.deploy();
  await tournament.waitForDeployment();

  const address = await tournament.getAddress();
  console.log(`Tournament deployed to: ${address}`);

  // Fetch the ABI from the compiled artifact.
  const artifact = await artifacts.readArtifact("Tournament");

  // Write deployment record.
  // File name matches what backgammon/og/chain.py expects.
  const deploymentsDir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const outFile = path.join(deploymentsDir, "0g_testnet.json");

  // Preserve any existing entries (e.g. other contracts).
  let existing = {};
  if (fs.existsSync(outFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
    } catch (_) {}
  }

  existing.Tournament = {
    address,
    network: network.name,
    abi: artifact.abi,
  };

  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));
  console.log(`Deployment written to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
