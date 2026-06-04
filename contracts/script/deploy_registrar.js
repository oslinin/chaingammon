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
const { ethers, network, run } = require("hardhat");

async function verifyContract(address, constructorArguments = []) {
  if (network.name === "localhost" || network.name === "hardhat") return;
  console.log(`Verifying ${address} on Etherscan…`);
  try {
    await run("verify:verify", { address, constructorArguments });
  } catch (e) {
    if (e.message?.toLowerCase().includes("already verified")) {
      console.log(`  already verified`);
    } else {
      console.warn(`  verification failed: ${e.message}`);
    }
  }
}

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

  const nameWrapperAddr = existing.contracts?.NameWrapper;
  const resolverAddr = existing.contracts?.PublicResolver;
  if (!nameWrapperAddr) throw new Error("NameWrapper address missing from deployment JSON");
  if (!resolverAddr) throw new Error("PublicResolver address missing from deployment JSON");

  const PlayerSubnameRegistrar = await ethers.getContractFactory("PlayerSubnameRegistrar");
  const registrar = await PlayerSubnameRegistrar.deploy(
    ENS_PARENT_NODE,
    nameWrapperAddr,
    resolverAddr,
  );
  await registrar.waitForDeployment();
  const registrarAddr = await registrar.getAddress();
  console.log(
    `PlayerSubnameRegistrar deployed: ${registrarAddr} (parent node ${ENS_PARENT_NODE})`,
  );
  console.log(`  NameWrapper: ${nameWrapperAddr}`);
  console.log(`  PublicResolver: ${resolverAddr}`);
  console.log(`NOTE: approve the new registrar in ENS NameWrapper:`);
  console.log(`  nameWrapper.setApprovalForAll("${registrarAddr}", true)`);
  await verifyContract(registrarAddr, [ENS_PARENT_NODE, nameWrapperAddr, resolverAddr]);

  const merged = {
    ...existing,
    contracts: {
      ...existing.contracts,
      PlayerSubnameRegistrar: registrarAddr,
    },
    playerSubnameRegistrarConstructorArgs: {
      parentNode: ENS_PARENT_NODE,
      nameWrapper: nameWrapperAddr,
      resolver: resolverAddr,
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
