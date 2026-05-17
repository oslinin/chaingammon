#!/usr/bin/env node
// register_0g_provider.mjs — register (or update) the chaingammon VPS as a
// backgammon-net-v1 inference provider on the 0G testnet serving network.
//
// Run once from the repo root:
//
//   node scripts/register_0g_provider.mjs
//
// Required env (already in frontend/.env.local):
//   OG_STORAGE_RPC          — 0G chain RPC endpoint
//   OG_STORAGE_PRIVATE_KEY  — provider wallet private key
//
// Optional env:
//   PROVIDER_URL            — public URL of this server (default: http://136.112.73.124)
//   MODEL_NAME              — model identifier (default: backgammon-net-v1)
//   INPUT_PRICE_NEURON      — price per request in neuron (default: 10000 = 0.00001 OG)
//
// The script calls InferenceServing.addOrUpdateService() directly on the
// testnet contract (0xa79F4c8311FF93C06b8CfB403690cc987c93F91E). After
// registration, clients discover the service via:
//   broker.inference.listService() → finds model matching "backgammon-net-v1"
//   broker.inference.getServiceMetadata(providerAddress) → { endpoint, model }
//   POST <endpoint>/equity  → { equity: float }

import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// Load env from frontend/.env.local so this script works without exporting vars.
function loadEnv() {
  const envPath = resolve(__dir, "../../frontend/.env.local");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // No .env.local — rely on shell env.
  }
}

loadEnv();

const RPC = process.env.OG_STORAGE_RPC;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
if (!RPC || !PRIVATE_KEY) {
  console.error("Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY");
  process.exit(1);
}

const PROVIDER_URL = process.env.PROVIDER_URL || "http://136.112.73.124";
const MODEL_NAME = process.env.MODEL_NAME || "backgammon-net-v1";
// 10 000 neuron = 0.00001 OG per inference request
const INPUT_PRICE = BigInt(process.env.INPUT_PRICE_NEURON || "10000");

// Testnet inference contract address (from the 0G serving-broker SDK).
const INFERENCE_CA = "0xa79F4c8311FF93C06b8CfB403690cc987c93F91E";

// Minimal ABI — only addOrUpdateService + getAllServices.
const ABI = [
  {
    name: "addOrUpdateService",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "serviceType", type: "string" },
          { name: "url",         type: "string" },
          { name: "model",       type: "string" },
          { name: "verifiability", type: "string" },
          { name: "inputPrice",  type: "uint256" },
          { name: "outputPrice", type: "uint256" },
          { name: "additionalInfo", type: "string" },
          { name: "teeSignerAddress", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "getAllServices",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "provider",    type: "address" },
          { name: "serviceType", type: "string" },
          { name: "url",         type: "string" },
          { name: "inputPrice",  type: "uint256" },
          { name: "outputPrice", type: "uint256" },
          { name: "updatedAt",   type: "uint256" },
          { name: "model",       type: "string" },
          { name: "verifiability", type: "string" },
          { name: "additionalInfo", type: "string" },
        ],
      },
    ],
  },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Provider wallet: ${wallet.address}`);

  const contract = new ethers.Contract(INFERENCE_CA, ABI, wallet);

  console.log(`\nRegistering service:`);
  console.log(`  URL:         ${PROVIDER_URL}`);
  console.log(`  Model:       ${MODEL_NAME}`);
  console.log(`  inputPrice:  ${INPUT_PRICE} neuron (${Number(INPUT_PRICE) / 1e9} OG)`);
  console.log(`  Contract:    ${INFERENCE_CA}\n`);

  const tx = await contract.addOrUpdateService({
    serviceType: "inference",
    url: PROVIDER_URL,
    model: MODEL_NAME,
    verifiability: "",
    inputPrice: INPUT_PRICE,
    outputPrice: 0n,
    additionalInfo: "",
    teeSignerAddress: ethers.ZeroAddress,
  });

  console.log(`Transaction sent: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  // Verify registration.
  const services = await contract.getAllServices();
  const mine = services.find(
    (s) => s.provider.toLowerCase() === wallet.address.toLowerCase()
  );
  if (mine) {
    console.log(`\nService registered:`);
    console.log(`  provider: ${mine.provider}`);
    console.log(`  model:    ${mine.model}`);
    console.log(`  url:      ${mine.url}`);
    console.log(`\nClients can discover this provider via:`);
    console.log(`  broker.inference.listService()`);
    console.log(`  → looks for model containing "${MODEL_NAME}"`);
    console.log(`  → calls POST ${PROVIDER_URL}/equity`);
  } else {
    console.log("Registration may have succeeded but service not found in getAllServices() — check tx.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
