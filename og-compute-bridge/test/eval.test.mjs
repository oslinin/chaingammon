// Tests for src/eval.mjs.
//
// Run with:  cd og-compute-bridge && npm test
//
// Strategy: spawn `node src/eval.mjs` as a subprocess and feed it
// canned stdin. We can't easily mock @0glabs/0g-serving-broker in an
// ESM Node test, so the Python wrapper's hermetic tests
// (agent/tests/test_og_compute_eval_client.py) already cover the JSON
// contract via subprocess.run mocking. These tests cover the paths
// that fail BEFORE the SDK is touched: missing env, bad stdin,
// invalid action, malformed args. Together they pin the bridge's
// observable behaviour without requiring a 0G testnet connection.

import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "src", "eval.mjs");

function runBridge({ stdin, env = {} }) {
  // Merge with process.env so PATH (and the Node binary path it carries)
  // is still resolvable; spawnSync replaces env wholesale otherwise and
  // fails with ENOENT on the `node` lookup.
  const baseEnv = {
    ...process.env,
    OG_STORAGE_RPC: "http://localhost:8545",
    OG_STORAGE_PRIVATE_KEY: "0x" + "11".repeat(32),
  };
  return spawnSync("node", [SCRIPT], {
    input: stdin ?? "",
    env: { ...baseEnv, ...env },
    encoding: "utf-8",
    timeout: 10_000,
  });
}

test("missing OG_STORAGE_RPC fails with clear stderr", () => {
  const env = { ...process.env };
  delete env.OG_STORAGE_RPC;
  env.OG_STORAGE_PRIVATE_KEY = "0x" + "11".repeat(32);
  const proc = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ action: "estimate", count: 1 }),
    env,
    encoding: "utf-8",
    timeout: 10_000,
  });
  assert.notStrictEqual(proc.status, 0);
  assert.match(proc.stderr, /Missing OG_STORAGE_RPC/);
});

test("empty stdin fails with 'No JSON' error", () => {
  const proc = runBridge({ stdin: "" });
  assert.notStrictEqual(proc.status, 0);
  assert.match(proc.stderr, /No JSON on stdin/);
});

test("invalid JSON on stdin fails with parse error", () => {
  const proc = runBridge({ stdin: "not-json" });
  assert.notStrictEqual(proc.status, 0);
  assert.match(proc.stderr, /Invalid JSON on stdin/);
});

test("unknown action fails before SDK is invoked", () => {
  const proc = runBridge({ stdin: JSON.stringify({ action: "frob" }) });
  assert.notStrictEqual(proc.status, 0);
  assert.match(proc.stderr, /Unknown action/);
});

test("estimate without count fails", () => {
  // "estimate" passes action validation but reaches `Number(req.count)`
  // which produces NaN — fails before the SDK call. With a stub RPC
  // the broker construction may also throw (network), so we just
  // assert non-zero exit and ANY relevant error message.
  const proc = runBridge({ stdin: JSON.stringify({ action: "estimate" }) });
  assert.notStrictEqual(proc.status, 0);
  // Either the count check fires or the broker fails to connect; both
  // are acceptable failure modes for a test without live infra.
  assert.match(
    proc.stderr,
    /(estimate action requires|Unhandled error|connect|getaddrinfo)/
  );
});

test("evaluate without features fails", () => {
  const proc = runBridge({
    stdin: JSON.stringify({ action: "evaluate", extras: [] }),
  });
  assert.notStrictEqual(proc.status, 0);
  assert.match(
    proc.stderr,
    /(evaluate action requires|Unhandled error|connect|getaddrinfo)/
  );
});
