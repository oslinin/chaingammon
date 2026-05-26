// match/page.tsx — KeeperHub pre-game card.
//
// Shows the KeeperHub mode info and optional USDC stake/escrow flow.
// Money games use MatchEscrowUsdc (ERC-20) instead of the legacy ETH
// MatchEscrow. The flow has an extra approval step:
//   1. Approve MatchEscrowUsdc to spend the stake amount.
//   2. Human deposits USDC → agent deposits USDC from AgentVaultToken.
//   3. Both funded → navigate to /team-demo for settlement.
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useAccount,
  usePublicClient,
  useReadContract,
} from "wagmi";
import { parseUnits } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { AgentWalletPanel } from "../AgentWalletPanel";
import {
  AgentVaultTokenABI,
  ERC20ABI,
  MatchEscrowUsdcABI,
  useChainContracts,
} from "../contracts";
import { useSponsoredWrite } from "../useSponsoredWrite";
import { useAppMode } from "../AppModeContext";
import { useActiveChainId } from "../chains";
import { useI18n } from "../i18n";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BIG = BigInt(0);
const USDC_DECIMALS = 6;

function safeParseUsdc(value: string): bigint {
  try {
    const trimmed = value.trim();
    if (!trimmed) return ZERO_BIG;
    return parseUnits(trimmed as `${number}`, USDC_DECIMALS);
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

  const [stakeUsdc, setStakeUsdc] = useState("");
  const [depositStatus, setDepositStatus] = useState<
    "idle" | "approving" | "human-pending" | "agent-pending" | "ready" | "error"
  >("idle");
  const [depositError, setDepositError] = useState<string | null>(null);

  const { t } = useI18n();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useActiveChainId();
  const { matchEscrowUsdc, agentVaultToken, usdcToken } = useChainContracts();
  const { writeContractAsync } = useSponsoredWrite();
  const { mode } = useAppMode();
  const showStake = mode === "money" || mode === "advanced" || params.get("stake") === "1";

  const stakeAmount = stakeUsdc.trim() ? safeParseUsdc(stakeUsdc) : ZERO_BIG;
  const isStaked = stakeAmount > ZERO_BIG;
  const isDepositing =
    depositStatus === "approving" ||
    depositStatus === "human-pending" ||
    depositStatus === "agent-pending";

  const noEscrow = !matchEscrowUsdc || matchEscrowUsdc === ZERO_ADDR;

  // Read current USDC allowance for the escrow contract.
  const { data: allowanceData } = useReadContract({
    address: usdcToken,
    abi: ERC20ABI,
    functionName: "allowance",
    args: address && !noEscrow ? [address, matchEscrowUsdc] : undefined,
    chainId,
    query: {
      enabled: isStaked && !noEscrow && !!address,
      refetchInterval: 5_000,
    },
  });
  const currentAllowance = (allowanceData as bigint | undefined) ?? ZERO_BIG;
  const needsApproval = isStaked && currentAllowance < stakeAmount;

  const onClickStart = async () => {
    if (depositStatus === "ready" || !isStaked) {
      router.push(`/team-demo?opponents=${agentId}&settle=1`);
      return;
    }
    if (!isConnected || !address) {
      setDepositError(t("connect_to_stake"));
      setDepositStatus("error");
      return;
    }
    if (noEscrow) {
      setDepositError(t("escrow_usdc_not_deployed"));
      setDepositStatus("error");
      return;
    }
    try {
      setDepositError(null);
      const newMatchId = generatePrivateKey() as `0x${string}`;

      // Step 1: approve MatchEscrowUsdc to spend USDC if needed.
      if (needsApproval) {
        setDepositStatus("approving");
        const approveTx = await writeContractAsync({
          abi: ERC20ABI,
          address: usdcToken,
          functionName: "approve",
          args: [matchEscrowUsdc, stakeAmount],
        });
        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
        }
      }

      // Step 2: human deposits USDC into escrow.
      setDepositStatus("human-pending");
      const humanTxHash = await writeContractAsync({
        abi: MatchEscrowUsdcABI,
        address: matchEscrowUsdc,
        functionName: "deposit",
        args: [newMatchId, stakeAmount],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: humanTxHash });
      }

      // Step 3: agent deposits USDC from AgentVaultToken into same escrow.
      setDepositStatus("agent-pending");
      const agentTxHash = await writeContractAsync({
        abi: AgentVaultTokenABI,
        address: agentVaultToken,
        functionName: "depositToEscrow",
        args: [BigInt(agentId), newMatchId, stakeAmount, matchEscrowUsdc],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: agentTxHash });
      }

      setDepositStatus("ready");
      router.push(
        `/team-demo?opponents=${agentId}&settle=1&escrowMatchId=${newMatchId}&stakeWei=${stakeAmount.toString()}`
      );
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
              htmlFor="stake-usdc"
              className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              {t("stake_per_side_label")}
            </label>
            <input
              id="stake-usdc"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              disabled={isDepositing || depositStatus === "ready"}
              value={stakeUsdc}
              onChange={(e) => setStakeUsdc(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            {isStaked && (
              <>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {t("stake_info").replace("{n}", stakeUsdc)}
                </p>
                <div className="mt-3">
                  <AgentWalletPanel
                    agentId={agentId}
                    stakeAmount={stakeAmount}
                    useUsdc
                  />
                </div>
              </>
            )}
            {depositStatus === "approving" && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                {t("approving_usdc")}
              </p>
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
          onClick={() => void onClickStart()}
          disabled={isDepositing}
          className="w-full rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {depositStatus === "approving"
            ? t("approving_usdc")
            : isDepositing
              ? t("staking")
              : `${t("start_game_vs")}${agentId}`}
        </button>
      </main>
    </div>
  );
}
