// localnet_global_setup.ts — Playwright globalSetup for
// playwright.localnet.config.ts (profile_signin.spec.ts, rated_hvh.spec.ts).
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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PID_FILE = path.join(__dirname, ".localnet.pid");
export const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");
export const LOG_FILE = path.join(__dirname, ".localnet.log");

// `sui start --force-regenesis`'s own genesis/faucet bootstrap has proven
// non-deterministic in CI: identical code (`sui client -y active-address`
// run before spawning it) produced "Wallet Error: No address found with
// sufficient coins" on some runs and a clean boot on others, with no
// change in between. Since the underlying race is upstream (inside `sui
// start`, not this script), the robust fix is retrying the whole
// spawn-and-wait sequence rather than chasing a single-shot root cause.
const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 60_000;

function suiCliAvailable(): boolean {
  try {
    execFileSync("sui", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function currentLog(): string {
  return existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "(no log file)";
}

function killProcessGroup(pid: number): void {
  try {
    // Negative pid signals the whole detached process group (`sui start`
    // and anything it spawned), not just the immediate child.
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited — fine.
  }
}

/**
 * Waits for the RPC to answer OR fails fast the moment `sui start`'s own
 * log shows the known-fatal wallet error — no point waiting out the full
 * timeout for a boot that has already crashed.
 */
async function waitForRpcOrFail(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const log = currentLog();
    if (log.includes("No address found with sufficient coins")) {
      throw new Error(`sui start failed to boot (fatal wallet error):\n${log}`);
    }
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
  throw new Error(`localnet RPC never became ready after ${timeoutMs}ms (${String(lastErr)}).\n--- sui start log ---\n${currentLog()}`);
}

async function startLocalnetWithRetries(): Promise<ChildProcess> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    rmSync(LOG_FILE, { force: true });

    // `sui start --with-faucet` needs a client keystore to exist already
    // (it funds the faucet from the CLI's own known address) — on a
    // machine with no ~/.sui/sui_config/client.yaml yet (any fresh CI
    // runner), starting the network before that config exists can fail
    // with the same "Wallet Error: No address found with sufficient
    // coins" this retry loop also guards against. `-y` is the CLI's own
    // documented flag for skipping the first-run "connect to a Full
    // node?" prompt non-interactively. Cheap and idempotent — safe to
    // re-run every attempt.
    execFileSync("sui", ["client", "-y", "active-address"], { stdio: "ignore" });

    console.log(`[localnet] attempt ${attempt}/${MAX_ATTEMPTS}: starting \`sui start --with-faucet --force-regenesis\`…`);
    const logFd = openSync(LOG_FILE, "a");
    const child = spawn("sui", ["start", "--with-faucet", "--force-regenesis"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, RUST_LOG: "off" },
    });
    child.unref();

    try {
      await waitForRpcOrFail(PER_ATTEMPT_TIMEOUT_MS);
      return child;
    } catch (e) {
      lastErr = e;
      console.log(`[localnet] attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (child.pid) killProcessGroup(child.pid);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`sui start never became healthy after ${MAX_ATTEMPTS} attempts. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export default async function globalSetup() {
  rmSync(CONFIG_PATH, { force: true });
  rmSync(PID_FILE, { force: true });
  rmSync(LOG_FILE, { force: true });

  if (!suiCliAvailable()) {
    console.log("[localnet] `sui` CLI not found on PATH — skipping localnet setup; profile_signin.spec.ts/rated_hvh.spec.ts will skip.");
    return;
  }

  console.log("[localnet] waiting for RPC to come up…");
  const child = await startLocalnetWithRetries();
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
