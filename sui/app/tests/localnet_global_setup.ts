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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PID_FILE = path.join(__dirname, ".localnet.pid");
export const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");

function suiCliAvailable(): boolean {
  try {
    execFileSync("sui", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  rmSync(CONFIG_PATH, { force: true });
  rmSync(PID_FILE, { force: true });

  if (!suiCliAvailable()) {
    console.log("[localnet] `sui` CLI not found on PATH — skipping localnet setup; profile_signin.spec.ts will skip.");
    return;
  }

  console.log("[localnet] starting `sui start --with-faucet --force-regenesis`…");
  const child = spawn("sui", ["start", "--with-faucet", "--force-regenesis"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RUST_LOG: "off" },
  });
  child.unref();
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));

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
