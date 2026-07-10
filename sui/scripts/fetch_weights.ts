// fetch_weights.ts — Task 7: fetch an Agent's Walrus-stored, Seal-encrypted
// weights blob, decrypt it (only succeeds for the CURRENT owner — see
// sources/agent.move's seal_approve policy), and verify its hash.
//
// Run: node --experimental-strip-types sui/scripts/fetch_weights.ts <agent-object-id> [out-path]
//
// Env: same as mint_agent.ts (SUI_RPC_URL, SUI_NETWORK, SUI_PACKAGE_ID,
// SUI_PRIVATE_KEY, SEAL_KEY_SERVER_OBJECT_IDS, WALRUS aggregator below) —
// see that script's header comment for why SEAL_KEY_SERVER_OBJECT_IDS is
// a required env var rather than a hardcoded default, and for the same
// "UNVERIFIED end-to-end" caveat (this sandbox cannot reach a real Seal
// key server or Walrus aggregator).
//
//   WALRUS_AGGREGATOR_URL - defaults to the public testnet aggregator
//
// Demo proof (Task 7 Step 4's "non-owner decrypt FAILS"): re-run this
// script with SUI_PRIVATE_KEY set to an address that is NOT the agent's
// current owner. seal_approve's `tx_context::sender(ctx) == agent.owner`
// check aborts (ENoAccess), the key servers refuse to release key shares,
// and SealClient.decrypt() rejects — see runDenialDemo() below, which
// does exactly this against a throwaway keypair automatically.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { requireEnv, fetchWeightsBlobRef, downloadFromWalrus, decryptAsSigner } from "./seal_agent_lib.ts";

const NETWORK = (process.env.SUI_NETWORK === "localnet" ? "localnet" : "testnet") as
  | "localnet"
  | "testnet";
const RPC_URL = process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK);
const PACKAGE_ID = requireEnv("SUI_PACKAGE_ID");
const PRIVATE_KEY = requireEnv("SUI_PRIVATE_KEY");
const WALRUS_AGGREGATOR_URL = process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space";

async function main() {
  const [agentObjectId, outPathArg] = process.argv.slice(2);
  if (!agentObjectId) {
    throw new Error("usage: fetch_weights.ts <agent-object-id> [out-path]");
  }

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });
  const signer = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);

  console.log(`[fetch_weights] reading Agent ${agentObjectId}'s weights_blob…`);
  const blobRef = await fetchWeightsBlobRef(client, agentObjectId);
  console.log(`[fetch_weights] blobId=${blobRef.blobId} contentHash=${Buffer.from(blobRef.contentHash).toString("hex")}`);

  console.log(`[fetch_weights] downloading from Walrus…`);
  const ciphertext = await downloadFromWalrus(blobRef.blobId, WALRUS_AGGREGATOR_URL);

  console.log(`[fetch_weights] decrypting as ${signer.getPublicKey().toSuiAddress()}…`);
  const plaintext = await decryptAsSigner(client, PACKAGE_ID, agentObjectId, ciphertext, signer);

  const actualHash = createHash("sha256").update(plaintext).digest();
  if (Buffer.compare(actualHash, Buffer.from(blobRef.contentHash)) !== 0) {
    throw new Error(
      `content hash mismatch: on-chain=${Buffer.from(blobRef.contentHash).toString("hex")} actual=${actualHash.toString("hex")}`,
    );
  }
  console.log(`[fetch_weights] hash verified OK (${plaintext.length} bytes).`);

  const outPath = outPathArg ?? "fetched_weights.onnx";
  writeFileSync(outPath, plaintext);
  console.log(`[fetch_weights] wrote ${outPath}`);
}

/**
 * Task 7 Step 4's required proof: a throwaway keypair that is NOT the
 * agent's owner must be denied decryption. Run explicitly:
 *   node --experimental-strip-types sui/scripts/fetch_weights.ts --demo-denial <agent-object-id>
 */
async function runDenialDemo(agentObjectId: string) {
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });
  const blobRef = await fetchWeightsBlobRef(client, agentObjectId);
  const ciphertext = await downloadFromWalrus(blobRef.blobId, WALRUS_AGGREGATOR_URL);
  const stranger = Ed25519Keypair.generate();
  console.log(`[fetch_weights] attempting decrypt as NON-owner ${stranger.getPublicKey().toSuiAddress()} (must fail)…`);
  try {
    await decryptAsSigner(client, PACKAGE_ID, agentObjectId, ciphertext, stranger);
    throw new Error("DEMO FAILED: non-owner decrypt unexpectedly succeeded");
  } catch (e) {
    console.log(`[fetch_weights] non-owner decrypt correctly denied: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--demo-denial") {
  const agentObjectId = args[1];
  if (!agentObjectId) throw new Error("usage: fetch_weights.ts --demo-denial <agent-object-id>");
  runDenialDemo(agentObjectId).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
