"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from "wagmi";

import { AgentVaultABI, useChainContracts } from "./contracts";
import { useSponsoredWrite } from "./useSponsoredWrite";
import { useActiveChainId } from "./chains";
import { useI18n } from "./i18n";

interface Props {
  agentId: number;
  /** Required stake in wei — drives the "Fund agent" shortfall label. */
  stakeWei: bigint;
  /** Called after a balance change — lets the parent gate Start on balance >= stake. */
  onBalanceChange?: (balanceWei: bigint) => void;
}

function formatEth(wei: bigint): string {
  const ether = Number(wei) / 1e18;
  return ether.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Displays the agent's on-chain vault balance and exposes Fund / Withdraw
 * buttons that talk directly to AgentVault — no server involved. */
export function AgentWalletPanel({ agentId, stakeWei, onBalanceChange }: Props) {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const chainId = useActiveChainId();
  const { agentVault } = useChainContracts();

  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noVault = !agentVault || agentVault === "0x0000000000000000000000000000000000000000";

  // Read balance directly from the vault contract.
  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: agentVault,
    abi: AgentVaultABI,
    functionName: "balances",
    args: [BigInt(agentId)],
    chainId,
    query: { enabled: !noVault && agentId > 0 },
  });

  const { writeContractAsync } = useSponsoredWrite();

  const balanceWei = (rawBalance as bigint | undefined) ?? BigInt(0);
  const shortfall = stakeWei > balanceWei ? stakeWei - balanceWei : BigInt(0);
  const needsFunding = shortfall > BigInt(0);

  const refresh = useCallback(async () => {
    const result = await refetchBalance();
    const bal = (result.data as bigint | undefined) ?? BigInt(0);
    onBalanceChange?.(bal);
  }, [refetchBalance, onBalanceChange]);

  const onFund = async () => {
    if (!walletClient || !address) { setError(t("connect_to_fund")); return; }
    if (noVault) { setError(t("vault_not_deployed")); return; }
    const value = shortfall > BigInt(0) ? shortfall : stakeWei > BigInt(0) ? stakeWei : BigInt(10) ** BigInt(15); // 0.001 ETH default top-up
    try {
      setBusy(true); setError(null);
      const hash = await writeContractAsync({
        address: agentVault,
        abi: AgentVaultABI,
        functionName: "deposit",
        args: [BigInt(agentId)],
        value,
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onWithdraw = async () => {
    if (!address) { setError(t("connect_to_withdraw")); return; }
    if (noVault) { setError(t("vault_not_deployed")); return; }
    if (balanceWei === BigInt(0)) { setError(t("nothing_to_withdraw")); return; }
    try {
      setBusy(true); setError(null);
      const hash = await writeContractAsync({
        address: agentVault,
        abi: AgentVaultABI,
        functionName: "withdrawAll",
        args: [BigInt(agentId), address],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (noVault) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        {t("vault_not_deployed_chain")}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Agent #{agentId} vault
        </span>
        <span className="font-mono text-zinc-500 dark:text-zinc-400">{t("on_chain")}</span>
      </div>

      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-zinc-500 dark:text-zinc-400">{t("balance")}</span>
        <span className={`font-mono ${needsFunding ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}>
          {formatEth(balanceWei)} ETH
        </span>
      </div>

      {needsFunding && stakeWei > BigInt(0) && (
        <p className="mb-2 text-amber-600 dark:text-amber-400">
          {t("need_eth_more").replace("{n}", formatEth(shortfall))}
        </p>
      )}
      {error && <p className="mb-2 text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onFund}
          disabled={busy || !isConnected}
          className="flex-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          title={needsFunding ? `Deposit ${formatEth(shortfall)} ETH` : "Top up vault"}
        >
          {busy ? "…" : needsFunding ? `Fund ${formatEth(shortfall)} ETH` : t("top_up")}
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          disabled={busy || !isConnected || balanceWei === BigInt(0)}
          className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {t("withdraw_all")}
        </button>
      </div>
    </div>
  );
}
