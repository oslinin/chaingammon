#!/usr/bin/env node
// CLI: read a value from 0G KV storage and write raw bytes to stdout.
//
// Usage: node src/kv-get.mjs <key>
//
// Exits non-zero (code 2) with a clear message if the key is not found.
// Exits non-zero (code 1) on all other errors.
//
// See kv-put.mjs for the 0G KV API status and OG_STORAGE_MODE details.

// Redirect console.log to stderr so stdout stays clean for the raw bytes.
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import fs from "fs";

const _KV_MOCK_PATH = process.env.KV_MOCK_PATH ?? "/tmp/chaingammon-kv-mock.json";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const key = process.argv[2];
if (!key) fail("Usage: node src/kv-get.mjs <key>");

async function main() {
  if (process.env.OG_STORAGE_MODE === "localhost") {
    let store = {};
    try {
      store = JSON.parse(fs.readFileSync(_KV_MOCK_PATH, "utf8"));
    } catch {
      fail(
        `KV mock file not found or unreadable (${_KV_MOCK_PATH}). ` +
        "Write a value first with kv-put.mjs.",
        2,
      );
    }
    if (!(key in store)) {
      fail(`Key not found in KV store: ${key}`, 2);
    }
    const buf = Buffer.from(store[key], "base64");
    process.stdout.write(buf);
    return;
  }

  // Testnet — KV not yet exposed by @0gfoundation/0g-ts-sdk v1.2.6.
  fail(
    "0G KV testnet mode is not yet implemented: @0gfoundation/0g-ts-sdk v1.2.6 " +
    "does not export a KV client. Set OG_STORAGE_MODE=localhost to use the " +
    "JSON-file mock for local development and testing.",
  );
}

main().catch((e) => fail(`kv-get error: ${e?.stack || e}`));
