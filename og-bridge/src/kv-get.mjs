#!/usr/bin/env node
// CLI: fetch bytes from 0G KV by key and write to stdout.
//
// Usage: node src/kv-get.mjs <key>
//
// 0G SDK status (v1.2.6): @0gfoundation/0g-ts-sdk does not export a KV
// client — it ships only Indexer, Uploader, and Downloader for blob storage.
// KV is available on 0G testnet via the storage node's HTTP REST API:
//   GET {OG_KV_URL}/kv/get?key=<encoded-key>  → JSON: {"value":"<base64>"}
// Reference: https://docs.0g.ai/build-with-0g/storage-sdk/kv-store
// Required env (testnet): OG_KV_URL (e.g. https://kv-rpc.0g.ai)
//
// Localhost mode (OG_STORAGE_MODE=localhost):
//   Reads from /tmp/chaingammon-kv-mock.json (see kv-put.mjs).
//
// Stdout: raw bytes on success.
// Exit 2: key not found.
// Exit 1: any other error.

const key = process.argv[2];
if (!key) {
  process.stderr.write("Usage: node src/kv-get.mjs <key>\n");
  process.exit(1);
}

import fs from "fs";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const MOCK_PATH = "/tmp/chaingammon-kv-mock.json";

async function main() {
  if (process.env.OG_STORAGE_MODE === "localhost") {
    let store;
    try {
      store = JSON.parse(fs.readFileSync(MOCK_PATH, "utf8"));
    } catch {
      // Missing mock file → treat every key as not found.
      fail(`Key not found: ${key}`, 2);
    }
    if (!(key in store)) {
      fail(`Key not found: ${key}`, 2);
    }
    const buf = Buffer.from(store[key], "base64");
    process.stdout.write(buf);
    return;
  }

  // Testnet path — GET from 0G KV REST endpoint.
  const KV_URL = process.env.OG_KV_URL;
  if (!KV_URL) {
    fail("Missing OG_KV_URL in env (required for testnet KV reads).");
  }

  const url = `${KV_URL}/kv/get?key=${encodeURIComponent(key)}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    fail(`KV GET network error: ${e?.message ?? e}`);
  }

  if (resp.status === 404) {
    fail(`Key not found: ${key}`, 2);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    fail(`KV GET failed (HTTP ${resp.status}): ${text}`);
  }

  let payload;
  try {
    payload = await resp.json();
  } catch (e) {
    fail(`KV GET returned non-JSON: ${e?.message ?? e}`);
  }

  if (!payload?.value) {
    fail(`Key not found: ${key}`, 2);
  }

  const buf = Buffer.from(payload.value, "base64");
  process.stdout.write(buf);
}

main().catch((e) => fail(`kv-get error: ${e?.stack || e}`));
