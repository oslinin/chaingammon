// Redeploys MatchRegistry alone, calls setSettler with the configured
// settler address, and updates deployments/<network>.json's
// contracts.MatchRegistry field while preserving the rest of the file.
//
// Use when the only change is to MatchRegistry (e.g. adding the settler
// role for a hosted orchestrator like KeeperHub) and you don't want to
// re-mint seed agents or reissue ENS subnames.
//
// Usage:
//   SETTLER_ADDRESS=0x... pnpm exec hardhat run script/deploy_matchregistry_only.js --network sepolia
//
// Env vars:
//   DEPLOYER_PRIVATE_KEY — required, owner of the new MatchRegistry.
//   SETTLER_ADDRESS      — optional, granted via setSettler after deploy.
//                          Pass address(0) or omit to skip the setSettler step.

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const settler = process.env.SETTLER_ADDRESS || "";
  const settlerAddr = settler && settler !== ethers.ZeroAddress
    ? ethers.getAddress(settler)
    : null;

  console.log(`Deployer: ${deployer.address} on network ${network.name}`);
  if (settlerAddr) {
    console.log(`Settler to grant: ${settlerAddr}`);
  } else {
    console.log("No SETTLER_ADDRESS — skipping setSettler step.");
  }

  const deployedBlock = await ethers.provider.getBlockNumber();

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();
  await matchRegistry.waitForDeployment();
  const matchAddr = await matchRegistry.getAddress();
  console.log(`MatchRegistry deployed: ${matchAddr} (block ${deployedBlock})`);

  if (settlerAddr) {
    const tx = await matchRegistry.setSettler(settlerAddr);
    const receipt = await tx.wait();
    console.log(`setSettler(${settlerAddr}) → tx ${receipt.hash}`);
    const stored = await matchRegistry.settler();
    if (stored.toLowerCase() !== settlerAddr.toLowerCase()) {
      throw new Error(`settler readback mismatch: got ${stored}, expected ${settlerAddr}`);
    }
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
      MatchRegistry: matchAddr,
    },
    matchRegistrySettler: settlerAddr || null,
    matchRegistryRedeployedAt: new Date().toISOString(),
    matchRegistryRedeployedBlock: deployedBlock,
  };
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`Updated ${outPath}: contracts.MatchRegistry → ${matchAddr}`);

  console.log("");
  console.log("Reminder: MatchEscrow.settler is immutable and still points at the OLD");
  console.log("MatchRegistry. The new MatchRegistry's recordMatchAndSplit will revert");
  console.log("with NotSettler from MatchEscrow. recordMatch (no payout) works as expected.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
