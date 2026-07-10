// publish_localnet.ts — publish the chaingammon Move package to a already-
// running local Sui network (`sui start --with-faucet --force-regenesis`)
// and write out the resulting package id + well-known shared object ids as
// JSON, so a Playwright globalSetup (or any other test harness) can hand
// them to the app under test without an env-var rebuild.
//
// Deliberately does NOT use `sui client publish` (which depends on the
// CLI's own keystore/env config, awkward to seed non-interactively in CI).
// Instead: `sui move build --dump-bytecode-as-base64` compiles the package
// and prints {modules, dependencies} as JSON (no client config needed for
// this step), then this script signs and submits the publish transaction
// itself with a throwaway Ed25519Keypair funded from the localnet faucet —
// fully self-contained, no `sui client` state required at all.
//
// Run: node --experimental-strip-types sui/scripts/publish_localnet.ts
// Prerequisite: `sui start --with-faucet --force-regenesis` already running
// and reachable at RPC_URL/FAUCET_URL below (see tests/localnet.ts, which
// spawns it and calls this script).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVE_PACKAGE_DIR = path.join(__dirname, "..", "move", "chaingammon");

const RPC_URL = process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl("localnet");
const FAUCET_URL = process.env.SUI_FAUCET_URL ?? getFaucetHost("localnet");
const OUT_PATH = process.env.LOCALNET_CONFIG_OUT
  ?? path.join(__dirname, "..", "app", "public", "localnet-config.json");

interface BuildOutput {
  modules: string[];
  dependencies: string[];
}

// On a machine with no ~/.sui/sui_config/client.yaml yet (e.g. a fresh CI
// runner), the FIRST `sui client` invocation of any kind prints an
// interactive "Config file ... doesn't exist, do you want to connect to a
// Sui Full node server? [y/N]" prompt before doing anything else. We never
// touch this generated client identity — publishing below signs with its
// own throwaway keypair via the TS SDK — but that prompt text would
// otherwise corrupt the `--dump-bytecode-as-base64` JSON output, and
// relying on stdin EOF (non-tty `stdio:"ignore"`) to implicitly answer it
// proved flaky in CI (sometimes produced a config with no funded address,
// intermittently breaking `sui start --with-faucet`, which funds whichever
// address this config's keystore holds). `-y` is the CLI's own documented
// flag for skipping first-run prompts non-interactively — deterministic,
// unlike relying on stdin behavior.
function ensureSuiConfigExists(): void {
  execFileSync("sui", ["client", "-y", "active-address"], { stdio: "ignore" });
}

function buildPackage(): BuildOutput {
  ensureSuiConfigExists();
  const raw = execFileSync(
    "sui",
    ["move", "build", "--dump-bytecode-as-base64", "-p", MOVE_PACKAGE_DIR],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw) as BuildOutput;
}

async function waitForRpc(client: SuiJsonRpcClient, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await client.getChainIdentifier();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`localnet RPC at ${RPC_URL} not ready after ${timeoutMs}ms: ${String(lastErr)}`);
}

async function main() {
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  await waitForRpc(client);

  const deployer = Ed25519Keypair.generate();
  const deployerAddress = deployer.getPublicKey().toSuiAddress();

  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: deployerAddress });
  // Faucet funds land asynchronously — poll briefly for a spendable balance
  // rather than a fixed sleep.
  {
    const deadline = Date.now() + 30_000;
    let balance = 0n;
    while (Date.now() < deadline) {
      const res = await client.getBalance({ owner: deployerAddress });
      balance = BigInt(res.totalBalance);
      if (balance > 0n) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (balance === 0n) throw new Error(`faucet funding for ${deployerAddress} never arrived`);
  }

  const { modules, dependencies } = buildPackage();

  const tx = new Transaction();
  tx.setSender(deployerAddress);
  const upgradeCap = tx.publish({ modules, dependencies });
  tx.transferObjects([upgradeCap], deployerAddress);

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: deployer,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.waitForTransaction({ digest: result.digest });

  const changes = result.objectChanges ?? [];
  const published = changes.find((c) => c.type === "published") as
    | { type: "published"; packageId: string }
    | undefined;
  if (!published) {
    throw new Error(`no "published" object change in publish tx ${result.digest} — dump: ${JSON.stringify(changes)}`);
  }
  const packageId = published.packageId;

  const registryChange = changes.find(
    (c) => c.type === "created" && "objectType" in c && c.objectType === `${packageId}::profile::ProfileRegistry`,
  ) as { type: "created"; objectId: string } | undefined;
  if (!registryChange) {
    throw new Error(`no profile::ProfileRegistry found in publish tx ${result.digest} — dump: ${JSON.stringify(changes)}`);
  }

  const config = {
    rpcUrl: RPC_URL,
    faucetUrl: FAUCET_URL,
    packageId,
    profileRegistryId: registryChange.objectId,
    deployerAddress,
  };
  writeFileSync(OUT_PATH, JSON.stringify(config, null, 2));
  console.log(`Published chaingammon package ${packageId} to localnet; wrote ${OUT_PATH}`);
  console.log(JSON.stringify(config, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
