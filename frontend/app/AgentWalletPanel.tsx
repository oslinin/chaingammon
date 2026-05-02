"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useWalletClient,
} from "wagmi";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

interface WalletState {
  address: `0x${string}`;
  balance_wei: string;
}

interface Props {
  agentId: number;
  /** Required stake in wei. Drives the "Fund agent" shortfall calculation
   * and the at-a-glance "needs funding?" indicator. */
  stakeWei: bigint;
  /** Called after a wallet refresh — useful so the parent component can
   * gate "Start" on `agentBalanceWei >= stakeWei`. */
  onWalletChange?: (state: WalletState | null) => void;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatEth(wei: bigint): string {
  // Format with up to 4 decimal places — enough for the stake range we
  // expect (0.001 to a few ETH on testnet) without spamming digits.
  const ether = Number(wei) / 1e18;
  return ether.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Fetches /agents/{id}/wallet, auto-creates if 404, shows balance, and
 * exposes Fund / Withdraw buttons that talk to the connected wallet
 * (Fund) and the server (Withdraw). Refreshes balance after each action.
 */
export function AgentWalletPanel({ agentId, stakeWei, onWalletChange }: Props) {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      let res = await fetch(`${SERVER}/agents/${agentId}/wallet`);
      if (res.status === 404) {
        // Provision lazily on first visit.
        res = await fetch(`${SERVER}/agents/${agentId}/wallet`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`provision failed: ${res.statusText}`);
        // Re-GET to pick up the balance (POST returns address only).
        res = await fetch(`${SERVER}/agents/${agentId}/wallet`);
      }
      if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
      const data: WalletState = await res.json();
      setWallet(data);
      setError(null);
      onWalletChange?.(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setWallet(null);
      onWalletChange?.(null);
    }
  }, [agentId, onWalletChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const balanceWei = wallet ? BigInt(wallet.balance_wei) : BigInt(0);
  const shortfall = stakeWei > balanceWei ? stakeWei - balanceWei : BigInt(0);
  const needsFunding = shortfall > BigInt(0);

  const onFund = async () => {
    if (!wallet || !walletClient || !address) {
      setError("Connect your wallet to fund the agent.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const txHash = await walletClient.sendTransaction({
        to: wallet.address,
        value: shortfall > BigInt(0) ? shortfall : stakeWei,
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onWithdraw = async () => {
    if (!wallet || !address) {
      setError("Connect your wallet to receive the withdrawal.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const res = await fetch(`${SERVER}/agents/${agentId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: address }),
      });
      if (!res.ok) {
        throw new Error(await res.text().catch(() => res.statusText));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!wallet && !error) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        Loading agent wallet…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Agent #{agentId} wallet
        </span>
        {wallet && (
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(wallet.address)}
            className="font-mono text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            title="Copy full address"
          >
            {shortAddr(wallet.address)}
          </button>
        )}
      </div>
      {wallet && (
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-zinc-500 dark:text-zinc-400">Balance</span>
          <span
            className={`font-mono ${needsFunding ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}
          >
            {formatEth(balanceWei)} ETH
          </span>
        </div>
      )}
      {needsFunding && stakeWei > BigInt(0) && (
        <p className="mb-2 text-amber-600 dark:text-amber-400">
          Need {formatEth(shortfall)} ETH more to cover the stake.
        </p>
      )}
      {error && (
        <p className="mb-2 text-red-600 dark:text-red-400">{error}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onFund}
          disabled={busy || !isConnected || stakeWei === BigInt(0)}
          className="flex-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          title={needsFunding ? `Send ${formatEth(shortfall)} ETH` : `Send ${formatEth(stakeWei)} ETH`}
        >
          {busy ? "…" : needsFunding ? `Fund ${formatEth(shortfall)} ETH` : "Top up"}
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          disabled={busy || !isConnected || balanceWei === BigInt(0)}
          className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Withdraw all
        </button>
      </div>
    </div>
  );
}
