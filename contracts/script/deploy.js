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

// Initial baseWeightsHash for the AgentRegistry constructor.
// Phase 8 pinned the encrypted-gnubg-weights blob on 0G Storage; future
// deploys (e.g. on a fresh network) should pass the same hash here so
// every minted agent's dataHashes[0] points at it from the start, and the
// owner doesn't have to do a follow-up setBaseWeightsHash() call.
//
// Override per-deploy via INITIAL_BASE_WEIGHTS_HASH env var. Defaults to
// the 0G testnet blob produced by `server/scripts/upload_base_weights.py`
// on 2026-04-27. Pass `0x` + 64 zeros on a network with no upload yet —
// owner can call setBaseWeightsHash later.
const DEFAULT_BASE_WEIGHTS_HASH =
  "0x989ba07766cc35aa0011cf3f764831d9d1a7e11495db78c310d764b4478409ad";
const INITIAL_BASE_WEIGHTS_HASH =
  process.env.INITIAL_BASE_WEIGHTS_HASH || DEFAULT_BASE_WEIGHTS_HASH;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on network ${network.name}`);

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();
  await matchRegistry.waitForDeployment();
  const matchAddr = await matchRegistry.getAddress();
  console.log(`MatchRegistry deployed: ${matchAddr}`);

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(matchAddr, INITIAL_BASE_WEIGHTS_HASH);
  await agentRegistry.waitForDeployment();
  const agentAddr = await agentRegistry.getAddress();
  console.log(`AgentRegistry deployed: ${agentAddr} (initial baseWeightsHash ${INITIAL_BASE_WEIGHTS_HASH})`);

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
      initialBaseWeightsHash: INITIAL_BASE_WEIGHTS_HASH,
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
