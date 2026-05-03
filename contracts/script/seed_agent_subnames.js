// seed_agent_subnames.js
//
// Backfills ENS subnames for existing AgentRegistry agents that were minted
// before the PlayerSubnameRegistrar was wired up.
//
// What it does:
//   1. Reads deployed addresses from deployments/<network>.json
//   2. Calls AgentRegistry.setSubnameRegistrar(registrarAddr) — wires up the
//      registrar so future mintAgent calls are atomic. (Owner-only, idempotent.)
//   3. For each existing agent (agentCount iterations):
//      a. Derives the label from agentMetadata (mirrors AgentCard.tsx cleaning)
//      b. Checks if a subname is already minted (ownerOf returns non-zero)
//      c. If not minted: calls PlayerSubnameRegistrar.mintSubname(label, agentOwner)
//         then setText for kind="agent" and inft_id=<id>
//      d. If already minted but missing kind/inft_id: sets the text records only
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
  "function subnameNode(string label) view returns (bytes32)",
  "function ownerOf(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
  "function mintSubname(string label, address subnameOwner_) external returns (bytes32 node)",
  "function setText(bytes32 node, string key, string value) external",
];

/** Mirror of AgentRegistry._cleanLabel and AgentCard.tsx cleanedLabel logic. */
function cleanLabel(metadataUri) {
  // Strip any scheme prefix (e.g. "ipfs://")
  let label = metadataUri.replace(/^[^:]+:\/\//, "");
  // Replace "/" with "-"
  label = label.replaceAll("/", "-");
  return label;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Running on network: ${network.name} (deployer: ${deployer.address})`);

  // Load deployment addresses
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

    // Compute the expected subname node
    const node = await registrar.subnameNode(label);
    console.log(`  node        : ${node}`);

    // Check if subname already minted (ownerOf returns zero address if not)
    let subnameOwner;
    try {
      subnameOwner = await registrar.ownerOf(node);
    } catch {
      subnameOwner = ethers.ZeroAddress;
    }

    if (subnameOwner === ethers.ZeroAddress) {
      console.log(`  Minting subname "${label}.chaingammon.eth" → owner ${agentOwner}...`);
      const mintTx = await registrar.mintSubname(label, agentOwner);
      const mintReceipt = await mintTx.wait();
      console.log(`  ✓ mintSubname tx: ${mintReceipt.hash}`);
    } else {
      console.log(`  Subname already minted (owner: ${subnameOwner})`);
    }

    // Set / verify kind text record
    const existingKind = await registrar.text(node, "kind");
    if (existingKind !== "agent") {
      console.log(`  Setting kind="agent"...`);
      const tx = await registrar.setText(node, "kind", "agent");
      const receipt = await tx.wait();
      console.log(`  ✓ setText(kind) tx: ${receipt.hash}`);
    } else {
      console.log(`  kind already set to "agent"`);
    }

    // Set / verify inft_id text record
    const existingInftId = await registrar.text(node, "inft_id");
    const expectedInftId = String(agentId);
    if (existingInftId !== expectedInftId) {
      console.log(`  Setting inft_id="${expectedInftId}"...`);
      const tx = await registrar.setText(node, "inft_id", expectedInftId);
      const receipt = await tx.wait();
      console.log(`  ✓ setText(inft_id) tx: ${receipt.hash}`);
    } else {
      console.log(`  inft_id already set to "${expectedInftId}"`);
    }
  }

  console.log(`\n✓ Done. All ${agentCount} agent subname(s) are now registered on PlayerSubnameRegistrar.`);
  console.log(`  Future agents minted via AgentRegistry.mintAgent will be registered atomically.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
