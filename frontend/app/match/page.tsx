// match/page.tsx — KeeperHub pre-game card.
//
// Shows the KeeperHub mode info and optional ETH stake/escrow flow.
// On "Start Game" the user is forwarded to /team-demo?opponents=<agentId>
// for gameplay; KeeperHub auto-settlement runs via the server after the
// game ends regardless of which page hosts the board.
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useAccount,
  usePublicClient,
} from "wagmi";
import { parseEther } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { AgentWalletPanel } from "../AgentWalletPanel";
import { AgentVaultABI, MatchEscrowABI, useChainContracts } from "../contracts";
import { useSponsoredWrite } from "../useSponsoredWrite";
import { useAppMode } from "../AppModeContext";
import { useI18n } from "../i18n";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BIG = BigInt(0);

function safeParseEther(value: string): bigint {
  try {
    const trimmed = value.trim();
    if (!trimmed) return ZERO_BIG;
    return parseEther(trimmed as `${number}`);
  } catch {
    return ZERO_BIG;
  }
}

export default function MatchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Loading…</p>
        </div>
      }
    >
      <MatchInner />
    </Suspense>
  );
}

function MatchInner() {
  const params = useSearchParams();
  const router = useRouter();
  const agentId = Number(params.get("agentId") ?? "1");

  const [stakeEth, setStakeEth] = useState("");
  const [depositStatus, setDepositStatus] = useState<
    "idle" | "human-pending" | "agent-pending" | "ready" | "error"
  >("idle");
  const [depositError, setDepositError] = useState<string | null>(null);

  const { t } = useI18n();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { matchEscrow, agentVault } = useChainContracts();
  const { writeContractAsync } = useSponsoredWrite();
  const { mode } = useAppMode();
  const showStake = mode === "money" || mode === "advanced" || params.get("stake") === "1";

  const stakeWei = stakeEth.trim() ? safeParseEther(stakeEth) : ZERO_BIG;
  const isStaked = stakeWei > ZERO_BIG;
  const isDepositing =
    depositStatus === "human-pending" || depositStatus === "agent-pending";

  const onClickStart = async () => {
    // Once both sides have deposited (or no stake), navigate to gameplay.
    if (depositStatus === "ready" || !isStaked) {
      router.push(`/team-demo?opponents=${agentId}&settle=1`);
      return;
    }
    if (!isConnected || !address) {
      setDepositError(t("connect_to_stake"));
      setDepositStatus("error");
      return;
    }
    if (matchEscrow === ZERO_ADDR) {
      setDepositError(t("escrow_not_deployed"));
      setDepositStatus("error");
      return;
    }
    try {
      setDepositError(null);
      setDepositStatus("human-pending");
      const newMatchId = generatePrivateKey() as `0x${string}`;
      const humanTxHash = await writeContractAsync({
        abi: MatchEscrowABI,
        address: matchEscrow,
        functionName: "deposit",
        args: [newMatchId, stakeWei],
        value: stakeWei,
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: humanTxHash });
      }
      setDepositStatus("agent-pending");
      const agentTxHash = await writeContractAsync({
        abi: AgentVaultABI,
        address: agentVault,
        functionName: "depositToEscrow",
        args: [BigInt(agentId), newMatchId, stakeWei, matchEscrow],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: agentTxHash });
      }
      setDepositStatus("ready");
      // Both sides funded — navigate immediately.
      // Pass escrowMatchId and stakeWei so team-demo can call
      // settleWithSessionKeysAndSplit and actually pay out the pot.
      router.push(`/team-demo?opponents=${agentId}&settle=1&escrowMatchId=${newMatchId}&stakeWei=${stakeWei.toString()}`);
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : String(err));
      setDepositStatus("error");
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          {t("back_to_agents")}
        </Link>
        <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
          Agent #{agentId}
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
        {/* KeeperHub info card */}
        <div className="w-full rounded-xl border border-emerald-200 bg-emerald-50 p-6 dark:border-emerald-700/40 dark:bg-emerald-900/10">
          <h2 className="mb-2 text-lg font-semibold text-emerald-900 dark:text-emerald-200">
            {t("keeper_hub_mode")}
          </h2>
          <p className="text-sm leading-6 text-emerald-800 dark:text-emerald-300">
            {t("keeper_hub_desc")}
          </p>
          <ul className="mt-3 space-y-1 text-xs text-emerald-700 dark:text-emerald-400">
            <li>✓ {t("drand_dice_feature")}</li>
            <li>✓ {t("onnx_validation_feature")}</li>
            <li>✓ {t("auto_elo_feature")}</li>
          </ul>
        </div>

        {/* Stake card — visible in money and advanced modes only */}
        {showStake && (
          <div className="w-full rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <label
              htmlFor="stake-eth"
              className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              {t("stake_per_side_label")}
            </label>
            <input
              id="stake-eth"
              type="number"
              min="0"
              step="0.001"
              placeholder="0"
              disabled={isDepositing || depositStatus === "ready"}
              value={stakeEth}
              onChange={(e) => setStakeEth(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            {isStaked && (
              <>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {t("stake_info").replace("{n}", stakeEth)}
                </p>
                <div className="mt-3">
                  <AgentWalletPanel agentId={agentId} stakeWei={stakeWei} />
                </div>
              </>
            )}
            {depositStatus === "human-pending" && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                {t("confirm_deposit_wallet")}
              </p>
            )}
            {depositStatus === "agent-pending" && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                {t("agent_depositing")}
              </p>
            )}
            {depositStatus === "ready" && (
              <p className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
                {t("both_funded_start")}
              </p>
            )}
            {depositStatus === "error" && depositError && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400">
                {depositError}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onClickStart}
          disabled={isDepositing}
          className="w-full rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {isDepositing ? t("staking") : `${t("start_game_vs")}${agentId}`}
        </button>
      </main>
    </div>
  );
}
