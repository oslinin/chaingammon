// seed_agent_subnames.js
//
// Backfills ENS subnames for existing AgentRegistry agents that were minted
// before the PlayerSubnameRegistrar was wired up.
//
// After the NameWrapper migration the registrar holds no internal storage;
// subname ownership lives in NameWrapper, and reputation/text records (kind,
// inft_id, elo, …) live in the resolver. The kind/inft_id fields are now
// captured in the SubnameMinted event's inftId argument and are not written
// as resolver text records by this script.
//
// What it does:
//   1. Reads deployed addresses from deployments/<network>.json
//   2. Calls AgentRegistry.setSubnameRegistrar(registrarAddr) — wires up the
//      registrar so future mintAgent calls are atomic. (Owner-only, idempotent.)
//   3. For each existing agent (agentCount iterations):
//      a. Derives the label from agentMetadata (mirrors AgentCard.tsx cleaning)
//      b. Checks if a subname is already minted (registrar.ownerOf(label) != 0)
//      c. If not minted: calls registrar.mintSubname(label, agentOwner, agentId)
//
// Usage:
//   pnpm exec hardhat run script/seed_agent_subnames.js --network sepolia
//
// Prereqs: contracts/.env must have DEPLOYER_PRIVATE_KEY set.

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const AGENT_REGISTRY_ABI = [
  "function agentCount() view returns (uint256)",
  "function agentMetadata(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function subnameRegistrar() view returns (address)",
  "function setSubnameRegistrar(address registrar_) external",
];

const PLAYER_SUBNAME_REGISTRAR_ABI = [
  "function ownerOf(string label) view returns (address)",
  "function mintSubname(string label, address subnameOwner_, uint256 inftId) external returns (bytes32 node)",
];

/** Mirror of AgentRegistry._cleanLabel and AgentCard.tsx cleanedLabel logic. */
function cleanLabel(metadataUri) {
  let label = metadataUri.replace(/^[^:]+:\/\//, "");
  label = label.replaceAll("/", "-");
  return label;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Running on network: ${network.name} (deployer: ${deployer.address})`);

  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file found at ${deploymentsPath}`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const agentRegistryAddr = deployments.contracts.AgentRegistry;
  const registrarAddr = deployments.contracts.PlayerSubnameRegistrar;

  if (!agentRegistryAddr || !registrarAddr) {
    throw new Error(
      "Missing AgentRegistry or PlayerSubnameRegistrar in deployments JSON"
    );
  }

  console.log(`AgentRegistry:           ${agentRegistryAddr}`);
  console.log(`PlayerSubnameRegistrar:  ${registrarAddr}`);

  const agentRegistry = new ethers.Contract(agentRegistryAddr, AGENT_REGISTRY_ABI, deployer);
  const registrar = new ethers.Contract(registrarAddr, PLAYER_SUBNAME_REGISTRAR_ABI, deployer);

  // --- Step 1: Wire AgentRegistry → PlayerSubnameRegistrar if not already set ---
  const currentRegistrar = await agentRegistry.subnameRegistrar();
  if (currentRegistrar.toLowerCase() === registrarAddr.toLowerCase()) {
    console.log(`\nsubnameRegistrar already set to ${registrarAddr} — skipping setSubnameRegistrar`);
  } else {
    console.log(`\nCalling AgentRegistry.setSubnameRegistrar(${registrarAddr})...`);
    const tx = await agentRegistry.setSubnameRegistrar(registrarAddr);
    const receipt = await tx.wait();
    console.log(`  ✓ tx: ${receipt.hash}`);
  }

  // --- Step 2: Backfill subnames for all existing agents ---
  const agentCount = Number(await agentRegistry.agentCount());
  console.log(`\nFound ${agentCount} agent(s) in AgentRegistry`);

  for (let agentId = 1; agentId <= agentCount; agentId++) {
    console.log(`\n--- Agent #${agentId} ---`);

    const metadataUri = await agentRegistry.agentMetadata(agentId);
    const agentOwner = await agentRegistry.ownerOf(agentId);
    const label = cleanLabel(metadataUri);

    console.log(`  metadataURI : ${metadataUri}`);
    console.log(`  label       : ${label}`);
    console.log(`  owner       : ${agentOwner}`);

    let subnameOwner;
    try {
      subnameOwner = await registrar.ownerOf(label);
    } catch {
      subnameOwner = ethers.ZeroAddress;
    }

    if (subnameOwner === ethers.ZeroAddress) {
      console.log(`  Minting subname "${label}.chaingammon.eth" → owner ${agentOwner}, inftId ${agentId}...`);
      const mintTx = await registrar.mintSubname(label, agentOwner, agentId);
      const mintReceipt = await mintTx.wait();
      console.log(`  ✓ mintSubname tx: ${mintReceipt.hash}`);
    } else {
      console.log(`  Subname already minted (owner: ${subnameOwner})`);
    }
  }

  console.log(`\n✓ Done. All ${agentCount} agent subname(s) are now registered on PlayerSubnameRegistrar.`);
  console.log(`  Future agents minted via AgentRegistry.mintAgent will be registered atomically.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
