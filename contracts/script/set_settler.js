// Calls setSettler on a deployed MatchRegistry. Use after a redeploy if
// the original deploy script crashed mid-way, or to rotate the settler.
//
// Usage:
//   MATCH_REGISTRY=0x... SETTLER_ADDRESS=0x... pnpm exec hardhat run script/set_settler.js --network sepolia

const { ethers, network } = require("hardhat");

async function main() {
  const matchRegistryAddr = process.env.MATCH_REGISTRY;
  const settlerInput = process.env.SETTLER_ADDRESS;
  if (!matchRegistryAddr) throw new Error("MATCH_REGISTRY env var required");
  if (!settlerInput) throw new Error("SETTLER_ADDRESS env var required");

  const matchAddr = ethers.getAddress(matchRegistryAddr);
  const settlerAddr = ethers.getAddress(settlerInput);

  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Caller:  ${deployer.address}`);
  console.log(`Target:  ${matchAddr}`);
  console.log(`Settler: ${settlerAddr}`);

  const matchRegistry = await ethers.getContractAt("MatchRegistry", matchAddr);
  const owner = await matchRegistry.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Caller (${deployer.address}) is not owner (${owner})`);
  }

  const tx = await matchRegistry.setSettler(settlerAddr);
  const receipt = await tx.wait();
  console.log(`setSettler tx: ${receipt.hash}`);

  const stored = await matchRegistry.settler();
  if (stored.toLowerCase() !== settlerAddr.toLowerCase()) {
    throw new Error(`settler readback mismatch: got ${stored}, expected ${settlerAddr}`);
  }
  console.log(`OK — settler() == ${stored}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
