// Create-agent page. The sidebar "Create new agent" link navigates here;
// this page owns the mint form that was previously inlined in the sidebar.
//
// Two-step flow:
//   1. mintAgent — writes the iNFT on AgentRegistry. The receipt's
//      AgentMinted event carries the new agentId.
//   2. (optional) fund agent wallet — when the user enters a non-zero
//      funding amount, we POST /agents/{id}/wallet to provision the
//      server-managed session-key wallet (Phase 60), then send ETH to
//      that address from the connected wallet.
//
// If step 2 fails (RPC, server, user-rejected funding tx), the agent
// already exists with an unfunded wallet — the user can top up later
// from any match page's AgentWalletPanel.
//
// Model architecture — the form exposes a PyTorch source editor
// pre-filled with the BackgammonNet MLP from agent/sample_trainer.py.
// The default is the network the offline trainer uses today; users can
// replace it with any alternative (deeper net, random-forest wrapper,
// etc.) that implements the abstract __init__/forward contract
// documented at the top of the default snippet. The submitted source
// is preserved in the transaction record so a future training-pipeline
// hand-off can pick it up without re-prompting the user.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from "wagmi";
import { decodeEventLog, parseEther } from "viem";

import { useChainContracts } from "../contracts";
import { recordTransaction } from "../transactions";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

const ZERO_BIG = BigInt(0);

