// Re-mint subnames on the new PlayerSubnameRegistrar for names that were
// registered on a previous contract deployment.
//
// Reads current ENS NameWrapper ownership to find the rightful owner, then
// calls mintSubname (owner-only) on the new registrar to emit a fresh
// SubnameMinted event so the frontend can discover the name again.
//
// Usage:
//   pnpm exec hardhat run script/remint_subnames.js --network sepolia

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// ── Labels to re-mint ──────────────────────────────────────────────────────
const LABELS_TO_REMINT = ["oleg"];
// ───────────────────────────────────────────────────────────────────────────

const REGISTRAR_ABI = [
  "function mintSubname(string calldata label, address subnameOwner_, uint256 inftId) external returns (bytes32)",
  "function hasClaimed(address) external view returns (bool)",
];

const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 id) external view returns (address)",
];

function labelhash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function namehash(name) {
  let node = ethers.ZeroHash;
  if (name === "") return node;
  const parts = name.split(".").reverse();
  for (const part of parts) {
    node = ethers.keccak256(ethers.concat([node, labelhash(part)]));
  }
  return node;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Re-minting as deployer ${deployer.address} on ${network.name}`);

  const deploymentPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const registrarAddr = deployment.contracts?.PlayerSubnameRegistrar;
  const nameWrapperAddr = deployment.contracts?.NameWrapper;

  console.log(`PlayerSubnameRegistrar: ${registrarAddr}`);
  console.log(`NameWrapper:            ${nameWrapperAddr}`);

  const registrar = new ethers.Contract(registrarAddr, REGISTRAR_ABI, deployer);
  const nameWrapper = new ethers.Contract(nameWrapperAddr, NAME_WRAPPER_ABI, deployer);

  for (const label of LABELS_TO_REMINT) {
    const node = namehash(`${label}.chaingammon.eth`);
    const tokenId = BigInt(node);

    // Look up current ENS owner.
    let owner;
    try {
      owner = await nameWrapper.ownerOf(tokenId);
    } catch {
      console.log(`  ${label}: not found in NameWrapper, skipping`);
      continue;
    }

    if (owner === ethers.ZeroAddress) {
      console.log(`  ${label}: unowned in ENS, skipping`);
      continue;
    }

    // Check if already claimed on new registrar.
    const claimed = await registrar.hasClaimed(owner).catch(() => false);
    if (claimed) {
      console.log(`  ${label}: ${owner} already has a claim on new registrar, skipping`);
      continue;
    }

    console.log(`  ${label}: ENS owner=${owner} — minting on new registrar…`);
    const tx = await registrar.mintSubname(label, owner, 0);
    await tx.wait();
    console.log(`  ${label}: done (tx ${tx.hash})`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
