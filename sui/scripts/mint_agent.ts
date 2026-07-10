// mint_agent.ts — Task 7: mint an Agent, Seal-encrypt an ONNX export under
// its own on-chain object id, upload the ciphertext to Walrus, and record
// the blob on-chain via chaingammon::agent::set_weights.
//
// Run: node --experimental-strip-types sui/scripts/mint_agent.ts <onnx-path> [name] [tier]
//
// Env:
//   SUI_RPC_URL              - defaults to testnet's fullnode (see @mysten/sui/jsonRpc)
//   SUI_NETWORK              - "testnet" (default) or "localnet" — only affects the
//                               SuiJsonRpcClient's `network` tag, not RPC_URL itself
//   SUI_PACKAGE_ID            - required: the published chaingammon package id
//   SUI_PRIVATE_KEY           - required: bech32 secret key (from Ed25519Keypair.getSecretKey())
//                               of the minting/owner address; pays gas and becomes Agent.owner
//   SEAL_KEY_SERVER_OBJECT_IDS - required to actually encrypt: comma-separated object ids
//                               of the Seal key servers to use. Deliberately NOT hardcoded
//                               here — this sandbox's egress policy blocks docs.wal.app and
//                               github.com, so the currently-verified testnet key server ids
//                               could not be confirmed from within this environment (see
//                               sui/README.md's Task 7 section for the full explanation).
//                               Find the current list at the Seal docs' "Verified Key
//                               Servers" page (seal-docs.wal.app) and set this yourself.
//   SEAL_THRESHOLD            - number of key servers required to decrypt (default "1")
//   WALRUS_PUBLISHER_URL      - defaults to the public testnet publisher
//   WALRUS_EPOCHS             - storage epochs to pay for (default "1")
//
// Order matters: the Seal identity IS the agent's own on-chain object id
// (see sources/agent.move's seal_approve policy doc comment) — which only
// exists after mint. So this script mints FIRST, then encrypts + uploads +
// set_weights, even though "Seal-encrypt an ONNX export, upload to Walrus,
// agent::mint + set_weights" (the plan's phrasing) reads encrypt-first —
// that ordering describes the OVERALL feature, not this script's literal
// step order.
//
// UNVERIFIED end-to-end: this sandbox has no live network path to a real
// Seal key server or Walrus publisher (egress policy blocks both), so the
// encrypt/upload calls below have never actually been run — only
// typechecked against the installed @mysten/seal SDK's shipped .d.mts
// files. Same caveat as sui/README.md's other CLI examples.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SealClient } from "@mysten/seal";

const NETWORK = (process.env.SUI_NETWORK === "localnet" ? "localnet" : "testnet") as
  | "localnet"
  | "testnet";
