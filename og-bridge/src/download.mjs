#!/usr/bin/env node
// CLI: download a blob by rootHash and write its bytes to stdout.
//
// Usage: node src/download.mjs <rootHash>
//
// Testnet mode (default, OG_STORAGE_MODE unset or "testnet"):
//   Required env: OG_STORAGE_INDEXER
//
// Localhost mode (OG_STORAGE_MODE=localhost):
//   Optional env: LOCALHOST_RPC (default http://127.0.0.1:8545)
//   Required:     LOCALHOST_MOCK_OG_STORAGE or contracts/deployments/localhost.json

// SDK progress goes to stderr so stdout stays clean for the binary blob.
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import { Indexer } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

// Minimal ABI for MockOgStorage — only the two functions used here.
const MOCK_ABI = [
  "function put(bytes calldata data) external returns (bytes32 rootHash)",
  "function get(bytes32 rootHash) external view returns (bytes memory)",
];

const rootHash = process.argv[2];
if (!rootHash) fail("Usage: node src/download.mjs <rootHash>");

async function main() {
  if (process.env.OG_STORAGE_MODE === "localhost") {
    const rpc = process.env.LOCALHOST_RPC ?? "http://127.0.0.1:8545";

    // Resolve MockOgStorage address from env or fallback to deployments JSON.
    let mockAddr = process.env.LOCALHOST_MOCK_OG_STORAGE;
    if (!mockAddr) {
      const deployPath = path.resolve(
        import.meta.dirname,
        "../../contracts/deployments/localhost.json",
      );
      let deployment;
      try {
        deployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));
      } catch {
        fail(
          `LOCALHOST_MOCK_OG_STORAGE is not set and ${deployPath} is missing or unreadable. ` +
            `Deploy first: pnpm exec hardhat run script/deploy.js --network localhost`,
        );
      }
      mockAddr = deployment?.contracts?.MockOgStorage;
      if (!mockAddr) {
        fail(
          `MockOgStorage address not found in ${deployPath}. ` +
            `Redeploy to localhost to include MockOgStorage.`,
        );
      }
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const mock = new ethers.Contract(mockAddr, MOCK_ABI, provider);

    const hexData = await mock.get(rootHash);
    // hexData is a "0x..." hex string from ethers — strip the prefix and write raw bytes.
    const buf = Buffer.from(hexData.slice(2), "hex");
    process.stdout.write(buf);
    return;
  }

  // Testnet / default path — behaviour unchanged from prior phases.
  const INDEXER = process.env.OG_STORAGE_INDEXER;
  if (!INDEXER) fail("Missing OG_STORAGE_INDEXER in env.");

  const indexer = new Indexer(INDEXER);
  const [blob, err] = await indexer.downloadToBlob(rootHash);
  if (err) fail(`Download failed: ${err.message ?? err}`);
  const buf = Buffer.from(await blob.arrayBuffer());
  process.stdout.write(buf);
}

main().catch((e) => fail(`Download error: ${e?.stack || e}`));
