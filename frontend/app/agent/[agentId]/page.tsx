// Agent info page — comprehensive view of one agent iNFT.
//
// Shows all on-chain fields (owner, balance, ELO, tier, match count,
// experience version, mint block/date, base-weights hash, overlay hash)
// plus the 0G Storage profile: overlay category values (the NN "weights"
// that shift after each training round) and a plain-English summary.
//
// Data sources:
//   - AgentRegistry (on-chain, wagmi batch read): metadata, tier,
//     matchCount, experienceVersion, dataHashes, ownerOf
//   - MatchRegistry (on-chain): agentElo
//   - wagmi useBalance: owner's native-token balance
//   - publicClient getLogs: AgentMinted event → mint block + tx hash
//   - FastAPI server /agents/{id}/profile: overlay values, summary, kind
//
// Static export: generateStaticParams pre-builds shells for agents 1–10.
// Any agentId works at runtime in dev mode / when served dynamically.
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useBalance, usePublicClient, useReadContracts } from "wagmi";
import { formatEther, parseAbiItem } from "viem";

import { useActiveChain, useActiveChainId } from "../../chains";
import {
  AgentRegistryABI,
  MatchRegistryABI,
  useChainContracts,
} from "../../contracts";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

const AGENT_MINTED_EVENT = parseAbiItem(
  "event AgentMinted(uint256 indexed agentId, address indexed owner, uint8 tier, string metadataURI)",
);

// Pre-build static shells for agents 1–10 for the GitHub Pages / static
// export build. Any agent ID works dynamically in dev mode.
export function generateStaticParams() {
  return Array.from({ length: 10 }, (_, i) => ({ agentId: String(i + 1) }));
}

// Shape returned by /agents/{id}/profile (extended in Phase 66 to include
// overlay values and model_meta for the info page).
interface ProfileResponse {
  agent_id: number;
  kind: "null" | "overlay" | "model";
  match_count: number;
  summary: string;
  owner_ens: string | null;
  values: Record<string, number>;
  model_meta: Record<string, unknown>;
}

interface MintInfo {
  blockNumber: bigint;
  transactionHash: string;
  timestamp?: bigint;
}