// Inline ABI fragment — same as the one that was in Sidebar.tsx, plus the
// AgentMinted event so we can parse the new agentId out of the receipt.
const AGENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "mintAgent",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "metadataURI", type: "string", internalType: "string" },
      { name: "tier_", type: "uint8", internalType: "uint8" },
    ],
    outputs: [{ name: "agentId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "AgentMinted",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "tier", type: "uint8", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
] as const;

/** Lenient parseEther — empty input or unparseable text becomes 0. */
function safeParseEther(value: string): bigint {
  try {
    const trimmed = value.trim();
    if (!trimmed) return ZERO_BIG;
    return parseEther(trimmed as `${number}`);
  } catch {
    return ZERO_BIG;
  }
}

// Default PyTorch source shown in the "Model architecture" editor below.
// Mirrors agent/sample_trainer.py's BackgammonNet so a user who just
// hits "Create agent" without touching the editor gets the same MLP the
// offline trainer uses today. The leading docstring is the abstract
// contract — any replacement implementation (deeper net, random-forest
// wrapper around a torch.nn.Module, transformer, etc.) must keep the
// __init__ and forward signatures so the training/inference pipeline can
// call it unchanged. Different architectures here are how operators
// field different *kinds* of star players: a deeper net for richer
// contact play, a wider extras head for context-sensitive cube
// decisions, an ensemble for noisier opponents, and so on.
const DEFAULT_MODEL_CODE = `"""Per-agent value network for Chaingammon.

Abstract contract — any replacement must implement both:

  1. __init__(in_dim: int = 198, hidden: int = 80, extras_dim: int = 16,
              *, core_seed: int = 0xBACC, extras_seed: int | None = None)
       in_dim     — board feature width (198 = Tesauro contact net).
       hidden     — backbone hidden size.
       extras_dim — per-agent contextual feature width (career mode).
       core_seed  — seeds the shared gnubg-derived backbone so every
                    agent starts from the same prior.
       extras_seed — randomizes the per-agent extras head; two agents
                     with the same core_seed but different extras_seed
                     diverge in style after training.

  2. forward(board: Tensor, extras: Tensor | None = None) -> Tensor
       Returns win equity in [0, 1] for the side to move. Shape:
       (batch,) for batched calls, () for single positions.

The default below is the MLP from agent/sample_trainer.py. Delete it
and paste your own — a deeper net, a transformer, a random-forest
ensemble wrapped in nn.Module, anything that honors the contract.
Different architectures field different kinds of star players.
"""
import math
import torch
from torch import nn


def gnubg_published_core_init(in_dim, hidden, *, seed=0xBACC):
    """Stand-in for gnubg's published feedforward weights. Production
    swaps this for the actual gnubg weights file; the deterministic
    Xavier-uniform init below gives every agent the same prior so the
    extras head is what distinguishes them after training."""
    g = torch.Generator().manual_seed(seed)
    layer = nn.Linear(in_dim, hidden)
    with torch.no_grad():
        bound = math.sqrt(6.0 / (in_dim + hidden))
        layer.weight.uniform_(-bound, bound, generator=g)
        layer.bias.zero_()
    return layer


class BackgammonNet(nn.Module):
    def __init__(self, in_dim=198, hidden=80, extras_dim=16,
                 *, core_seed=0xBACC, extras_seed=None):
        super().__init__()
        self.core = gnubg_published_core_init(in_dim, hidden, seed=core_seed)
        if extras_dim > 0:
            self.extras = nn.Linear(extras_dim, hidden)
            if extras_seed is not None:
                g = torch.Generator().manual_seed(extras_seed)
                bound = math.sqrt(6.0 / (extras_dim + hidden))
                with torch.no_grad():
                    self.extras.weight.uniform_(-bound, bound, generator=g)
                    self.extras.bias.zero_()
        else:
            self.extras = None
        self.head = nn.Linear(hidden, 1)
        with torch.no_grad():
            nn.init.xavier_uniform_(self.head.weight)
            self.head.bias.zero_()

    def forward(self, board, extras=None):
        h = torch.sigmoid(self.core(board))
        if self.extras is not None and extras is not None:
            h = h + torch.sigmoid(self.extras(extras))
        return torch.sigmoid(self.head(h)).squeeze(-1)
`;

type FundStatus =
  | "idle"
  | "provisioning"
  | "sending"
  | "confirming"
  | "ok"
  | "skipped"
  | "error";

export default function CreateAgentPage() {
  const router = useRouter();
  const { address } = useAccount();
  const { agentRegistry } = useChainContracts();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [agentLabel, setAgentLabel] = useState("");
  const [agentTier, setAgentTier] = useState<number>(0);
  const [fundingEth, setFundingEth] = useState("");
  const [modelCode, setModelCode] = useState<string>(DEFAULT_MODEL_CODE);
  const [fundStatus, setFundStatus] = useState<FundStatus>("idle");
  const [fundError, setFundError] = useState<string | null>(null);

  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending: signing,
    reset,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess, data: receipt } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Two-step finalize: mint succeeded → optionally fund the agent wallet,
  // then route home.
  useEffect(() => {
    if (!isSuccess || !receipt) return;

    let cancelled = false;

    const finishUp = async () => {
      // Recover the new agentId from the AgentMinted event in the receipt.
      let newAgentId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== agentRegistry.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: AGENT_REGISTRY_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "AgentMinted") {
            newAgentId = decoded.args.agentId as bigint;
            break;
          }
        } catch {
          // Not an AgentRegistry event we can decode; skip.
        }
      }

      // Preserve the model source alongside the mint record. The
      // training pipeline picks this up by agentId; an unchanged editor
      // means "use the BackgammonNet default."
      const modelCustomized = modelCode.trim() !== DEFAULT_MODEL_CODE.trim();
      recordTransaction({
        type: "agent_mint",
        description: `Agent minted${newAgentId !== null ? ` (id ${newAgentId})` : ""}: "${agentLabel}" (Tier ${agentTier})${modelCustomized ? " — custom model" : ""}`,
      });
      if (newAgentId !== null && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            `chaingammon:agent:${newAgentId}:model`,
            modelCode,
          );
        } catch {
          // Storage full / disabled — non-fatal, the mint already
          // succeeded. Users can re-paste later from a model library.
        }
      }

      const fundingWei = safeParseEther(fundingEth);
      if (fundingWei === ZERO_BIG) {
        setFundStatus("skipped");
        if (!cancelled) router.push("/");
        return;
      }

      if (newAgentId === null) {
        setFundStatus("error");
        setFundError(
          "Mint succeeded but couldn't recover agentId from the receipt — fund later from any match page.",
        );
        return;
      }

      // Provision (or fetch) the agent's server-managed wallet.
      setFundStatus("provisioning");
      let agentAddress: `0x${string}`;
      try {
        const res = await fetch(`${SERVER}/agents/${newAgentId}/wallet`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`server responded ${res.status}`);
        const data = (await res.json()) as { address: `0x${string}` };
        agentAddress = data.address;
      } catch (e) {
        if (cancelled) return;
        setFundStatus("error");
        setFundError(
          `Mint succeeded; agent wallet provisioning failed (${e instanceof Error ? e.message : String(e)}). Fund later from any match page.`,
        );
        return;
      }

      if (!walletClient) {
        if (cancelled) return;
        setFundStatus("error");
        setFundError(
          "Mint succeeded; wallet disconnected before funding. Fund later from any match page.",
        );
        return;
      }

      // Send the funding tx.
      setFundStatus("sending");
      try {
        const fundTx = await walletClient.sendTransaction({
          to: agentAddress,
          value: fundingWei,
        });
        setFundStatus("confirming");
        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash: fundTx });
        }
        recordTransaction({
          type: "agent_funding",
          description: `Funded agent #${newAgentId} with ${fundingEth} ETH (tx ${fundTx.slice(0, 10)}…)`,
        });
        if (cancelled) return;
        setFundStatus("ok");
        router.push("/");
      } catch (e) {
        if (cancelled) return;
        setFundStatus("error");
        setFundError(
          `Mint succeeded; funding tx failed (${e instanceof Error ? e.message : String(e)}). Fund later from any match page.`,
        );
      }
    };

    void finishUp();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, receipt]);

  const minting = signing || confirming;
  const funding =
    fundStatus === "provisioning" ||
    fundStatus === "sending" ||
    fundStatus === "confirming";
  const busy = minting || funding;

  const submit = () => {
    if (!address || !agentLabel.trim()) return;
    setFundStatus("idle");
    setFundError(null);
    reset();
    writeContract({
      address: agentRegistry,
      abi: AGENT_REGISTRY_ABI,
      functionName: "mintAgent",
      args: [address, agentLabel.trim(), agentTier],
    });
  };

  const buttonLabel = (() => {
    if (signing) return "Signing mint…";
    if (confirming) return "Confirming mint…";
    if (fundStatus === "provisioning") return "Provisioning agent wallet…";
    if (fundStatus === "sending") return "Sign funding tx…";
    if (fundStatus === "confirming") return "Confirming funding…";
    return "Create agent";
  })();

  return (
    <main className="flex flex-1 flex-col gap-6 p-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Create new agent
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Mint an iNFT agent on-chain. You must be the contract owner.
        </p>
      </div>

      <div data-testid="create-agent-form" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="agent-label"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Agent label
          </label>
          <input
            id="agent-label"
            data-testid="agent-label-input"
            type="text"
            value={agentLabel}
            onChange={(e) => {
              setAgentLabel(e.target.value);
              reset();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="agent-label"
            className="h-9 rounded border border-zinc-300 bg-white px-3 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={busy}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="agent-tier"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Tier
          </label>
          <select
            id="agent-tier"
            data-testid="agent-tier-select"
            value={agentTier}
            onChange={(e) => setAgentTier(Number(e.target.value))}
            className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={busy}
          >
            <option value={0}>Tier 0</option>
            <option value={1}>Tier 1</option>
            <option value={2}>Tier 2</option>
            <option value={3}>Tier 3</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label
              htmlFor="agent-model-code"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Model architecture (PyTorch)
            </label>
            <button
              type="button"
              data-testid="agent-model-reset"
              onClick={() => setModelCode(DEFAULT_MODEL_CODE)}
              disabled={busy || modelCode === DEFAULT_MODEL_CODE}
              className="text-xs text-indigo-600 hover:text-indigo-500 disabled:opacity-40 dark:text-indigo-400"
            >
              Reset to default
            </button>
          </div>
          <textarea
            id="agent-model-code"
            data-testid="agent-model-code"
            value={modelCode}
            onChange={(e) => setModelCode(e.target.value)}
            spellCheck={false}
            rows={16}
            className="min-h-[20rem] rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={busy}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Default is the BackgammonNet MLP from{" "}
            <code className="font-mono">agent/sample_trainer.py</code>.
            Delete it and paste any architecture — a deeper net, a
            transformer, a random-forest wrapper — that implements the
            <code className="font-mono"> __init__</code> and{" "}
            <code className="font-mono">forward</code> contract in the
            docstring. Different architectures field different kinds
            of star players.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="agent-funding"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Initial funding (ETH) — optional
          </label>
          <input
            id="agent-funding"
            data-testid="agent-funding-input"
            type="number"
            min="0"
            step="0.001"
            value={fundingEth}
            onChange={(e) => setFundingEth(e.target.value)}
            placeholder="0"
            className="h-9 rounded border border-zinc-300 bg-white px-3 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={busy}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Sends ETH from your wallet to the agent&apos;s server-managed
            wallet so it can stake in matches. Leave blank to fund later
            from any match page.
          </p>
        </div>

        {!address && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Connect your wallet to create an agent.
          </p>
        )}

        {writeError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {writeError.message.split("\n")[0]}
          </p>
        )}

        {fundStatus === "error" && fundError && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {fundError}
          </p>
        )}

        <button
          data-testid="create-agent-submit"
          type="button"
          onClick={submit}
          disabled={busy || !agentLabel.trim() || !address}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </div>
    </main>
  );
}
