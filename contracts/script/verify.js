// Verifies all contracts listed in deployments/<network>.json against
// the configured block explorer. Idempotent — already-verified contracts
// just log "Already Verified" and the script keeps going.
//
// Usage:
//   pnpm exec hardhat run script/verify.js --network 0g-testnet
//
// Constructor args per contract are listed below. Update this map when
// new contracts are added to the deploy.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment file at ${deploymentPath}. Run deploy.js first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  // Constructor arguments per contract. Keys must match deployment.contracts.
  // For AgentRegistry / PlayerSubnameRegistrar, we read the exact args used
  // at deploy time from the deployment JSON so verify always matches what
  // was actually deployed.
  const agentArgs = deployment.agentRegistryConstructorArgs;
  const registrarArgs = deployment.playerSubnameRegistrarConstructorArgs;
  const escrowArgs = deployment.matchEscrowConstructorArgs;
  const constructorArgs = {
    MatchRegistry: [],
    AgentRegistry: agentArgs
      ? [agentArgs.matchRegistry, agentArgs.initialBaseWeightsHash]
      : [deployment.contracts.MatchRegistry], // legacy fallback for older deployments
    PlayerSubnameRegistrar: registrarArgs ? [registrarArgs.parentNode] : undefined,
    MatchEscrow: escrowArgs
      ? [escrowArgs.settler]
      : [deployment.contracts.MatchRegistry], // legacy fallback: settler defaults to MatchRegistry
  };

  for (const [name, address] of Object.entries(deployment.contracts)) {
    const args = constructorArgs[name];
    if (args === undefined) {
      console.log(`Skipping ${name} @ ${address} — no constructor args entry in verify.js`);
      continue;
    }
    console.log(`Verifying ${name} @ ${address} on ${network} ...`);
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: args,
      });
      console.log(`  ✓ ${name} verified`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msg.toLowerCase().includes("already verified")) {
        console.log(`  ✓ ${name} already verified`);
      } else {
        console.error(`  ✗ ${name} verification failed:`);
        console.error(`    ${msg}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
