// seal_agent_lib.ts — shared Seal/Walrus helpers for mint_agent.ts,
// fetch_weights.ts, and trade_agent.ts (Tasks 7-8). Factored out once a
// third script (trade_agent.ts) needed the identical fetch-blob-ref /
// download-from-Walrus / decrypt-as-signer logic; not extracted
// speculatively.
//
// UNVERIFIED end-to-end — same caveat as mint_agent.ts/fetch_weights.ts:
// this sandbox's egress policy blocks Seal/Walrus's docs and github.com,
// so the current verified testnet Seal key server object ids could not
// be confirmed (see requireSealKeyServerConfigs' doc comment) and no
// function here has ever actually reached a live key server or Walrus
// publisher/aggregator. Typechecked against the real installed SDKs'
// shipped types only.

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SealClient, SessionKey } from "@mysten/seal";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

/**
 * Comma-separated Seal key server object ids, read from
 * SEAL_KEY_SERVER_OBJECT_IDS. Deliberately NOT hardcoded: a web search for
 * "verified testnet Seal key servers" (this sandbox cannot reach
 * seal-docs.wal.app directly) surfaced object-id-shaped strings that
 * decoded to 33 bytes — not the 32 a real Sui object id must be, a strong
 * signal of search-summary hallucination — so none were trusted as a
 * default. Set this yourself from the Seal docs' "Verified Key Servers"
 * page once running somewhere with network access.
 */
export function sealKeyServerConfigs(): { objectId: string; weight: number }[] {
  const raw = requireEnv("SEAL_KEY_SERVER_OBJECT_IDS");
  return raw.split(",").map((objectId) => ({ objectId: objectId.trim(), weight: 1 }));
}

export interface WeightsBlobRef {
  blobId: string;
  contentHash: Uint8Array;
}

/** Reads Agent.weights_blob directly off the object. */
export async function fetchWeightsBlobRef(client: SuiJsonRpcClient, agentObjectId: string): Promise<WeightsBlobRef> {
  const res = await client.getObject({ id: agentObjectId, options: { showContent: true } });
  const content = res.data?.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`Agent object ${agentObjectId} has no content`);
  }
  const fields = content.fields as Record<string, unknown>;
  const weightsBlob = fields.weights_blob as { fields?: { id?: number[]; content_hash?: number[] } } | null;
  const inner = weightsBlob?.fields;
  if (!inner?.id || !inner?.content_hash) {
    throw new Error(`Agent ${agentObjectId} has no weights_blob set (call mint_agent.ts's set_weights step first)`);
  }
  return {
    blobId: new TextDecoder().decode(new Uint8Array(inner.id)),
    contentHash: new Uint8Array(inner.content_hash),
  };
}

export async function downloadFromWalrus(blobId: string, aggregatorUrl: string): Promise<Uint8Array> {
  const res = await fetch(`${aggregatorUrl.replace(/\/$/, "")}/v1/blobs/${blobId}`);
  if (!res.ok) throw new Error(`Walrus aggregator returned ${res.status} for blob ${blobId}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface WalrusUploadResult {
  blobId: string;
  suiObjectId: string | null;
}

/** Mirrors agent/walrus_upload.py's upload_checkpoint — same HTTP API, TS side. */
export async function uploadToWalrus(data: Uint8Array, publisherUrl: string, epochs: string | number): Promise<WalrusUploadResult> {
  const res = await fetch(`${publisherUrl.replace(/\/$/, "")}/v1/blobs?epochs=${epochs}`, {
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

/**
 * Build the seal_approve PTB and attempt decryption for `signer`. Returns
 * the decrypted plaintext on success; throws (no-access) otherwise — that
 * throw IS the "denied" proof when called with a non-owner signer (see
 * fetch_weights.ts's --demo-denial and trade_agent.ts's post-trade probe).
 */
export async function decryptAsSigner(
  client: SuiJsonRpcClient,
  packageId: string,
  agentObjectId: string,
  ciphertext: Uint8Array,
  signer: Ed25519Keypair,
): Promise<Uint8Array> {
  const address = signer.getPublicKey().toSuiAddress();
  const sealClient = new SealClient({ suiClient: client, serverConfigs: sealKeyServerConfigs() });

  const sessionKey = await SessionKey.create({
    address,
    packageId,
    ttlMin: 10,
    signer,
    suiClient: client,
  });

  const approveTx = new Transaction();
  approveTx.setSender(address);
  approveTx.moveCall({
    target: `${packageId}::agent::seal_approve`,
    // `id` matches what mint_agent.ts encrypted under: the agent's own
    // object id, hex string (SealClient hex-decodes it internally).
    arguments: [approveTx.pure.vector("u8", Array.from(Buffer.from(agentObjectId.replace(/^0x/, ""), "hex"))), approveTx.object(agentObjectId)],
  });
  const txBytes = await approveTx.build({ client, onlyTransactionKind: true });

  return sealClient.decrypt({ data: ciphertext, sessionKey, txBytes });
}
