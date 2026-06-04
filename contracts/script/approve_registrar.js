// Approve the PlayerSubnameRegistrar as an operator on the ENS NameWrapper.
// Must be called by the deployer (who owns chaingammon.eth) after every
// registrar redeployment.
//
// Usage:
//   pnpm exec hardhat run script/approve_registrar.js --network sepolia

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const NAME_WRAPPER_ABI = [
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) external view returns (bool)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Approving as deployer ${deployer.address} on ${network.name}`);

  const deploymentPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const registrarAddr = deployment.contracts?.PlayerSubnameRegistrar;
  const nameWrapperAddr = deployment.contracts?.NameWrapper;

  console.log(`PlayerSubnameRegistrar: ${registrarAddr}`);
  console.log(`NameWrapper:            ${nameWrapperAddr}`);

  const nameWrapper = new ethers.Contract(nameWrapperAddr, NAME_WRAPPER_ABI, deployer);

  const already = await nameWrapper.isApprovedForAll(deployer.address, registrarAddr);
  if (already) {
    console.log("Already approved — nothing to do.");
    return;
  }

  console.log("Setting approval…");
  const tx = await nameWrapper.setApprovalForAll(registrarAddr, true);
  await tx.wait();
  console.log(`Approved (tx ${tx.hash})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
