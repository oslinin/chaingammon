// Deploys MatchRegistry + AgentRegistry + PlayerSubnameRegistrar + MatchEscrow
// to the configured network and mints the seed gnubg-default agent. Writes
// addresses to deployments/<network>.json.
//
// Idempotent: if a contract address is already recorded in the deployments
// JSON *and* has live bytecode at that address, the deploy step is skipped
// and the existing instance is reused. Only missing or dead contracts are
// (re)deployed. Post-deploy wiring (setMatchEscrow, seed agent mint) is
// similarly gated so re-runs are safe.
//
// Usage:
//   pnpm exec hardhat run script/deploy.js --network sepolia
//   pnpm exec hardhat run script/deploy.js --network 0g-testnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const SEED_AGENT_METADATA = "ipfs://gnubg-default-placeholder";
const SEED_AGENT_TIER = 2; // 0=beginner, 1=intermediate, 2=advanced, 3=world-class

// ENS namehash of "chaingammon.eth". Pinned at construction so the
// PlayerSubnameRegistrar can derive subname namehashes deterministically.
// On a chain with no real ENS root (e.g. 0G testnet), this acts as a
// project-scoped namespace; on Sepolia/Linea with real ENS, the parent
// would be the actual chaingammon.eth name. Override via
// ENS_PARENT_NODE env var if you've registered a different parent.
function namehash(name) {
  let node = "0x" + "00".repeat(32);
  if (name) {
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = ethers.keccak256(ethers.toUtf8Bytes(labels[i]));
      node = ethers.keccak256(ethers.concat([node, labelHash]));
    }
  }
  return node;
}
const DEFAULT_ENS_PARENT_NODE = namehash("chaingammon.eth");
const ENS_PARENT_NODE = process.env.ENS_PARENT_NODE || DEFAULT_ENS_PARENT_NODE;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load existing deployments JSON for this network, or return null. */
function loadExisting(outPath) {
  try {
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Deploy a contract only if it isn't already live at the saved address.
 *
 * @param {string}   name           Contract name (key in deployments.contracts)
 * @param {object}   factory        Hardhat ContractFactory
 * @param {any[]}    args           Constructor arguments
 * @param {object|null} existing    Parsed deployments JSON (or null)
 * @returns {{ contract, address, fresh }}
 *   fresh=true  → newly deployed this run
 *   fresh=false → reused existing instance
 */
async function deployOrReuse(name, factory, args, existing) {
  const savedAddr = existing?.contracts?.[name];
  if (savedAddr) {
    const code = await ethers.provider.getCode(savedAddr);
    if (code !== "0x") {
      console.log(`${name}: reusing ${savedAddr}`);
      return { contract: factory.attach(savedAddr), address: savedAddr, fresh: false };
    }
    console.log(`${name}: saved address ${savedAddr} has no bytecode — redeploying`);
  }
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`${name}: deployed ${address}`);
  return { contract, address, fresh: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}  deployer: ${deployer.address}`);

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${network.name}.json`);
  const existing = loadExisting(outPath);

  if (existing) {
    console.log(`Found existing deployments at ${outPath} — will reuse live contracts`);
  }

  // Capture block number before the first possible deploy tx. If everything
  // is reused this ends up being the current head, which is fine — it's used
  // as fromBlock for event log scans and a slightly higher value is safe.
  const deployedBlock = existing?.deployedBlock ?? await ethers.provider.getBlockNumber();

  // ── MatchRegistry ──────────────────────────────────────────────────────────
  const MatchRegistryFactory = await ethers.getContractFactory("MatchRegistry");
  const { contract: matchRegistry, address: matchAddr, fresh: matchFresh } =
    await deployOrReuse("MatchRegistry", MatchRegistryFactory, [], existing);

  // ── MockOgStorage (localhost/hardhat only) ─────────────────────────────────
  let mockOgStorageAddr;
  if (network.name === "localhost" || network.name === "hardhat") {
    const MockOgStorageFactory = await ethers.getContractFactory("MockOgStorage");
    const { address } = await deployOrReuse("MockOgStorage", MockOgStorageFactory, [], existing);
    mockOgStorageAddr = address;
  }

  // ── AgentRegistry ──────────────────────────────────────────────────────────
  const AgentRegistryFactory = await ethers.getContractFactory("AgentRegistry");
  const { contract: agentRegistry, address: agentAddr } =
    await deployOrReuse("AgentRegistry", AgentRegistryFactory,
      [matchAddr, INITIAL_BASE_WEIGHTS_HASH], existing);

  // ── Seed agent — mint only if none exist yet ───────────────────────────────
  const agentCount = await agentRegistry.agentCount();
  if (agentCount === 0n) {
    const tx = await agentRegistry.mintAgent(deployer.address, SEED_AGENT_METADATA, SEED_AGENT_TIER);
    const receipt = await tx.wait();
    console.log(`Seed agent #1 minted to ${deployer.address} (tx ${receipt.hash})`);
  } else {
    console.log(`AgentRegistry: ${agentCount} agent(s) already minted — skipping seed`);
  }

  // ── PlayerSubnameRegistrar ─────────────────────────────────────────────────
  const RegistrarFactory = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const { address: registrarAddr } =
    await deployOrReuse("PlayerSubnameRegistrar", RegistrarFactory,
      [ENS_PARENT_NODE], existing);

  // ── MatchEscrow ────────────────────────────────────────────────────────────
  const MatchEscrowFactory = await ethers.getContractFactory("MatchEscrow");
  const { contract: escrow, address: escrowAddr } =
    await deployOrReuse("MatchEscrow", MatchEscrowFactory, [matchAddr], existing);

  // ── Wire MatchRegistry → MatchEscrow (idempotent setter) ──────────────────
  const currentEscrow = await matchRegistry.matchEscrow();
  if (currentEscrow.toLowerCase() !== escrowAddr.toLowerCase()) {
    const wireTx = await matchRegistry.setMatchEscrow(escrowAddr);
    await wireTx.wait();
    console.log(`MatchRegistry.setMatchEscrow(${escrowAddr}) → tx ${wireTx.hash}`);
  } else {
    console.log(`MatchRegistry: matchEscrow already set to ${escrowAddr} — skipping`);
  }

  // ── Write deployments JSON ─────────────────────────────────────────────────
  const out = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployer: deployer.address,
    contracts: {
      MatchRegistry: matchAddr,
      AgentRegistry: agentAddr,
      PlayerSubnameRegistrar: registrarAddr,
      MatchEscrow: escrowAddr,
      ...(mockOgStorageAddr ? { MockOgStorage: mockOgStorageAddr } : {}),
    },
    matchEscrowConstructorArgs: {
      settler: matchAddr,
    },
    agentRegistryConstructorArgs: {
      matchRegistry: matchAddr,
      initialBaseWeightsHash: INITIAL_BASE_WEIGHTS_HASH,
    },
    playerSubnameRegistrarConstructorArgs: {
      parentNode: ENS_PARENT_NODE,
    },
    seedAgent: {
      agentId: 1,
      metadataURI: SEED_AGENT_METADATA,
      tier: SEED_AGENT_TIER,
      owner: deployer.address,
    },
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    deployedBlock,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
