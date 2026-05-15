#!/usr/bin/env node
// CLI: write bytes from stdin to 0G KV under a given key.
//
// Usage: cat value.bin | node src/kv-put.mjs <key>
//
// 0G SDK status (v1.2.6): @0gfoundation/0g-ts-sdk does not export a KV
// client — it ships only Indexer, Uploader, and Downloader for blob storage.
// KV is available on 0G testnet via the storage node's HTTP REST API:
//   POST {OG_KV_URL}/kv/put  body JSON: {"key":"…","value":"<base64>"}
// Reference: https://docs.0g.ai/build-with-0g/storage-sdk/kv-store
// Required env (testnet): OG_KV_URL (e.g. https://kv-rpc.0g.ai)
//
// Localhost mode (OG_STORAGE_MODE=localhost):
//   Uses a plain JSON file at /tmp/chaingammon-kv-mock.json so tests never
//   require the live network. The mock is a flat key→base64-value map.
//
// Stdout: single JSON line { "key": "…", "ok": true }

const key = process.argv[2];
if (!key) {
  process.stderr.write("Usage: cat value.bin | node src/kv-put.mjs <key>\n");
  process.exit(1);
}

import fs from "fs";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const MOCK_PATH = "/tmp/chaingammon-kv-mock.json";

function readMock() {
  try {
    return JSON.parse(fs.readFileSync(MOCK_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeMock(store) {
  fs.writeFileSync(MOCK_PATH, JSON.stringify(store), "utf8");
}

async function main() {
  const bytes = await readStdin();
  if (bytes.length === 0) fail("No bytes on stdin.");

  if (process.env.OG_STORAGE_MODE === "localhost") {
    const store = readMock();
    store[key] = bytes.toString("base64");
    writeMock(store);
    process.stdout.write(JSON.stringify({ key, ok: true }) + "\n");
    return;
  }

  // Testnet path — POST to 0G KV REST endpoint.
  const KV_URL = process.env.OG_KV_URL;
  if (!KV_URL) {
    fail("Missing OG_KV_URL in env (required for testnet KV writes).");
  }

  const body = JSON.stringify({ key, value: bytes.toString("base64") });
  let resp;
  try {
    resp = await fetch(`${KV_URL}/kv/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    fail(`KV PUT network error: ${e?.message ?? e}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    fail(`KV PUT failed (HTTP ${resp.status}): ${text}`);
  }

  process.stdout.write(JSON.stringify({ key, ok: true }) + "\n");
}

main().catch((e) => fail(`kv-put error: ${e?.stack || e}`));
