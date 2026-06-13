"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { AgentDividendVaultABI, ERC20ABI, useChainContracts } from "../../contracts";

const SHARE_PRICE_USDC = 1; // 1 USDC per share (mirrors SHARE_PRICE in contract)
const MAX_SHARES = 1_000_000;

function fmtUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function DividendVaultPanel({ agentId }: { agentId: number }) {
  const { address } = useAccount();
  const contracts = useChainContracts();
  const vault = contracts.agentDividendVault;
  const usdc  = contracts.usdcToken;

  const [sharesToBuy, setSharesToBuy] = useState("100");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const agentIdBig = BigInt(agentId);
  const noVault = !vault || vault === "0x0000000000000000000000000000000000000000";

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: vault, abi: AgentDividendVaultABI, functionName: "vaults",          args: [agentIdBig] },
      { address: vault, abi: AgentDividendVaultABI, functionName: "sharesOf",        args: [agentIdBig, address ?? "0x0000000000000000000000000000000000000000"] },
      { address: vault, abi: AgentDividendVaultABI, functionName: "pendingDividend", args: [agentIdBig, address ?? "0x0000000000000000000000000000000000000000"] },
      { address: usdc,  abi: ERC20ABI,              functionName: "allowance",       args: [address ?? "0x0000000000000000000000000000000000000000", vault] },
    ],
    query: { enabled: !noVault && !!address },
  });

  const { writeContractAsync } = useWriteContract();
  const { isLoading: txPending } = useWaitForTransactionReceipt({ hash: txHash });

  const vaultInfo   = data?.[0]?.result as [bigint, bigint] | undefined; // [accPerShare, totalShares] — tuple order from struct
  const myShares    = (data?.[1]?.result as bigint | undefined) ?? BigInt(0);
  const myPending   = (data?.[2]?.result as bigint | undefined) ?? BigInt(0);
  const allowance   = (data?.[3]?.result as bigint | undefined) ?? BigInt(0);

  // vaults() returns a struct; wagmi returns it as a tuple [accPerShare, totalShares]
  const totalShares = vaultInfo ? vaultInfo[1] : BigInt(0);
  const soldPct     = totalShares > BigInt(0) ? Number(totalShares) / MAX_SHARES * 100 : 0;

  const amount  = Math.max(1, Math.min(MAX_SHARES, parseInt(sharesToBuy, 10) || 1));
  const cost    = parseUnits(String(amount * SHARE_PRICE_USDC), 6);
  const needsApproval = allowance < cost;

  const approve = async () => {
    const hash = await writeContractAsync({
      address: usdc,
      abi: ERC20ABI,
      functionName: "approve",
      args: [vault, cost],
    });
    setTxHash(hash);
    await refetch();
  };

  const buy = async () => {
    const hash = await writeContractAsync({
      address: vault,
      abi: AgentDividendVaultABI,
      functionName: "buyShares",
      args: [agentIdBig, BigInt(amount)],
    });
    setTxHash(hash);
    await refetch();
  };

  const claim = async () => {
    const hash = await writeContractAsync({
      address: vault,
      abi: AgentDividendVaultABI,
      functionName: "claimDividend",
      args: [agentIdBig],
    });
    setTxHash(hash);
    await refetch();
  };

  if (noVault) {
    return (
      <section className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Equity vault</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Not yet deployed on this chain. Run <code>pnpm contracts:deploy:dividend-vault</code> to enable.
        </p>
      </section>
    );
  }

  const busy = txPending;

  return (
    <section className="rounded-md border border-indigo-100 bg-indigo-50/40 p-4 dark:border-indigo-900/40 dark:bg-indigo-950/20">
      <h3 className="mb-3 text-sm font-semibold text-indigo-700 dark:text-indigo-300">Equity vault</h3>

      {/* Stats row */}
      <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded bg-white/70 p-2 dark:bg-zinc-900/60">
          <div className="font-mono text-base font-bold text-zinc-900 dark:text-zinc-100">
            {myShares.toString()}
          </div>
          <div className="text-zinc-500 dark:text-zinc-400">Your shares</div>
        </div>
        <div className="rounded bg-white/70 p-2 dark:bg-zinc-900/60">
          <div className="font-mono text-base font-bold text-emerald-700 dark:text-emerald-400">
            {fmtUsdc(myPending)}
          </div>
          <div className="text-zinc-500 dark:text-zinc-400">Claimable USDC</div>
        </div>
        <div className="rounded bg-white/70 p-2 dark:bg-zinc-900/60">
          <div className="font-mono text-base font-bold text-zinc-900 dark:text-zinc-100">
            {totalShares.toString()} / {MAX_SHARES.toLocaleString()}
          </div>
          <div className="text-zinc-500 dark:text-zinc-400">
            {soldPct.toFixed(1)}% sold
          </div>
        </div>
      </div>

      {/* Claim */}
      {myPending > BigInt(0) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void claim()}
          className="mb-3 w-full rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-300"
        >
          {busy ? "…" : `Claim ${fmtUsdc(myPending)} USDC`}
        </button>
      )}

      {/* Buy */}
      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          max={MAX_SHARES}
          value={sharesToBuy}
          onChange={(e) => setSharesToBuy(e.target.value)}
          className="w-24 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex-1 text-xs text-zinc-500 dark:text-zinc-400 self-center">
          shares × {SHARE_PRICE_USDC} USDC = <strong className="text-zinc-700 dark:text-zinc-300">{amount} USDC</strong>
        </div>
        {needsApproval ? (
          <button
            type="button"
            disabled={busy || !address}
            onClick={() => void approve()}
            className="rounded border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300"
          >
            {busy ? "…" : "Approve"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !address}
            onClick={() => void buy()}
            className="rounded border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300"
          >
            {busy ? "…" : "Buy shares"}
          </button>
        )}
      </div>

      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        1 share = {SHARE_PRICE_USDC} USDC · dividends paid from tournament winnings
      </p>
    </section>
  );
}
