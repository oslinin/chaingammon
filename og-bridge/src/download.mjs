#!/usr/bin/env node
// CLI: download a 0G Storage blob by rootHash and write its bytes to stdout.
//
// Usage: node src/download.mjs <rootHash>
//
// Required env: OG_STORAGE_INDEXER

// SDK progress goes to stderr so stdout stays clean for the binary blob.
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import { Indexer } from "@0gfoundation/0g-ts-sdk";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const INDEXER = process.env.OG_STORAGE_INDEXER;
if (!INDEXER) fail("Missing OG_STORAGE_INDEXER in env.");

const rootHash = process.argv[2];
if (!rootHash) fail("Usage: node src/download.mjs <rootHash>");

async function main() {
  const indexer = new Indexer(INDEXER);
  const [blob, err] = await indexer.downloadToBlob(rootHash);
  if (err) fail(`Download failed: ${err.message ?? err}`);
  const buf = Buffer.from(await blob.arrayBuffer());
  process.stdout.write(buf);
}

main().catch((e) => fail(`Download error: ${e?.stack || e}`));
