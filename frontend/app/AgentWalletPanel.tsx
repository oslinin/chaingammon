// [EthGlobalNYC26 PR 1.3] Privy-wallet panel — replaces the AgentVault
// deposit/withdraw UI. The agent's USDC lives in a Privy server wallet;
// the owner deposits by sending USDC directly to the wallet address.
"use client";

import { useCallback, useState } from "react";
import { useI18n } from "./i18n";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

interface Props {
  agentId: number;
  /** Required stake in USDC units (6 decimals). Used for shortfall display. */
  stakeAmount?: bigint;
  /** @deprecated alias for stakeAmount; kept for call-site compatibility. */
  stakeWei?: bigint;
  /** @deprecated — USDC is now the only denomination. Ignored. */
  useUsdc?: boolean;
  onBalanceChange?: (balance: bigint) => void;
}

interface PrivyWallet {
  agent_id: number;
  wallet_id: string;
  address: string;
  chain_type: string;
  usdc_balance: string | null;
}

function formatUsdc(raw: bigint): string {
  const n = Number(raw) / 1_000_000;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function AgentWalletPanel({
  agentId,
  stakeAmount,
  stakeWei,
  onBalanceChange,
}: Props) {
  const stake = stakeAmount ?? stakeWei ?? BigInt(0);
  const { t } = useI18n();

  const [wallet, setWallet] = useState<PrivyWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER}/agents/${agentId}/privy-wallet`, { method: "POST" });
      if (r.status === 503) {
        setError("Privy not configured on this server.");
        return;
      }
      if (!r.ok) throw new Error(`${r.status}`);
      const data: PrivyWallet = await r.json();
      setWallet(data);
      if (data.usdc_balance !== null) {
        onBalanceChange?.(BigInt(data.usdc_balance));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, onBalanceChange]);

  const provision = async () => {
    setProvisioning(true);
    await fetchWallet();
    setProvisioning(false);
  };

  const copyAddress = async () => {
    if (!wallet?.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const usdcRaw = wallet?.usdc_balance ? BigInt(wallet.usdc_balance) : BigInt(0);
  const shortfall = stake > usdcRaw ? stake - usdcRaw : BigInt(0);
  const needsFunding = stake > BigInt(0) && shortfall > BigInt(0);

  if (!wallet) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Agent #{agentId} wallet
          </span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400">Privy</span>
        </div>
        {error && <p className="mb-2 text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={() => void provision()}
          disabled={provisioning || loading}
          className="w-full rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
        >
          {provisioning || loading ? "…" : "Load wallet"}
        </button>
      </div>
    );
  }

  const shortAddr = `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`;

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Agent #{agentId} wallet
        </span>
        <span className="font-mono text-zinc-500 dark:text-zinc-400">Privy · USDC</span>
      </div>

      {/* Address */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-zinc-500 dark:text-zinc-400 truncate">{shortAddr}</span>
        <button
          type="button"
          onClick={() => void copyAddress()}
          className="shrink-0 rounded border border-zinc-300 bg-white px-2 py-0.5 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>

      {/* Balance */}
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-zinc-500 dark:text-zinc-400">{t("balance")}</span>
        <span className={`font-mono ${needsFunding ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}>
          {wallet.usdc_balance !== null ? `${formatUsdc(usdcRaw)} USDC` : "—"}
        </span>
      </div>

      {needsFunding && (
        <p className="mb-2 text-amber-600 dark:text-amber-400">
          Send {formatUsdc(shortfall)} USDC to the address above to fund this match.
        </p>
      )}
      {error && <p className="mb-2 text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="button"
        onClick={() => void fetchWallet()}
        disabled={loading}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {loading ? "…" : "Refresh balance"}
      </button>
    </div>
  );
}
