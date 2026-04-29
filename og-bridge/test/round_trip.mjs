#!/usr/bin/env node
// Round-trip integration test for MockOgStorage via og-bridge upload/download.
//
// Uploads three known payloads (including a binary edge case) through the
// localhost branch of upload.mjs, downloads each by the returned rootHash,
// and asserts byte-for-byte equality. Prints OK and exits 0 on success;
// exits 1 with a diff summary on any mismatch.
//
// Usage:
//   node og-bridge/test/round_trip.mjs --mock-address 0x<address>
//     [--rpc http://127.0.0.1:8545]
//     [--private-key 0x<key>]

import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mock-address") result.mockAddress = args[++i];
    else if (args[i] === "--rpc") result.rpc = args[++i];
    else if (args[i] === "--private-key") result.privateKey = args[++i];
  }
  if (!result.mockAddress) {
    fail("Usage: node test/round_trip.mjs --mock-address 0x...");
  }
  return result;
}

const { mockAddress, rpc = "http://127.0.0.1:8545", privateKey } = parseArgs();

// Three payloads: two text strings and one binary edge case.
const PAYLOADS = [
  Buffer.from("chaingammon round trip payload A"),
  Buffer.from("chaingammon round trip payload B — slightly longer content"),
  Buffer.from(new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff])),
];

const env = {
  ...process.env,
  OG_STORAGE_MODE: "localhost",
  LOCALHOST_RPC: rpc,
  LOCALHOST_MOCK_OG_STORAGE: mockAddress,
};
if (privateKey) env.LOCALHOST_PRIVATE_KEY = privateKey;

const uploadScript = path.resolve(__dirname, "../src/upload.mjs");
const downloadScript = path.resolve(__dirname, "../src/download.mjs");

let allOk = true;

for (let i = 0; i < PAYLOADS.length; i++) {
  const payload = PAYLOADS[i];

  // Upload via upload.mjs (reads payload from stdin).
  let uploadStdout;
  try {
    uploadStdout = execFileSync("node", [uploadScript], { input: payload, env });
  } catch (e) {
    process.stderr.write(`Payload ${i}: upload failed: ${e.message}\n`);
    allOk = false;
    continue;
  }

  let rootHash;
  try {
    ({ rootHash } = JSON.parse(uploadStdout.toString().trim()));
  } catch {
    process.stderr.write(
      `Payload ${i}: upload output is not valid JSON: ${uploadStdout}\n`,
    );
    allOk = false;
    continue;
  }

  // Download via download.mjs (writes raw bytes to stdout).
  let downloaded;
  try {
    downloaded = execFileSync("node", [downloadScript, rootHash], { env });
  } catch (e) {
    process.stderr.write(`Payload ${i}: download failed: ${e.message}\n`);
    allOk = false;
    continue;
  }

  // Assert byte-for-byte equality.
  if (!downloaded.equals(payload)) {
    process.stderr.write(
      `Payload ${i}: MISMATCH\n` +
        `  expected: ${payload.toString("hex")}\n` +
        `  got:      ${downloaded.toString("hex")}\n`,
    );
    allOk = false;
  } else {
    process.stdout.write(`Payload ${i}: OK (rootHash ${rootHash})\n`);
  }
}

if (!allOk) process.exit(1);
process.stdout.write("OK\n");
