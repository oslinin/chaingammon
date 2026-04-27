#!/usr/bin/env node
// CLI: upload bytes from stdin to 0G Storage, print {rootHash, txHash} as JSON to stdout.
//
// Usage: cat blob.bin | node src/upload.mjs
//
// Required env: OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY

// The 0G SDK logs progress via console.log. Redirect to stderr so stdout
// stays clean for the single JSON payload we emit at the end.
const _origLog = console.log;
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const RPC = process.env.OG_STORAGE_RPC;
const INDEXER = process.env.OG_STORAGE_INDEXER;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
if (!RPC || !INDEXER || !PRIVATE_KEY) {
  fail("Missing one of OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY in env.");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const bytes = await readStdin();
  if (bytes.length === 0) fail("No bytes on stdin.");

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const indexer = new Indexer(INDEXER);

  const data = new MemData(bytes);
  const [result, err] = await indexer.upload(data, RPC, signer);
  if (err) fail(`Upload failed: ${err.message ?? err}`);

  // Single-file uploads return {txHash, rootHash, txSeq}; multi-file returns arrays.
  // We only ever upload one MemData here, so handle the single shape.
  const out = { rootHash: result.rootHash, txHash: result.txHash };
  // Use the original console.log to avoid the redirect we set up at the top.
  _origLog(JSON.stringify(out));
}

main().catch((e) => fail(`Upload error: ${e?.stack || e}`));
