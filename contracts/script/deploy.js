// Deploys MatchRegistry + AgentRegistry to the configured network and mints
// the seed gnubg-default agent. Writes addresses to deployments/<network>.json.
//
// Usage:
//   pnpm exec hardhat run script/deploy.js --network 0g-testnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const SEED_AGENT_METADATA = "ipfs://gnubg-default-placeholder";
const SEED_AGENT_TIER = 2; // 0=beginner, 1=intermediate, 2=advanced, 3=world-class

// Phase 8 will replace this with the real 0G Storage hash of the encrypted
// gnubg base weights. For now, a zero hash is fine — owner can call
// setBaseWeightsHash() later to update.
const ZERO_HASH = "0x" + "0".repeat(64);

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on network ${network.name}`);

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();
  await matchRegistry.waitForDeployment();
  const matchAddr = await matchRegistry.getAddress();
  console.log(`MatchRegistry deployed: ${matchAddr}`);

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(matchAddr, ZERO_HASH);
  await agentRegistry.waitForDeployment();
  const agentAddr = await agentRegistry.getAddress();
  console.log(`AgentRegistry deployed: ${agentAddr} (baseWeightsHash placeholder ${ZERO_HASH})`);

  const tx = await agentRegistry.mintAgent(deployer.address, SEED_AGENT_METADATA, SEED_AGENT_TIER);
  const receipt = await tx.wait();
  console.log(`Seed agent #1 minted to ${deployer.address} at tier ${SEED_AGENT_TIER} (tx ${receipt.hash})`);

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployer: deployer.address,
    contracts: {
      MatchRegistry: matchAddr,
      AgentRegistry: agentAddr,
    },
    agentRegistryConstructorArgs: {
      matchRegistry: matchAddr,
      initialBaseWeightsHash: ZERO_HASH,
    },
    seedAgent: {
      agentId: 1,
      metadataURI: SEED_AGENT_METADATA,
      tier: SEED_AGENT_TIER,
      owner: deployer.address,
    },
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
