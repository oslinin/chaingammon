#!/usr/bin/env node
// CLI: upload bytes from stdin to 0G Storage or MockOgStorage on localhost.
//
// Usage: cat blob.bin | node src/upload.mjs
//
// Testnet mode (default, OG_STORAGE_MODE unset or "testnet"):
//   Required env: OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY
//
// Localhost mode (OG_STORAGE_MODE=localhost):
//   Optional env: LOCALHOST_RPC (default http://127.0.0.1:8545)
//   Required:     LOCALHOST_MOCK_OG_STORAGE or contracts/deployments/localhost.json
//   Optional env: LOCALHOST_PRIVATE_KEY (default: Hardhat's first well-known test key)

// The 0G SDK logs progress via console.log. Redirect to stderr so stdout
// stays clean for the single JSON payload we emit at the end.
const _origLog = console.log;
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const bytes = await readStdin();
  if (bytes.length === 0) fail("No bytes on stdin.");

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

    // Hardhat's first well-known test key — publicly known, do not reuse on a real network.
    const privateKey =
      process.env.LOCALHOST_PRIVATE_KEY ??
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    const provider = new ethers.JsonRpcProvider(rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const mock = new ethers.Contract(mockAddr, MOCK_ABI, signer);

    // keccak256 is deterministic — compute locally to avoid a staticCall round-trip.
    const rootHash = ethers.keccak256(bytes);
    const tx = await mock.put(bytes);
    const receipt = await tx.wait();
    _origLog(JSON.stringify({ rootHash, txHash: receipt.hash }));
    return;
  }

  // Testnet / default path — behaviour unchanged from prior phases.
  const RPC = process.env.OG_STORAGE_RPC;
  const INDEXER = process.env.OG_STORAGE_INDEXER;
  const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
  if (!RPC || !INDEXER || !PRIVATE_KEY) {
    fail("Missing one of OG_STORAGE_RPC, OG_STORAGE_INDEXER, OG_STORAGE_PRIVATE_KEY in env.");
  }

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
