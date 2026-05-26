"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from "wagmi";

import { AgentVaultABI, AgentVaultTokenABI, ERC20ABI, useChainContracts } from "./contracts";
import { useSponsoredWrite } from "./useSponsoredWrite";
import { useActiveChainId } from "./chains";
import { useI18n } from "./i18n";

const USDC_DECIMALS = 6;
const ETH_DECIMALS = 18;

interface Props {
  agentId: number;
  /** Required stake — in wei (ETH mode) or USDC units (USDC mode). */
  stakeAmount?: bigint;
  /** @deprecated alias for stakeAmount; used by ETH callers. */
  stakeWei?: bigint;
  /** When true, uses AgentVaultToken + USDC instead of AgentVault + ETH. */
  useUsdc?: boolean;
  onBalanceChange?: (balance: bigint) => void;
}

function formatToken(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals === 6 ? 2 : 4 });
}

export function AgentWalletPanel({
  agentId,
  stakeAmount,
  stakeWei,
  useUsdc = false,
  onBalanceChange,
}: Props) {
  const stake = stakeAmount ?? stakeWei ?? BigInt(0);
  const decimals = useUsdc ? USDC_DECIMALS : ETH_DECIMALS;
  const symbol = useUsdc ? "USDC" : "ETH";

  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const chainId = useActiveChainId();
  const { agentVault, agentVaultToken, usdcToken } = useChainContracts();

  const vaultAddress = useUsdc ? agentVaultToken : agentVault;
  const vaultABI = useUsdc ? AgentVaultTokenABI : AgentVaultABI;

  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noVault = !vaultAddress || vaultAddress === "0x0000000000000000000000000000000000000000";

  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: vaultAddress,
    abi: vaultABI,
    functionName: "balances",
    args: [BigInt(agentId)],
    chainId,
    query: { enabled: !noVault && agentId > 0 },
  });

  const { writeContractAsync } = useSponsoredWrite();

  const balanceRaw = (rawBalance as bigint | undefined) ?? BigInt(0);
  const shortfall = stake > balanceRaw ? stake - balanceRaw : BigInt(0);
  const needsFunding = shortfall > BigInt(0);

  const refresh = useCallback(async () => {
    const result = await refetchBalance();
    const bal = (result.data as bigint | undefined) ?? BigInt(0);
    onBalanceChange?.(bal);
  }, [refetchBalance, onBalanceChange]);

  const onFund = async () => {
    if (!walletClient || !address) { setError(t("connect_to_fund")); return; }
    if (noVault) { setError(t("vault_not_deployed")); return; }

    const topUp = shortfall > BigInt(0)
      ? shortfall
      : stake > BigInt(0)
        ? stake
        : useUsdc
          ? BigInt(10 * 10 ** USDC_DECIMALS)  // 10 USDC default top-up
          : BigInt(10) ** BigInt(15);           // 0.001 ETH default top-up

    try {
      setBusy(true); setError(null);

      if (useUsdc) {
        // Step 1: approve AgentVaultToken to pull USDC.
        const approveTx = await writeContractAsync({
          address: usdcToken,
          abi: ERC20ABI,
          functionName: "approve",
          args: [agentVaultToken, topUp],
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approveTx });

        // Step 2: deposit USDC into vault.
        const hash = await writeContractAsync({
          address: agentVaultToken,
          abi: AgentVaultTokenABI,
          functionName: "deposit",
          args: [BigInt(agentId), topUp],
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      } else {
        const hash = await writeContractAsync({
          address: agentVault,
          abi: AgentVaultABI,
          functionName: "deposit",
          args: [BigInt(agentId)],
          value: topUp,
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      }

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
    if (balanceRaw === BigInt(0)) { setError(t("nothing_to_withdraw")); return; }
    try {
      setBusy(true); setError(null);
      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: vaultABI,
        functionName: "withdrawAll",
        args: useUsdc ? [BigInt(agentId), address] : [BigInt(agentId), address],
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

  const fmt = (v: bigint) => formatToken(v, decimals);

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
          {fmt(balanceRaw)} {symbol}
        </span>
      </div>

      {needsFunding && stake > BigInt(0) && (
        <p className="mb-2 text-amber-600 dark:text-amber-400">
          {t("need_token_more").replace("{n}", fmt(shortfall)).replace("{symbol}", symbol)}
        </p>
      )}
      {error && <p className="mb-2 text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void onFund()}
          disabled={busy || !isConnected}
          className="flex-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          title={needsFunding ? `Deposit ${fmt(shortfall)} ${symbol}` : `Top up vault`}
        >
          {busy ? "…" : needsFunding ? `Fund ${fmt(shortfall)} ${symbol}` : t("top_up")}
        </button>
        <button
          type="button"
          onClick={() => void onWithdraw()}
          disabled={busy || !isConnected || balanceRaw === BigInt(0)}
          className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {t("withdraw_all")}
        </button>
      </div>
    </div>
  );
}
