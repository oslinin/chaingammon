"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useWalletClient,
  useSignMessage,
} from "wagmi";
import { parseEther } from "viem";

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
  const [customAmountStr, setCustomAmountStr] = useState<string>("0.1");
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [wallet]);

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

      let amountToSend = shortfall > BigInt(0) ? shortfall : stakeWei;
      if (stakeWei === BigInt(0)) {
         amountToSend = parseEther(customAmountStr);
      }

      if (amountToSend <= BigInt(0)) {
         throw new Error("Amount to send must be greater than 0");
      }

      const txHash = await walletClient.sendTransaction({
        to: wallet.address,
        value: amountToSend,
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

  const { signMessageAsync } = useSignMessage();

  const onWithdraw = async () => {
    if (!wallet || !address) {
      setError("Connect your wallet to receive the withdrawal.");
      return;
    }
    try {
      setBusy(true);
      setError(null);

      const signature = await signMessageAsync({
        message: `Withdraw agent ${agentId} funds`,
      });

      let amountWei;
      if (stakeWei === BigInt(0)) {
         amountWei = parseEther(customAmountStr).toString();
      }

      const res = await fetch(`${SERVER}/agents/${agentId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: address, signature, amount_wei: amountWei }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        let parsedErr = errText;
        try {
          const parsed = JSON.parse(errText);
          parsedErr = parsed.detail || errText;
        } catch {}
        throw new Error(parsedErr);
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
            onClick={copyAddress}
            className="flex items-center gap-1 font-mono text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            title="Copy full address"
          >
            {shortAddr(wallet.address)}
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 4H2a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
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
      {stakeWei === BigInt(0) && (
        <div className="mb-2 flex items-center gap-2">
          <input
            type="number"
            step="0.001"
            min="0"
            value={customAmountStr}
            onChange={(e) => setCustomAmountStr(e.target.value)}
            className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="0.1"
            disabled={busy || !isConnected}
          />
          <span className="text-zinc-500 dark:text-zinc-400">ETH</span>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onFund}
          disabled={busy || !isConnected || (stakeWei === BigInt(0) && parseFloat(customAmountStr) <= 0)}
          className="flex-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          title={needsFunding ? `Send ${formatEth(shortfall)} ETH` : stakeWei === BigInt(0) ? `Send ${customAmountStr} ETH` : `Send ${formatEth(stakeWei)} ETH`}
        >
          {busy ? "…" : needsFunding ? `Fund ${formatEth(shortfall)} ETH` : "Top up"}
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          disabled={busy || !isConnected || balanceWei === BigInt(0) || (stakeWei === BigInt(0) && parseFloat(customAmountStr) <= 0)}
          className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title={stakeWei === BigInt(0) ? `Withdraw ${customAmountStr} ETH` : "Withdraw all"}
        >
          {stakeWei === BigInt(0) ? `Withdraw` : "Withdraw all"}
        </button>
      </div>
    </div>
  );
}