const RPC_URL = process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK);
const PACKAGE_ID = requireEnv("SUI_PACKAGE_ID");
const PRIVATE_KEY = requireEnv("SUI_PRIVATE_KEY");
const SEAL_THRESHOLD = Number(process.env.SEAL_THRESHOLD ?? "1");
const WALRUS_PUBLISHER_URL = (process.env.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-testnet.walrus.space").replace(/\/$/, "");
const WALRUS_EPOCHS = process.env.WALRUS_EPOCHS ?? "1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

function sealKeyServerConfigs(): { objectId: string; weight: number }[] {
  const raw = process.env.SEAL_KEY_SERVER_OBJECT_IDS;
  if (!raw) {
    throw new Error(
      "SEAL_KEY_SERVER_OBJECT_IDS is required. This is not hardcoded in this script — " +
        "see the header comment for why (blocked egress to Seal's docs from this " +
        "environment). Set it to a comma-separated list of verified Seal key server " +
        "object ids for the target network.",
    );
  }
  return raw.split(",").map((objectId) => ({ objectId: objectId.trim(), weight: 1 }));
}

interface WalrusUploadResult {
  blobId: string;
  suiObjectId: string | null;
}

/** Mirrors agent/walrus_upload.py's upload_checkpoint — same HTTP API, TS side. */
async function uploadToWalrus(data: Uint8Array): Promise<WalrusUploadResult> {
  const res = await fetch(`${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=${WALRUS_EPOCHS}`, {
    method: "PUT",
    body: Buffer.from(data),
  });
  if (!res.ok) {
    throw new Error(`Walrus publisher returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const parsed = (await res.json()) as {
    newlyCreated?: { blobObject: { id: string; blobId: string } };
    alreadyCertified?: { blobId: string };
  };
  if (parsed.newlyCreated) {
    return { blobId: parsed.newlyCreated.blobObject.blobId, suiObjectId: parsed.newlyCreated.blobObject.id };
  }
  if (parsed.alreadyCertified) {
    return { blobId: parsed.alreadyCertified.blobId, suiObjectId: null };
  }
  throw new Error(`Walrus publisher response has neither 'newlyCreated' nor 'alreadyCertified': ${JSON.stringify(parsed)}`);
}

async function main() {
  const [onnxPathArg, nameArg, tierArg] = process.argv.slice(2);
  if (!onnxPathArg) {
    throw new Error("usage: mint_agent.ts <onnx-path> [name] [tier]");
  }
  const name = nameArg ?? "chaingammon-agent";
  const tier = Number(tierArg ?? "1");
  const onnxBytes = new Uint8Array(readFileSync(onnxPathArg));

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });
  const signer = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const address = signer.getPublicKey().toSuiAddress();

  // ── 1. Mint the Agent first — its object id becomes the Seal identity. ──
  console.log(`[mint_agent] minting Agent "${name}" (tier ${tier}) as ${address}…`);
  const mintTx = new Transaction();
  mintTx.setSender(address);
  mintTx.moveCall({
    target: `${PACKAGE_ID}::agent::mint`,
    arguments: [mintTx.pure.vector("u8", Array.from(new TextEncoder().encode(name))), mintTx.pure.u8(tier)],
  });
  const mintResult = await client.signAndExecuteTransaction({
    transaction: mintTx,
    signer,
    options: { showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: mintResult.digest });
  const created = (mintResult.objectChanges ?? []).find(
    (c) => c.type === "created" && "objectType" in c && c.objectType === `${PACKAGE_ID}::agent::Agent`,
  ) as { objectId: string } | undefined;
  if (!created) throw new Error(`mint(): no Agent object in objectChanges — digest ${mintResult.digest}`);
  const agentObjectId = created.objectId;
  console.log(`[mint_agent] minted Agent ${agentObjectId}`);

  // ── 2. Seal-encrypt the ONNX export under the agent's own object id. ────
  console.log(`[mint_agent] Seal-encrypting ${onnxBytes.length} bytes under id=${agentObjectId}…`);
  const sealClient = new SealClient({
    // SuiJsonRpcClient structurally satisfies SealCompatibleClient (it
    // exposes the same `.core` CoreClient surface @mysten/seal expects) —
    // no separate grpc client / $extend() dance needed.
    suiClient: client,
    serverConfigs: sealKeyServerConfigs(),
  });
  const { encryptedObject } = await sealClient.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: PACKAGE_ID,
    id: agentObjectId,
    data: onnxBytes,
  });

  // content_hash is over the PLAINTEXT ONNX bytes (not the ciphertext) so
  // fetch_weights.ts can verify integrity AFTER decrypting.
  const contentHash = createHash("sha256").update(onnxBytes).digest();

  // ── 3. Upload the ciphertext to Walrus. ──────────────────────────────────
  console.log(`[mint_agent] uploading ${encryptedObject.length}-byte ciphertext to Walrus…`);
  const uploaded = await uploadToWalrus(encryptedObject);
  console.log(`[mint_agent] Walrus blobId = ${uploaded.blobId}` + (uploaded.suiObjectId ? ` (suiObjectId ${uploaded.suiObjectId})` : " (already certified)"));

  // ── 4. Record the blob on-chain. blob_id is stored as the UTF-8 bytes of
  // the blobId string (Walrus blob ids are base64url text, not raw bytes —
  // storing the string form avoids any base64 alphabet/padding assumptions
  // and round-trips trivially via TextDecoder in fetch_weights.ts). ────────
  const setWeightsTx = new Transaction();
  setWeightsTx.setSender(address);
  setWeightsTx.moveCall({
    target: `${PACKAGE_ID}::agent::set_weights`,
    arguments: [
      setWeightsTx.object(agentObjectId),
      setWeightsTx.pure.vector("u8", Array.from(new TextEncoder().encode(uploaded.blobId))),
      setWeightsTx.pure.vector("u8", Array.from(contentHash)),
    ],
  });
  const setWeightsResult = await client.signAndExecuteTransaction({ transaction: setWeightsTx, signer });
  await client.waitForTransaction({ digest: setWeightsResult.digest });

  console.log(`[mint_agent] done. Agent ${agentObjectId} owner=${address}`);
  console.log(`  walrusBlobId  = ${uploaded.blobId}`);
  console.log(`  contentHash   = ${contentHash.toString("hex")}`);
  console.log(`  set_weights tx = ${setWeightsResult.digest}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