export default function AgentInfoPage() {
  const params = useParams();

  // SSR-safe mount guard — avoids hydration mismatch in the static export.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const rawId = mounted ? (params?.agentId as string) : "0";
  const agentId = Math.max(0, Number(rawId) || 0);

  const chainId = useActiveChainId();
  const active = useActiveChain();
  const { agentRegistry, matchRegistry } = useChainContracts();
  const client = usePublicClient({ chainId });
  const deployedBlock = active?.deployedBlock;

  // Batch on-chain reads for all AgentRegistry + MatchRegistry fields.
  const { data: chainData, isLoading: chainLoading } = useReadContracts({
    contracts: [
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "agentMetadata",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "tier",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "matchCount",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "experienceVersion",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "dataHashes",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: agentRegistry,
        abi: AgentRegistryABI,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
        chainId,
      },
      {
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "agentElo",
        args: [BigInt(agentId)],
        chainId,
      },
    ],
    query: { enabled: mounted && agentId > 0 && !!agentRegistry },
  });

  const metadataUri = chainData?.[0]?.result as string | undefined;
  const tier = chainData?.[1]?.result as number | undefined;
  const matchCount = chainData?.[2]?.result as number | undefined;
  const experienceVersion = chainData?.[3]?.result as number | undefined;
  const dataHashes = chainData?.[4]?.result as
    | readonly [`0x${string}`, `0x${string}`]
    | undefined;
  const ownerAddress = chainData?.[5]?.result as `0x${string}` | undefined;
  const elo = chainData?.[6]?.result as bigint | undefined;

  // Owner's native-token balance on the current chain.
  const { data: balanceData } = useBalance({
    address: ownerAddress,
    chainId,
    query: { enabled: !!ownerAddress },
  });

  // Scan AgentMinted event logs to find the mint block and tx hash.
  const [mintInfo, setMintInfo] = useState<MintInfo | null>(null);
  const [mintLoading, setMintLoading] = useState(false);

  useEffect(() => {
    if (!client || !agentId || !agentRegistry || agentRegistry.length < 4)
      return;
    let cancelled = false;
    setMintLoading(true);

    const isLocal = chainId === 31337;
    const computeFromBlock = async (): Promise<bigint | "earliest"> => {
      if (isLocal) return "earliest";
      if (typeof deployedBlock === "number") return BigInt(deployedBlock);
      const tip = await client.getBlockNumber();
      const WINDOW = BigInt(49_000);
      return tip > WINDOW ? tip - WINDOW : BigInt(0);
    };

    computeFromBlock()
      .then((fromBlock) =>
        client.getLogs({
          address: agentRegistry,
          event: AGENT_MINTED_EVENT,
          args: { agentId: BigInt(agentId) },
          fromBlock,
        }),
      )
      .then(async (logs) => {
        if (cancelled || logs.length === 0) return;
        const log = logs[0];
        const blockNum = log.blockNumber ?? BigInt(0);
        let timestamp: bigint | undefined;
        try {
          const block = await client.getBlock({ blockNumber: blockNum });
          timestamp = block.timestamp;
        } catch {
          // Timestamp is supplementary — don't fail if block fetch errors.
        }
        if (!cancelled) {
          setMintInfo({
            blockNumber: blockNum,
            transactionHash: log.transactionHash ?? "",
            timestamp,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMintLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, client, agentRegistry, chainId, deployedBlock, mounted]);

  // Profile from the FastAPI server — includes overlay category values.
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId || !mounted) return;
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);

    fetch(`${SERVER}/agents/${agentId}/profile`)
      .then((res) => {
        if (!res.ok)
          throw new Error(`/agents/${agentId}/profile → ${res.status}`);
        return res.json() as Promise<ProfileResponse>;
      })
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setProfileError(String(e));
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, mounted]);

  // Derive display name from metadataURI — same logic as AgentCard.
  const cleanedLabel = metadataUri
    ? metadataUri
        .replace(/^ipfs:\/\//, "")
        .replace(/^[^:]+:\/\//, "")
        .replaceAll("/", "-")
    : "";
  const label =
    cleanedLabel && cleanedLabel.length <= 60
      ? `${cleanedLabel}.chaingammon.eth`
      : `Agent #${agentId}`;

  const explorerUrl = active?.chain.blockExplorers?.default?.url;

  const mintDateStr = mintInfo?.timestamp
    ? new Date(Number(mintInfo.timestamp) * 1000).toLocaleString()
    : undefined;

  return (
    <div
      data-testid="agent-info-shell"
      className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black"
    >
      <header
        data-testid="agent-info-header"
        className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800"
      >
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Home
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Agent Info
        </h1>
        <div className="w-20" />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {/* Identity row */}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="break-all font-mono text-xl font-bold text-zinc-900 dark:text-zinc-50">
            {chainLoading ? `Agent #${agentId}` : label}
          </h2>
          <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 font-mono text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            #{agentId}
          </span>
          {matchCount !== undefined && matchCount > 0 && (
            <span className="shrink-0 rounded bg-emerald-100 px-2 py-0.5 font-mono text-sm text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
              {matchCount} trained
            </span>
          )}
        </div>

        {/* On-chain data */}
        <section
          data-testid="agent-info-onchain"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            On-chain data
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
            <InfoField
              label="ELO"
              value={
                chainLoading
                  ? "…"
                  : elo !== undefined
                  ? elo.toString()
                  : "—"
              }
              mono
            />
            <InfoField
              label="Tier"
              value={
                chainLoading
                  ? "…"
                  : tier !== undefined
                  ? String(tier)
                  : "—"
              }
              mono
            />
            <InfoField
              label="Games trained"
              value={
                chainLoading
                  ? "…"
                  : matchCount !== undefined
                  ? String(matchCount)
                  : "—"
              }
              mono
            />
            <InfoField
              label="Exp. version"
              value={
                chainLoading
                  ? "…"
                  : experienceVersion !== undefined
                  ? String(experienceVersion)
                  : "—"
              }
              mono
            />
            <InfoField
              label="Owner"
              value={
                chainLoading ? "…" : ownerAddress ?? "—"
              }
              mono
              truncate
              href={
                explorerUrl && ownerAddress
                  ? `${explorerUrl}/address/${ownerAddress}`
                  : undefined
              }
            />
            <InfoField
              label="Owner balance"
              value={
                balanceData
                  ? `${parseFloat(formatEther(balanceData.value)).toFixed(4)} ${balanceData.symbol}`
                  : "—"
              }
              mono
            />
            <InfoField
              label="Mint block"
              value={
                mintLoading
                  ? "…"
                  : mintInfo
                  ? mintInfo.blockNumber.toString()
                  : "—"
              }
              mono
              href={
                explorerUrl && mintInfo?.transactionHash
                  ? `${explorerUrl}/tx/${mintInfo.transactionHash}`
                  : undefined
              }
            />
            {mintDateStr && (
              <InfoField label="Mint date" value={mintDateStr} />
            )}
          </dl>
        </section>

        {/* 0G Storage hashes */}
        <section
          data-testid="agent-info-storage"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            0G Storage hashes
          </h3>
          <dl className="flex flex-col gap-4 text-sm">
            <InfoField
              label="Base weights hash (shared)"
              value={chainLoading ? "…" : dataHashes?.[0] ?? "—"}
              mono
              fullValue
            />
            <InfoField
              label="Overlay hash (per-agent)"
              value={chainLoading ? "…" : dataHashes?.[1] ?? "—"}
              mono
              fullValue
            />
          </dl>
        </section>

        {/* NN weights / style profile */}
        <section
          data-testid="agent-info-weights"
          className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Neural network weights
          </h3>
          <p className="mb-4 text-xs text-zinc-500">
            Fetched from 0G Storage via the server. Changes after each
            training round as the agent accumulates match experience.
          </p>

          {profileLoading && (
            <p className="animate-pulse text-sm text-zinc-500">
              Fetching from 0G Storage…
            </p>
          )}
          {profileError && (
            <p className="text-sm text-zinc-500">
              Profile unavailable — server not reachable.
            </p>
          )}
          {!profileLoading && !profileError && profile && (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <KindBadge kind={profile.kind} />
                <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {profile.match_count} games trained
                </span>
              </div>

              <p className="mb-4 text-sm italic text-zinc-600 dark:text-zinc-400">
                {profile.summary}
              </p>

              {profile.kind === "overlay" &&
                Object.keys(profile.values).length > 0 && (
                  <OverlayWeightsTable values={profile.values} />
                )}

              {profile.kind === "model" &&
                Object.keys(profile.model_meta).length > 0 && (
                  <div className="space-y-1 font-mono text-xs text-zinc-500">
                    {Object.entries(profile.model_meta).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-zinc-400">{k}:</span>
                        <span>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
            </>
          )}
          {!profileLoading && !profileError && !profile && (
            <p className="text-sm text-zinc-500">
              No profile data yet — agent has not been trained.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function InfoField({
  label,
  value,
  mono,
  href,
  truncate,
  fullValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
  truncate?: boolean;
  fullValue?: boolean;
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
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
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

function KindBadge({ kind }: { kind: string }) {
  const cls =
    kind === "model"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      : kind === "overlay"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded-md px-2 py-0.5 font-mono text-xs ${cls}`}>
      {kind}
    </span>
  );
}

function OverlayWeightsTable({
  values,
}: {
  values: Record<string, number>;
}) {
  const entries = Object.entries(values).sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  );

  return (
    <div data-testid="agent-overlay-weights">
      <p className="mb-3 text-xs text-zinc-500">
        Style weights sorted by |value| (range −1 to +1). Positive = the
        agent favours this style; negative = the agent avoids it. Values
        shift after each training round.
      </p>
      <div className="space-y-2">
        {entries.map(([cat, val]) => (
          <WeightRow key={cat} category={cat} value={val} />
        ))}
      </div>
    </div>
  );
}

function WeightRow({
  category,
  value,
}: {
  category: string;
  value: number;
}) {
  const isPos = value >= 0;
  const barPct = Math.abs(value) * 50; // max |value|=1 → 50% of half-width
  const label = category.replaceAll("_", " ");

  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-44 shrink-0 truncate font-mono text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      {/* Centred bar chart: left half = negative (red), right half = positive (green). */}
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        {/* Centre line */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-300 dark:bg-zinc-600" />
        {isPos ? (
          <div
            className="absolute top-0 h-full rounded-r-full bg-emerald-500"
            style={{ left: "50%", width: `${barPct}%` }}
          />
        ) : (
          <div
            className="absolute top-0 h-full rounded-l-full bg-red-400"
            style={{ right: "50%", width: `${barPct}%` }}
          />
        )}
      </div>
      <span
        className={`w-14 text-right font-mono ${
          isPos
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400"
        }`}
      >
        {isPos ? "+" : ""}
        {value.toFixed(3)}
      </span>
    </div>
  );
}
