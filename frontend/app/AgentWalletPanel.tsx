"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { useActiveChain } from "./chains";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";
const POLL_MS = 5_000;

interface Props {
  agentId: number;
  stakeAmount?: bigint;
  /** @deprecated alias for stakeAmount */
  stakeWei?: bigint;
  /** @deprecated ignored — USDC only */
  useUsdc?: boolean;
  onBalanceChange?: (balance: bigint) => void;
}

interface PrivyWallet {
  agent_id: number;
  wallet_id: string;
  address: string;
  chain_type: string;
  usdc_balance: string | null;
  auth_key_id: string | null;
  last_tx_hash: string | null;
  last_tx_amount_usdc: string | null;
  last_tx_ts: number | null;
}

function fmtUsdc(raw: bigint): string {
  const n = Number(raw) / 1_000_000;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)  return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function AgentWalletPanel({
  agentId,
  stakeAmount,
  stakeWei,
  onBalanceChange,
}: Props) {
  const stake = stakeAmount ?? stakeWei ?? BigInt(0);
  const { t } = useI18n();
  const activeChain = useActiveChain();
  const explorerUrl = activeChain?.chain.blockExplorers?.default.url ?? "";

  const [wallet, setWallet] = useState<PrivyWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [enablingKey, setEnablingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyWallet = useCallback((data: PrivyWallet) => {
    setWallet(data);
    if (data.usdc_balance !== null) {
      onBalanceChange?.(BigInt(data.usdc_balance));
    }
  }, [onBalanceChange]);

  // GET — read-only poll, used after initial provision.
  const fetchLatest = useCallback(async () => {
    try {
      const r = await fetch(`${SERVER}/agents/${agentId}/privy-wallet`);
      if (r.ok) applyWallet(await r.json() as PrivyWallet);
    } catch {
      // silent — best-effort refresh
    }
  }, [agentId, applyWallet]);

  // POST — provision + auto-register auth key on first load.
  const provision = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER}/agents/${agentId}/privy-wallet`, { method: "POST" });
      if (r.status === 503) { setError("Privy not configured on this server."); return; }
      if (!r.ok) throw new Error(`${r.status}`);
      applyWallet(await r.json() as PrivyWallet);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, applyWallet]);

  // Auto-load on mount, then poll every 5 s.
  useEffect(() => {
    void provision();
  }, [provision]);

  useEffect(() => {
    if (!wallet) return;
    pollRef.current = setInterval(() => { void fetchLatest(); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [wallet, fetchLatest]);

  const enableAuthKey = async () => {
    setEnablingKey(true);
    try {
      const r = await fetch(`${SERVER}/agents/${agentId}/privy-wallet/auth-key`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      // Refresh full state to get auth_key_id back.
      await fetchLatest();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnablingKey(false);
    }
  };

  const copyAddress = async () => {
    if (!wallet?.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const usdcRaw     = wallet?.usdc_balance ? BigInt(wallet.usdc_balance) : BigInt(0);
  const shortfall   = stake > usdcRaw ? stake - usdcRaw : BigInt(0);
  const needsFunding = stake > BigInt(0) && shortfall > BigInt(0);

  // ── not yet loaded ──────────────────────────────────────────────────────────
  if (!wallet) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Agent #{agentId} wallet</span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400">Privy</span>
        </div>
        {error
          ? <p className="text-red-600 dark:text-red-400">{error}</p>
          : <p className="text-zinc-500 dark:text-zinc-400">{loading ? "Loading…" : "—"}</p>
        }
      </div>
    );
  }

  const shortAddr = `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`;
  const hasAuthKey = !!wallet.auth_key_id;

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950 space-y-2">

      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Agent #{agentId} wallet</span>
        <span className="font-mono text-zinc-500 dark:text-zinc-400">Privy · USDC</span>
      </div>

      {/* Address */}
      <div className="flex items-center justify-between gap-2">
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
      <div className="flex items-baseline justify-between">
        <span className="text-zinc-500 dark:text-zinc-400">{t("balance")}</span>
        <span className={`font-mono font-semibold ${needsFunding ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}>
          {wallet.usdc_balance !== null ? `${fmtUsdc(usdcRaw)} USDC` : "—"}
        </span>
      </div>

      {needsFunding && (
        <p className="text-amber-600 dark:text-amber-400">
          Send {fmtUsdc(shortfall)} USDC to the address above to fund this match.
        </p>
      )}

      {/* Autonomous signing badge */}
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 dark:text-zinc-400">Autonomous signing</span>
        {hasAuthKey ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 font-mono">
            ✓ enabled
          </span>
        ) : (
          <button
            type="button"
            disabled={enablingKey}
            onClick={() => void enableAuthKey()}
            className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300"
          >
            {enablingKey ? "…" : "Enable"}
          </button>
        )}
      </div>

      {/* Last autonomous tx */}
      {wallet.last_tx_hash && wallet.last_tx_ts && (
        <div className="border-t border-zinc-200 pt-2 dark:border-zinc-800">
          <div className="flex items-baseline justify-between gap-1">
            <span className="text-zinc-500 dark:text-zinc-400">Last autonomous tx</span>
            <span className="text-zinc-400 dark:text-zinc-500">{timeAgo(wallet.last_tx_ts)}</span>
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-1">
            {wallet.last_tx_amount_usdc && (
              <span className="text-emerald-700 dark:text-emerald-400 font-mono">
                +{fmtUsdc(BigInt(wallet.last_tx_amount_usdc))} USDC
              </span>
            )}
            {explorerUrl ? (
              <a
                href={`${explorerUrl}/tx/${wallet.last_tx_hash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-indigo-600 hover:underline dark:text-indigo-400 truncate max-w-[12ch]"
              >
                {wallet.last_tx_hash.slice(0, 10)}…
              </a>
            ) : (
              <span className="font-mono text-zinc-400 truncate">{wallet.last_tx_hash.slice(0, 10)}…</span>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
