// Revoke a list of chaingammon.eth subnames owned by a player.
//
// Run this against the EXISTING deployed contract (before any redeployment)
// to clean up test registrations. The deployer key is required because
// revokeSubname is owner-only.
//
// Usage:
//   pnpm exec hardhat run script/revoke_player_subnames.js --network sepolia
//
// Edit LABELS_TO_REVOKE below before running. Do NOT include labels you
// want to keep (e.g. "oleg", "oleg1").

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// ── Edit this list before running ──────────────────────────────────────────
const LABELS_TO_REVOKE = [
  "test-fedd8129",
  "test-50e8d789",
  "test-866fc1ef",
  "test-5218e675",
  "test-148707e3",
  "test-0dcef85d",
];
// ───────────────────────────────────────────────────────────────────────────

const REGISTRAR_ABI = [
  "function revokeSubname(string calldata label) external",
  "function ownerOf(string calldata label) external view returns (address)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Revoking from ${deployer.address} on ${network.name}`);

  const deploymentPath = path.join(
    __dirname, "..", "deployments", `${network.name}.json`
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment file at ${deploymentPath}`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const registrarAddr = deployment.contracts?.PlayerSubnameRegistrar;
  if (!registrarAddr) throw new Error("PlayerSubnameRegistrar not found in deployment");

  console.log(`PlayerSubnameRegistrar: ${registrarAddr}`);
  const registrar = new ethers.Contract(registrarAddr, REGISTRAR_ABI, deployer);

  for (const label of LABELS_TO_REVOKE) {
    const current = await registrar.ownerOf(label).catch(() => ethers.ZeroAddress);
    if (current === ethers.ZeroAddress) {
      console.log(`  ${label}: already unowned, skipping`);
      continue;
    }
    console.log(`  ${label}: owner=${current} — revoking…`);
    try {
      const tx = await registrar.revokeSubname(label);
      await tx.wait();
      console.log(`  ${label}: revoked (tx ${tx.hash})`);
    } catch (e) {
      console.error(`  ${label}: FAILED — ${e.message}`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
