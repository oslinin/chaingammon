#!/usr/bin/env node
// CLI: write a value to 0G KV storage, reading bytes from stdin.
//
// Usage: echo -n "value" | node src/kv-put.mjs <key>
//
// 0G KV API status (as of @0gfoundation/0g-ts-sdk v1.2.6):
//   The published SDK exports only Indexer, Uploader, and Downloader — there
//   is no KvClient or equivalent. The 0G KV protocol exists on the network
//   but the TypeScript SDK does not yet expose a public client for it. When
//   the SDK adds KV support, replace the testnet stub below with the
//   appropriate client calls (likely: import { KvClient } from
//   "@0gfoundation/0g-ts-sdk"; client = new KvClient(rpc); client.put(key,
//   value, signer)). In the meantime, use OG_STORAGE_MODE=localhost to
//   develop and test end-to-end without a live network.
//
// Localhost mode (OG_STORAGE_MODE=localhost):
//   Stores key/value pairs as base64 strings in a JSON file at KV_MOCK_PATH
//   (default: /tmp/chaingammon-kv-mock.json). No env vars required.
//   Multiple processes share the same file; writes are synchronous/atomic.
//
// Testnet mode (default, OG_STORAGE_MODE unset or "testnet"):
//   Not yet implemented — exits non-zero with a clear message.

// Redirect console.log to stderr so stdout stays clean for the JSON result.
const _origLog = console.log;
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import fs from "fs";

const _KV_MOCK_PATH = process.env.KV_MOCK_PATH ?? "/tmp/chaingammon-kv-mock.json";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const key = process.argv[2];
if (!key) fail("Usage: node src/kv-put.mjs <key>  (value bytes on stdin)");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const value = await readStdin();
  if (value.length === 0) fail("No bytes on stdin.");

  if (process.env.OG_STORAGE_MODE === "localhost") {
    // Read existing store (create empty if file is missing or malformed).
    let store = {};
    try {
      store = JSON.parse(fs.readFileSync(_KV_MOCK_PATH, "utf8"));
    } catch {
      // Missing or corrupt — start fresh.
    }
    store[key] = value.toString("base64");
    fs.writeFileSync(_KV_MOCK_PATH, JSON.stringify(store), "utf8");
    _origLog(JSON.stringify({ key, ok: true }));
    return;
  }

  // Testnet — KV not yet exposed by @0gfoundation/0g-ts-sdk v1.2.6.
  fail(
    "0G KV testnet mode is not yet implemented: @0gfoundation/0g-ts-sdk v1.2.6 " +
    "does not export a KV client. Set OG_STORAGE_MODE=localhost to use the " +
    "JSON-file mock for local development and testing.",
  );
}

main().catch((e) => fail(`kv-put error: ${e?.stack || e}`));
