// Targeted deploy for PlayerSubnameRegistrar only.
//
// Use this when MatchRegistry + AgentRegistry are already live (and you
// don't want to bump their addresses, which would wipe agent state) but
// the registrar hasn't been deployed yet, or needs to be re-deployed.
// Reads the existing deployments/<network>.json, deploys only the
// PlayerSubnameRegistrar, then merges the new address back into the JSON
// without touching MatchRegistry/AgentRegistry/seedAgent fields.
//
// Usage:
//   pnpm exec hardhat run script/deploy_registrar.js --network 0g-testnet

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

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

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on network ${network.name}`);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const deploymentPath = path.join(deploymentsDir, `${network.name}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `No existing deployment file at ${deploymentPath}. Run deploy.js first to seed it.`,
    );
  }
  const existing = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const PlayerSubnameRegistrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const registrar = await PlayerSubnameRegistrar.deploy(ENS_PARENT_NODE);
  await registrar.waitForDeployment();
  const registrarAddr = await registrar.getAddress();
  console.log(
    `PlayerSubnameRegistrar deployed: ${registrarAddr} (parent node ${ENS_PARENT_NODE})`,
  );

  const merged = {
    ...existing,
    contracts: {
      ...existing.contracts,
      PlayerSubnameRegistrar: registrarAddr,
    },
    playerSubnameRegistrarConstructorArgs: {
      parentNode: ENS_PARENT_NODE,
    },
    registrarDeployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(deploymentPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${deploymentPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
