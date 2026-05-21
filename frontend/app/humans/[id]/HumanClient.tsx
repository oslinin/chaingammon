"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useBalance, usePublicClient, useReadContracts } from "wagmi";
import { formatEther } from "viem";

import { useActiveChain, useActiveChainId } from "../../chains";
import { MatchRegistryABI, useChainContracts } from "../../contracts";
import { useHumanMatchSummary } from "../../useHumanMatchSummary";
import { useChaingammonName } from "../../useChaingammonName";

export default function HumanClient() {
  const params = useParams();

  // SSR-safe mount guard
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const rawId = mounted ? (params?.id as string) : "";
  const isAddress = rawId.startsWith("0x");

  const [resolvedAddress, setResolvedAddress] = useState<`0x${string}` | undefined>(
    isAddress ? (rawId as `0x${string}`) : undefined
  );

  const chainId = useActiveChainId();
  const active = useActiveChain();
  const client = usePublicClient({ chainId });
  const { playerSubnameRegistrar, matchRegistry } = useChainContracts();

  useEffect(() => {
    if (!mounted || isAddress || !rawId || !client || !playerSubnameRegistrar) return;

    // Scan logs to find the owner for the given label
    const scan = async () => {
        // Simple scan from 0
        const logs = await client.getLogs({
          address: playerSubnameRegistrar,
          event: {
            type: "event",
            name: "SubnameMinted",
            inputs: [
              { type: "string", name: "label", indexed: false },
              { type: "bytes32", name: "node", indexed: true },
              { type: "address", name: "subnameOwner", indexed: true },
              { type: "uint256", name: "inftId", indexed: false },
            ],
          },
          fromBlock: "earliest",
        });
        const match = logs.find(l => l.args.label === rawId);
        if (match && match.args.subnameOwner) {
            setResolvedAddress(match.args.subnameOwner as `0x${string}`);
        }
    };
    scan().catch(console.error);
  }, [mounted, isAddress, rawId, client, playerSubnameRegistrar]);

  const targetAddress = isAddress ? (rawId as `0x${string}`) : resolvedAddress;

  // Use the useChaingammonName hook to get the name if we started with an address
  const { label: lookupLabel, name: lookupName } = useChaingammonName(
    isAddress ? targetAddress : undefined
  );

  const displayName = isAddress ? lookupName || targetAddress : `${rawId}.chaingammon.eth`;

  const { summary: matchSummary, isLoading: matchLoading } = useHumanMatchSummary(targetAddress);
  const matchesPlayed = matchSummary?.matches;

  const { data: balanceData } = useBalance({
    address: targetAddress,
    chainId,
    query: { enabled: !!targetAddress },
  });

  const { data: humanEloData, isLoading: eloLoading } = useReadContracts({
    contracts: matchRegistry && targetAddress ? [
      {
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "humanElo",
        args: [targetAddress],
        chainId,
      }
    ] : [],
    query: { enabled: !!matchRegistry && !!targetAddress }
  });

  // Default to 1500 if not found or 0
  const rawElo = humanEloData?.[0]?.result as bigint | undefined;
  const elo = rawElo && rawElo > 0n ? rawElo.toString() : "1500";

  const explorerUrl = active?.chain.blockExplorers?.default?.url;

  return (
    <div
      data-testid="human-info-shell"
      className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black"
    >
      <header
        data-testid="human-info-header"
        className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800"
      >
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Home
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Player Info
        </h1>
        <div className="w-8" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {/* Identity row */}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="break-all font-mono text-xl font-bold text-zinc-900 dark:text-zinc-50">
            {displayName || targetAddress || "Loading..."}
          </h2>
          <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 font-mono text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            Human
          </span>
          {matchesPlayed !== undefined && matchesPlayed > 0 && (
            <span
              className="shrink-0 rounded bg-indigo-100 px-2 py-0.5 font-mono text-sm text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
              title="Matches played — derived from MatchRegistry.MatchRecorded events"
            >
              {matchesPlayed} played
            </span>
          )}
        </div>

        {/* On-chain data */}
        <section
          data-testid="human-info-onchain"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="mb-4 flex items-center gap-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              On-chain data
            </h3>
            {explorerUrl && targetAddress && (
              <a
                href={`${explorerUrl}/address/${targetAddress}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Etherscan ↗
              </a>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
            <InfoField
              label="ELO"
              value={eloLoading ? "…" : elo}
              mono
              tooltip="Chess-style skill rating. Increases after wins, decreases after losses. Determines matchmaking difficulty."
            />
            <InfoField
              label="Matches played"
              value={
                matchLoading
                  ? "…"
                  : matchesPlayed !== undefined
                  ? String(matchesPlayed)
                  : "0"
              }
              mono
              tooltip="On-chain count — one MatchRegistry.MatchRecorded event per finished match."
            />
            <InfoField
              label="Wallet"
              value={targetAddress ?? "—"}
              mono
              truncate
              href={
                explorerUrl && targetAddress
                  ? `${explorerUrl}/address/${targetAddress}`
                  : undefined
              }
              tooltip="Wallet address for this human player."
            />
            <InfoField
              label="Wallet balance"
              value={
                balanceData
                  ? `${parseFloat(formatEther(balanceData.value)).toFixed(4)} ${balanceData.symbol}`
                  : "—"
              }
              mono
              tooltip="Native token balance of the wallet on the current chain."
            />
          </dl>
        </section>

        {/* 0G Storage hashes (Null Profile for humans) */}
        <section
          data-testid="human-info-storage"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            0G Storage hashes
          </h3>
          <dl className="flex flex-col gap-4 text-sm">
            <InfoField
              label="Base weights hash (shared)"
              value="0x0000000000000000000000000000000000000000000000000000000000000000"
              mono
              fullValue
              tooltip="Human players do not use on-chain AI models."
            />
            <InfoField
              label="0G root hash"
              value="0x0000000000000000000000000000000000000000000000000000000000000000"
              mono
              fullValue
              tooltip="Human players do not use 0G Storage for neural-network weights."
            />
          </dl>
        </section>

        {/* NN weights / style profile (Null Profile for humans) */}
        <section
          data-testid="human-info-weights"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Neural network weights
          </h3>
          <p className="mb-4 text-xs text-zinc-500">
            Human players rely on their own brain. No weights to display.
          </p>

          <div className="mb-3 flex flex-wrap gap-2">
            <span className="rounded-md px-2 py-0.5 font-mono text-xs bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              null
            </span>
          </div>

          <p className="mb-4 text-sm italic text-zinc-600 dark:text-zinc-400">
            This human player relies on natural intelligence — no measurable artificial playing style yet.
          </p>

        </section>
      </main>
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function FieldTooltip({ text }: { text: string }) {
  return (
    <span className="absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-zinc-700 shadow-lg opacity-0 transition-opacity group-hover/tip:opacity-100 pointer-events-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {text}
    </span>
  );
}

function InfoField({
  label,
  value,
  mono,
  href,
  truncate,
  fullValue,
  tooltip,
}: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
  truncate?: boolean;
  fullValue?: boolean;
  tooltip?: string;
}) {
  const displayValue =
    truncate && value.length > 18
      ? `${value.slice(0, 8)}…${value.slice(-6)}`
      : value;

  const content = href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
    >
      {displayValue}
    </a>
  ) : (
    <span className={fullValue ? "break-all" : undefined}>{displayValue}</span>
  );

  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1 text-xs uppercase tracking-wide text-zinc-500">
        <span>{label}</span>
        {tooltip && (
          <span className="group/tip relative flex cursor-help items-center">
            <span className="select-none text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400">
              ⓘ
            </span>
            <FieldTooltip text={tooltip} />
          </span>
        )}
      </dt>
      <dd
        className={
          mono
            ? "font-mono text-zinc-900 dark:text-zinc-100"
            : "text-zinc-900 dark:text-zinc-100"
        }
      >
        {content}
      </dd>
    </div>
  );
}
