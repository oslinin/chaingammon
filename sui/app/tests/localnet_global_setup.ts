// localnet_global_setup.ts — Playwright globalSetup for
// playwright.localnet.config.ts (profile_signin.spec.ts only).
//
// Starts a local Sui network, publishes the chaingammon package to it (via
// sui/scripts/publish_localnet.ts), and leaves the resulting
// sui/app/public/localnet-config.json in place for the app + spec to read.
// Gracefully no-ops (leaving no config file) when the `sui` CLI isn't on
// PATH, per the Task 5 plan step's "skip gracefully when the CLI is absent
// — CI installs it" — this sandbox has no local `sui` CLI, so this whole
// spec only actually runs in CI, which does.
//
// globalSetup/globalTeardown run in the same Node process image
// (Playwright does not fork between them), so a plain module-level
// variable would work for handing the child process to teardown — a PID
// file is used instead so this stays robust even if that assumption ever
// changes.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PID_FILE = path.join(__dirname, ".localnet.pid");
export const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");
export const LOG_FILE = path.join(__dirname, ".localnet.log");

function suiCliAvailable(): boolean {
  try {
    execFileSync("sui", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForRpcOrDie(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:9000", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getChainIdentifier", params: [] }),
      });
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Surface `sui start`'s own log so a genuine crash (vs. plain slowness) is
  // diagnosable instead of just "fetch failed" — see LOG_FILE below.
  const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "(no log file)";
  throw new Error(`localnet RPC never became ready after ${timeoutMs}ms (${String(lastErr)}).\n--- sui start log ---\n${log}`);
}

export default async function globalSetup() {
  rmSync(CONFIG_PATH, { force: true });
  rmSync(PID_FILE, { force: true });
  rmSync(LOG_FILE, { force: true });

  if (!suiCliAvailable()) {
    console.log("[localnet] `sui` CLI not found on PATH — skipping localnet setup; profile_signin.spec.ts will skip.");
    return;
  }

  // `sui start --with-faucet` needs a client keystore to exist already (it
  // funds the faucet from the CLI's own known address) — on a machine with
  // no ~/.sui/sui_config/client.yaml yet (any fresh CI runner), starting
  // the network before that config exists fails fast with "Wallet Error:
  // No address found with sufficient coins". Force that one-time config
  // creation first (same throwaway no-op call publish_localnet.ts's
  // buildPackage() also uses, for the same reason on the build side).
  execFileSync("sui", ["client", "active-address"], { stdio: "ignore" });

  console.log("[localnet] starting `sui start --with-faucet --force-regenesis`…");
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn("sui", ["start", "--with-faucet", "--force-regenesis"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, RUST_LOG: "off" },
  });
  child.unref();
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));

  // publish_localnet.ts also waits for RPC readiness itself before
  // publishing, but that failure mode gives no insight into *why* — wait
  // here first (longer budget, with the log attached on failure) so a slow
  // localnet boot vs. a crashed one are distinguishable.
  console.log("[localnet] waiting for RPC to come up…");
  await waitForRpcOrDie(120_000);

  console.log("[localnet] publishing chaingammon package…");
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", path.join(__dirname, "..", "..", "scripts", "publish_localnet.ts")],
    {
      stdio: "inherit",
      env: { ...process.env, LOCALNET_CONFIG_OUT: CONFIG_PATH },
    },
  );

  if (!existsSync(CONFIG_PATH)) {
    throw new Error("publish_localnet.ts did not produce localnet-config.json");
  }
}
