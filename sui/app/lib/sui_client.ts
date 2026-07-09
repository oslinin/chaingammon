// sui_client.ts — thin wrapper over @mysten/sui's SuiJsonRpcClient for the
// mock-auth profile flow (Task 5). No dapp-kit / wallet-extension support
// yet — the only signer in this app so far is the mock identity's
// in-browser Ed25519Keypair (see mock_identity.ts).
//
// Package id + the ProfileRegistry's object id are NOT baked in at build
// time (would force a rebuild after every localnet republish). Instead
// they're read at runtime from /localnet-config.json, a static file that
// sui/scripts/publish_localnet.ts writes after publishing — see
// tests/localnet.ts for how the Playwright harness produces it. Absent in
// this sandbox (no local `sui` CLI) and in any deployment that hasn't
// published yet; callers should treat a null config as "chain features
// unavailable" and degrade gracefully, per Task 5 Step 1's "do NOT stall
// the plan" instruction.
"use client";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface LocalnetConfig {
  rpcUrl: string;
  faucetUrl: string;
  packageId: string;
  profileRegistryId: string;
  deployerAddress: string;
}

let cachedConfig: LocalnetConfig | null | undefined;

/** Fetch (and cache) /localnet-config.json. Returns null if absent/unreachable. */
export async function loadLocalnetConfig(): Promise<LocalnetConfig | null> {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const res = await fetch("/localnet-config.json", { cache: "no-store" });
    if (!res.ok) {
      cachedConfig = null;
      return null;
    }
    cachedConfig = (await res.json()) as LocalnetConfig;
    return cachedConfig;
  } catch {
    cachedConfig = null;
    return null;
  }
}

const clients = new Map<string, SuiJsonRpcClient>();

function getClient(rpcUrl: string): SuiJsonRpcClient {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = new SuiJsonRpcClient({ url: rpcUrl, network: "localnet" });
    clients.set(rpcUrl, client);
  }
  return client;
}

/** Fund `address` from the localnet faucet. No-op error swallow — a guest can still browse without funds. */
export async function requestFaucet(config: LocalnetConfig, address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: config.faucetUrl, recipient: address });
}

function decodeBool(returnValues: [number[], string][] | null | undefined): boolean {
  const bytes = returnValues?.[0]?.[0];
  return !!bytes && bytes[0] === 1;
}

function decodeId(returnValues: [number[], string][] | null | undefined): string {
  const bytes = returnValues?.[0]?.[0];
  if (!bytes || bytes.length !== 32) throw new Error("expected a 32-byte ID return value");
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read-only: does `address` already have a HumanProfile? (sui::devInspect — no gas, no signature.) */
export async function hasProfile(config: LocalnetConfig, address: string): Promise<boolean> {
  const client = getClient(config.rpcUrl);
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::profile::has_profile`,
    arguments: [tx.object(config.profileRegistryId), tx.pure.address(address)],
  });
  const result = await client.devInspectTransactionBlock({ sender: address, transactionBlock: tx });
  return decodeBool(result.results?.[0]?.returnValues);
}

/** Read-only: the HumanProfile object id registered for `address`. Throws if none exists — check `hasProfile` first. */
export async function profileIdFor(config: LocalnetConfig, address: string): Promise<string> {
  const client = getClient(config.rpcUrl);
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::profile::profile_id_for`,
    arguments: [tx.object(config.profileRegistryId), tx.pure.address(address)],
  });
  const result = await client.devInspectTransactionBlock({ sender: address, transactionBlock: tx });
  return decodeId(result.results?.[0]?.returnValues);
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  elo: number;
  matchCount: number;
}

/** Fetch a HumanProfile's current fields directly from its object. */
export async function fetchProfile(config: LocalnetConfig, profileId: string): Promise<ProfileSummary> {
  const client = getClient(config.rpcUrl);
  const res = await client.getObject({ id: profileId, options: { showContent: true } });
  const content = res.data?.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`profile object ${profileId} has no content`);
  }
  const fields = content.fields as Record<string, unknown>;
  return {
    id: profileId,
    displayName: String(fields.display_name ?? ""),
    elo: Number(fields.elo ?? 1500),
    matchCount: Number(fields.match_count ?? 0),
  };
}

/** Sign and submit `profile::create_profile(displayName)`, funded by the caller's own gas. */
export async function createProfile(
  config: LocalnetConfig,
  keypair: Ed25519Keypair,
  displayName: string,
): Promise<void> {
  const client = getClient(config.rpcUrl);
  const address = keypair.getPublicKey().toSuiAddress();
  const tx = new Transaction();
  tx.setSender(address);
  tx.moveCall({
    target: `${config.packageId}::profile::create_profile`,
    arguments: [
      tx.object(config.profileRegistryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(displayName))),
    ],
  });
  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  await client.waitForTransaction({ digest: result.digest });
}
