// Deploys MatchRegistry + AgentRegistry + PlayerSubnameRegistrar to the
// configured network and mints the seed gnubg-default agent. Writes
// addresses to deployments/<network>.json.
//
// Usage:
//   pnpm exec hardhat run script/deploy.js --network 0g-testnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const SEED_AGENT_METADATA = "ipfs://gnubg-default-placeholder";
const SEED_AGENT_TIER = 2; // 0=beginner, 1=intermediate, 2=advanced, 3=world-class
// Explicit ENS label so the seed agent's subname is the
// human-readable `gnubg-default-1.backgammon.eth` rather than the
// scheme-stripped `gnubg-default-placeholder`. Picker's auto-play
// branch reads `kind="agent"` + `inft_id="1"` from this subname's
// text records — both written automatically by AgentRegistry.mintAgent
// when a registrar is wired (Commit 0).
const SEED_AGENT_LABEL = "gnubg-default-1";

// ENS namehash of "backgammon.eth". Pinned at construction so the
// PlayerSubnameRegistrar can derive subname namehashes deterministically.
// `backgammon.eth` is intentionally protocol-neutral — chaingammon is one
// stack (gnubg + 0G + drand) but the ENS parent should accept any
// backgammon stack with humans + agents. On a chain with no real ENS root
// (e.g. 0G testnet), this acts as a project-scoped namespace; on
// Sepolia/Linea with real ENS, the parent would be the actual
// backgammon.eth name. Override via ENS_PARENT_NODE env var if you've
// registered a different parent.
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
const DEFAULT_ENS_PARENT_NODE = namehash("backgammon.eth");
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

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on network ${network.name}`);

  const MatchRegistry = await ethers.getContractFactory("MatchRegistry");
  const matchRegistry = await MatchRegistry.deploy();
  await matchRegistry.waitForDeployment();
  const matchAddr = await matchRegistry.getAddress();
  console.log(`MatchRegistry deployed: ${matchAddr}`);

  // Deploy MockOgStorage on localhost/hardhat only — stands in for 0G Storage so a
  // dev can iterate without making any 0G testnet calls (see og-bridge OG_STORAGE_MODE=localhost).
  let mockOgStorageAddr;
  if (network.name === "localhost" || network.name === "hardhat") {
    const MockOgStorage = await ethers.getContractFactory("MockOgStorage");
    const mock = await MockOgStorage.deploy();
    await mock.waitForDeployment();
    mockOgStorageAddr = await mock.getAddress();
    console.log(`MockOgStorage deployed: ${mockOgStorageAddr} (localhost only)`);
  }

  // Order matters: the registrar must exist before AgentRegistry mints
  // the seed agent so the atomic-subname side-effect path is live. After
  // the registrar's authorized-minter allowlist is set up, mintAgent
  // will issue `gnubg-default-1.backgammon.eth` with `kind="agent"` and
  // `inft_id="1"` text records in one transaction (the picker reads
  // both for the autoplay-vs-open-match decision).
  const PlayerSubnameRegistrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const registrar = await PlayerSubnameRegistrar.deploy(ENS_PARENT_NODE);
  await registrar.waitForDeployment();
  const registrarAddr = await registrar.getAddress();
  console.log(
    `PlayerSubnameRegistrar deployed: ${registrarAddr} (parent node ${ENS_PARENT_NODE})`,
  );

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy(matchAddr, INITIAL_BASE_WEIGHTS_HASH);
  await agentRegistry.waitForDeployment();
  const agentAddr = await agentRegistry.getAddress();
  console.log(`AgentRegistry deployed: ${agentAddr} (initial baseWeightsHash ${INITIAL_BASE_WEIGHTS_HASH})`);

  // Wire AgentRegistry as the registrar's authorized minter so the
  // atomic-subname path inside mintAgent works.
  await (await agentRegistry.setSubnameRegistrar(registrarAddr)).wait();
  await (await registrar.setAuthorizedMinter(agentAddr, true)).wait();
  console.log("AgentRegistry ↔ PlayerSubnameRegistrar wired.");

  // Mint with an explicit label so the seed agent's subname is the
  // protocol-standard `gnubg-default-1.backgammon.eth`. Commit 0's
  // 4-arg mintAgent uses `label_` directly when non-empty.
  const tx = await agentRegistry.mintAgent(
    deployer.address,
    SEED_AGENT_METADATA,
    SEED_AGENT_TIER,
    SEED_AGENT_LABEL,
  );
  const receipt = await tx.wait();
  console.log(
    `Seed agent #1 minted to ${deployer.address} at tier ${SEED_AGENT_TIER} ` +
      `(subname ${SEED_AGENT_LABEL}.<parent>, tx ${receipt.hash})`,
  );

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployer: deployer.address,
    contracts: {
      MatchRegistry: matchAddr,
      AgentRegistry: agentAddr,
      PlayerSubnameRegistrar: registrarAddr,
      ...(mockOgStorageAddr ? { MockOgStorage: mockOgStorageAddr } : {}),
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
      ensLabel: SEED_AGENT_LABEL,
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
