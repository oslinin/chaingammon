/**
 * og_training.ts — browser-side 0G Compute training client.
 *
 * Submits a round-robin training job to a backgammon-train-v1 provider on
 * the 0G serving network. Replaces the previous FastAPI POST /training/start
 * path: there is no server in this flow, and the user's MetaMask wallet
 * signs/pays for the compute directly.
 *
 * Lifecycle:
 *   submitTrainingJob({agentIds, epochs, weightsByAgentId, walletClient})
 *     → discover provider via broker.inference.listService()
 *     → fund ledger if needed (broker.ledger.addLedger / transferFund)
 *     → POST {endpoint}/train with broker auth headers
 *     → return {weightsByAgentId, statsByAgentId}
 *
 * Throws OgTrainingUnavailable when no backgammon-train-v1 provider is
 * registered — the page renders this as a non-fatal "no provider" state.
 */
import { ethers } from "ethers";
import type { WalletClient } from "viem";

const MODEL_FILTER = "backgammon-train-v1";
const DEPOSIT_OG = 0.1;
const MIN_BALANCE_OG = 1.1;

export class OgTrainingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OgTrainingUnavailable";
  }
}

export interface TrainingJobInput {
  agentIds: number[];
  epochs: number;
  /** Current ONNX bytes per agent (Uint8Array). Provider returns new bytes. */
  weightsByAgentId: Record<number, Uint8Array>;
  walletClient: WalletClient;
  seed?: number;
  onProgress?: (event: { step: string; detail?: string }) => void;
}

export interface TrainingJobResult {
  weightsByAgentId: Record<number, Uint8Array>;
  statsByAgentId: Record<number, { games: number; wins: number; losses: number }>;
  providerAddress: string;
  totalGames: number;
}

/** Adapt a viem WalletClient into an ethers JsonRpcSigner the broker accepts.
 * viem's `transport` isn't itself an Eip1193Provider — but `walletClient.request`
 * is the EIP-1193 request method, which is all ethers needs. */
async function walletClientToSigner(
  walletClient: WalletClient,
): Promise<ethers.JsonRpcSigner> {
  const { account, chain } = walletClient;
  if (!account || !chain) throw new Error("WalletClient missing account/chain");
  const network = { chainId: chain.id, name: chain.name };
  const eip1193: ethers.Eip1193Provider = {
    request: (args: { method: string; params?: unknown[] }) =>
      (walletClient.request as unknown as (a: typeof args) => Promise<unknown>)(args),
  };
  const provider = new ethers.BrowserProvider(eip1193, network);
  return provider.getSigner(account.address);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function submitTrainingJob(
  input: TrainingJobInput,
): Promise<TrainingJobResult> {
  const { agentIds, epochs, weightsByAgentId, walletClient, seed, onProgress } = input;
  if (agentIds.length < 2) throw new Error("at least 2 agents required");

  onProgress?.({ step: "init", detail: "Connecting to 0G serving broker" });

  // Dynamic import keeps the broker bundle out of the initial page load.
  const { createZGComputeNetworkBroker } = await import("@0glabs/0g-serving-broker");

  const signer = await walletClientToSigner(walletClient);
  const broker = await createZGComputeNetworkBroker(signer);

  onProgress?.({ step: "discover", detail: `Looking up ${MODEL_FILTER} provider` });

  const services = await broker.inference.listService();
  const match = services.find((s: { model?: string; serviceType?: string }) => {
    const m = (s.model ?? "").toLowerCase();
    const t = (s.serviceType ?? "").toLowerCase();
    return m.includes(MODEL_FILTER) || t.includes("backgammon-train");
  });
  if (!match) {
    throw new OgTrainingUnavailable(
      `No ${MODEL_FILTER} provider registered on 0G Compute. ` +
        `When a GPU provider stands one up, training will go through ` +
        `the user's MetaMask wallet automatically — no server needed.`,
    );
  }
  const providerAddress = (match as { provider: string }).provider;

  onProgress?.({ step: "fund", detail: "Topping up 0G ledger sub-account" });

  try {
    await broker.ledger.getLedger();
  } catch {
    await broker.ledger.addLedger(DEPOSIT_OG);
  }
  try {
    const acct = await broker.inference.getAccount(providerAddress);
    const locked = BigInt((acct as unknown as bigint[])[3] ?? 0n);
    const target = ethers.parseEther(MIN_BALANCE_OG.toString());
    if (locked < target) {
      await broker.ledger.transferFund(providerAddress, "inference", target - locked);
    }
  } catch {
    // Best effort — the POST below will fail with a clear error if funding is bad.
  }

  onProgress?.({ step: "submit", detail: "Submitting training job to provider" });

  const { endpoint } = await broker.inference.getServiceMetadata(providerAddress);
  const headers = await broker.inference.getRequestHeaders(providerAddress);

  const body = {
    epochs,
    seed: seed ?? 42,
    weights: Object.fromEntries(
      agentIds.map((id) => [String(id), bytesToBase64(weightsByAgentId[id])]),
    ),
  };

  const resp = await fetch(`${endpoint}/train`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Provider returned ${resp.status}: ${text.slice(0, 400)}`);
  }
  const json = (await resp.json()) as {
    weights: Record<string, string>;
    stats: Record<string, { games: number; wins: number; losses?: number }>;
    total_games?: number;
  };

  const updatedWeights: Record<number, Uint8Array> = {};
  for (const id of agentIds) {
    const b64 = json.weights?.[String(id)];
    if (!b64) throw new Error(`Provider response missing weights for agent ${id}`);
    updatedWeights[id] = base64ToBytes(b64);
  }
  const stats: Record<number, { games: number; wins: number; losses: number }> = {};
  for (const id of agentIds) {
    const s = json.stats?.[String(id)] ?? { games: 0, wins: 0 };
    stats[id] = {
      games: s.games ?? 0,
      wins: s.wins ?? 0,
      losses: s.losses ?? Math.max(0, (s.games ?? 0) - (s.wins ?? 0)),
    };
  }

  onProgress?.({ step: "done" });

  return {
    weightsByAgentId: updatedWeights,
    statsByAgentId: stats,
    providerAddress,
    totalGames: json.total_games ?? agentIds.length * (agentIds.length - 1) * epochs,
  };
}
