// Calls setMatchEscrow on a deployed MatchRegistry. Use after a
// MatchEscrow redeploy to point the registry's atomic-payout path at
// the new escrow.
//
// Usage:
//   MATCH_REGISTRY=0x... MATCH_ESCROW=0x... pnpm exec hardhat run script/set_match_escrow.js --network sepolia

const { ethers, network } = require("hardhat");

async function main() {
  const matchRegistryInput = process.env.MATCH_REGISTRY;
  const matchEscrowInput = process.env.MATCH_ESCROW;
  if (!matchRegistryInput) throw new Error("MATCH_REGISTRY env var required");
  if (!matchEscrowInput) throw new Error("MATCH_ESCROW env var required");

  const matchRegistryAddr = ethers.getAddress(matchRegistryInput);
  const matchEscrowAddr = ethers.getAddress(matchEscrowInput);

  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Caller:  ${deployer.address}`);
  console.log(`Registry: ${matchRegistryAddr}`);
  console.log(`Escrow:   ${matchEscrowAddr}`);

  const matchRegistry = await ethers.getContractAt("MatchRegistry", matchRegistryAddr);
  const owner = await matchRegistry.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Caller (${deployer.address}) is not owner (${owner})`);
  }

  const tx = await matchRegistry.setMatchEscrow(matchEscrowAddr);
  const receipt = await tx.wait();
  console.log(`setMatchEscrow tx: ${receipt.hash}`);

  const stored = await matchRegistry.matchEscrow();
  if (stored.toLowerCase() !== matchEscrowAddr.toLowerCase()) {
    throw new Error(`matchEscrow readback mismatch: got ${stored}, expected ${matchEscrowAddr}`);
  }
  console.log(`OK — matchEscrow() == ${stored}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
