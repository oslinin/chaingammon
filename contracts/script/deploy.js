// Deploys MatchRegistry + AgentRegistry to the configured network and mints
// the seed gnubg-default agent. Writes addresses to deployments/<network>.json.
//
// Usage:
//   pnpm exec hardhat run script/deploy.js --network 0g-testnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const SEED_AGENT_METADATA = "ipfs://gnubg-default-placeholder";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on network ${network.name}`);

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();
  await matchRegistry.waitForDeployment();
  const matchAddr = await matchRegistry.getAddress();
  console.log(`MatchRegistry deployed: ${matchAddr}`);

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(matchAddr);
  await agentRegistry.waitForDeployment();
  const agentAddr = await agentRegistry.getAddress();
  console.log(`AgentRegistry deployed: ${agentAddr}`);

  const tx = await agentRegistry.mintAgent(deployer.address, SEED_AGENT_METADATA);
  const receipt = await tx.wait();
  console.log(`Seed agent #1 minted to ${deployer.address} (tx ${receipt.hash})`);

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployer: deployer.address,
    contracts: {
      MatchRegistry: matchAddr,
      AgentRegistry: agentAddr,
    },
    seedAgent: {
      agentId: 1,
      metadataURI: SEED_AGENT_METADATA,
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
