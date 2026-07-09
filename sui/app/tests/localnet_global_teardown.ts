// localnet_global_teardown.ts — pairs with localnet_global_setup.ts: stops
// the `sui start` process group and removes the generated config so a
// stale localnet-config.json never leaks into a later `pnpm dev`.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const PID_FILE = path.join(__dirname, ".localnet.pid");
const CONFIG_PATH = path.join(__dirname, "..", "public", "localnet-config.json");
const LOG_FILE = path.join(__dirname, ".localnet.log");

export default async function globalTeardown() {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        // Negative pid signals the whole detached process group `sui
        // start` (and any children it spawned) rather than just the
        // immediate child.
        process.kill(-pid, "SIGTERM");
      } catch {
        // Already exited — fine.
      }
    }
    rmSync(PID_FILE, { force: true });
  }
  rmSync(CONFIG_PATH, { force: true });
  rmSync(LOG_FILE, { force: true });
}
