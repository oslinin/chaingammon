// Phase 31: unified discovery list — humans and agents from
// PlayerSubnameRegistrar in a single view.
//
// The contract delegates all subname state to ENS NameWrapper + PublicResolver
// and exposes no enumeration functions (no subnameCount, subnameAt, or text).
// Enumeration is driven entirely by SubnameMinted event logs, scanned in
// 49k-block chunks to stay within publicnode Sepolia's 50k block range cap.
// kind + inftId come directly from the event; elo + endpoint are read from
// the ENS PublicResolver via a batched useReadContracts call.
//
// Human ELO fallback: ENS PublicResolver only stores elo when KeeperHub
// settlement writes it. For human entries, MatchRegistry.humanElo(owner)
// is read as a fallback (mirrors ProfileBadge behaviour).
"use client";

import { useEffect, useState } from "react";
import { formatEther, parseAbiItem } from "viem";
import { useBalance, usePublicClient, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";

import { useActiveChain, useActiveChainId, useEnsInfra } from "./chains";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { PersonCard, type MatchSummary } from "./PersonCard";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface DiscoveryEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  elo: string;
  endpoint: string;
  inftId: string; // agent iNFT ID written by AgentRegistry.mintAgent; "" for humans
  owner?: `0x${string}`;
  matchRecord?: MatchSummary;
}

interface ScanEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  inftId: string;
  owner: `0x${string}`;
}

// -------------------------------------------------------------------------
// Discovery entry card — thin wrapper around PersonCard
// -------------------------------------------------------------------------

function EntryCard({ entry }: { entry: DiscoveryEntry }) {
  const isAgent = entry.kind === "agent";
  const chainId = useActiveChainId();

  // Human players: show their on-chain wallet balance.
  const { data: balanceData } = useBalance({
    address: entry.owner,
    chainId,
    query: { enabled: !isAgent && !!entry.owner },
  });

  // Agents: show the agent's own server-managed wallet balance.
  const agentWalletQuery = useQuery({
    queryKey: ["agent-wallet", entry.inftId],
    enabled: isAgent && !!entry.inftId,
    refetchInterval: 30000,
    queryFn: async (): Promise<{ balance_wei: string } | null> => {
      const r = await fetch(`${SERVER}/agents/${entry.inftId}/wallet`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`/agents/${entry.inftId}/wallet → ${r.status}`);
      return r.json();
    },
  });

  let balance: string | undefined;
  if (isAgent) {
    if (agentWalletQuery.isLoading) {
      balance = undefined;
    } else {
      const wei = agentWalletQuery.data?.balance_wei
        ? BigInt(agentWalletQuery.data.balance_wei)
        : BigInt(0);
      balance = `${parseFloat(formatEther(wei)).toFixed(4)} ETH`;
    }
  } else {
    balance = balanceData
      ? `${parseFloat(formatEther(balanceData.value)).toFixed(4)} ${balanceData.symbol}`
      : entry.owner
      ? undefined
      : "";
  }
  const ensName = entry.label ? `${entry.label}.chaingammon.eth` : null;

  return (
    <div data-testid="discovery-entry">
      <PersonCard
        label={entry.label}
        nameHref={ensName ? `https://app.ens.domains/${ensName}` : undefined}
        elo={entry.elo || undefined}
        balance={balance}
        matchSummary={entry.matchRecord ?? null}
        infoHref={isAgent && entry.inftId ? `/agent/${entry.inftId}` : `/humans/${entry.label || entry.owner}`}
        infoLabel={entry.kind || "unknown"}
        playHref={
          entry.endpoint
            ? `/match?endpoint=${encodeURIComponent(entry.endpoint)}`
            : undefined
        }
      />
    </div>
  );
}

// -------------------------------------------------------------------------
// Prop types for static fixture use
// -------------------------------------------------------------------------

export interface DiscoveryListProps {
  /** Pre-populated entries for test fixture pages (no blockchain read). */
  staticEntries?: DiscoveryEntry[];
  /** When true, only the Players section is rendered. Use on pages where
   *  AgentsList already shows agent cards so they aren't duplicated. */
  playersOnly?: boolean;
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string label, bytes32 indexed node, address indexed subnameOwner, uint256 inftId)",
);

const MATCH_RECORDED_EVENT = parseAbiItem(
  "event MatchRecorded(uint256 indexed matchId, uint256 winnerAgentId, address winnerHuman, uint256 loserAgentId, address loserHuman, uint256 newWinnerElo, uint256 newLoserElo)",
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Minimal ABI for ENS PublicResolver.text(bytes32, string) → string.
const RESOLVER_ABI = [
  {
    name: "text",
    type: "function" as const,
    inputs: [
      { name: "node", type: "bytes32" as const },
      { name: "key", type: "string" as const },
    ],
    outputs: [{ name: "", type: "string" as const }],
    stateMutability: "view" as const,
  },
] as const;

// publicnode Sepolia caps eth_getLogs at 50k blocks; stay safely under.
const MAX_BLOCK_RANGE = BigInt(49_000);

// -------------------------------------------------------------------------
// Main component
// -------------------------------------------------------------------------

export function DiscoveryList({ staticEntries, playersOnly }: DiscoveryListProps = {}) {
  const active = useActiveChain();
  const chainId = useActiveChainId();
  const { playerSubnameRegistrar, matchRegistry } = useChainContracts();
  const publicClient = usePublicClient({ chainId });
  const ensInfra = useEnsInfra();

  // Partial entries from event scan (elo + endpoint added below via resolver reads).
  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Match records grouped by address (humans) and agentId string (agents).
  const [matchByAddress, setMatchByAddress] = useState<Map<string, MatchSummary>>(new Map());
  const [matchByAgentId, setMatchByAgentId] = useState<Map<string, MatchSummary>>(new Map());
  const [scanError, setScanError] = useState(false);

  useEffect(() => {
    if (!publicClient || !playerSubnameRegistrar || !active || staticEntries) return;
    let cancelled = false;
    setLoading(true);
    setScanError(false);

    // Scan from deployedBlock when known; BigInt(0) fallback is safe because
    // the chunked scanner handles any range size.
    const fromBlock: bigint | "earliest" =
      chainId === 31337
        ? "earliest"
        : typeof active.deployedBlock === "number"
        ? BigInt(active.deployedBlock)
        : BigInt(0);

    const scan = async () => {
      if (fromBlock === "earliest") {
        return publicClient.getLogs({
          address: playerSubnameRegistrar,
          event: SUBNAME_MINTED_EVENT,
          fromBlock,
        });
      }
      const tip = await publicClient.getBlockNumber();
      const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
      let from = fromBlock;
      while (from <= tip) {
        const to = from + MAX_BLOCK_RANGE <= tip ? from + MAX_BLOCK_RANGE : tip;
        chunks.push({ fromBlock: from, toBlock: to });
        from = to + 1n;
      }
      const results = await Promise.all(
        chunks.map((c) =>
          publicClient.getLogs({
            address: playerSubnameRegistrar,
            event: SUBNAME_MINTED_EVENT,
            ...c,
          }),
        ),
      );
      return results.flat();
    };

    scan()
      .then((logs) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const result: ScanEntry[] = [];
        for (const log of logs) {
          const { label, node, subnameOwner, inftId } = log.args as {
            label?: string;
            node?: `0x${string}`;
            subnameOwner?: `0x${string}`;
            inftId?: bigint;
          };
          if (!node || !label || seen.has(node)) continue;
          seen.add(node);
          result.push({
            node,
            label,
            kind: (inftId ?? 0n) > 0n ? "agent" : "human",
            inftId: inftId && inftId > 0n ? inftId.toString() : "",
            owner: subnameOwner ?? "0x0000000000000000000000000000000000000000",
          });
        }
        setScanEntries(result);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setScanError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, playerSubnameRegistrar, active, chainId, staticEntries]);

  // Scan MatchRecorded events once and group wins/losses by human address and
  // agent ID so EntryCard can show "N played · W won · L lost" for every entry.
  useEffect(() => {
    if (!publicClient || !matchRegistry || !active || staticEntries) return;
    let cancelled = false;

    const fromBlock: bigint | "earliest" =
      chainId === 31337
        ? "earliest"
        : typeof active.deployedBlock === "number"
        ? BigInt(active.deployedBlock)
        : BigInt(0);

    const scanMatches = async () => {
      if (fromBlock === "earliest") {
        return publicClient.getLogs({
          address: matchRegistry,
          event: MATCH_RECORDED_EVENT,
          fromBlock,
        });
      }
      const tip = await publicClient.getBlockNumber();
      const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
      let from = fromBlock;
      while (from <= tip) {
        const to = from + MAX_BLOCK_RANGE <= tip ? from + MAX_BLOCK_RANGE : tip;
        chunks.push({ fromBlock: from, toBlock: to });
        from = to + 1n;
      }
      const results = await Promise.all(
        chunks.map((c) =>
          publicClient.getLogs({ address: matchRegistry, event: MATCH_RECORDED_EVENT, ...c }),
        ),
      );
      return results.flat();
    };

    scanMatches()
      .then((logs) => {
        if (cancelled) return;
        const byAddr = new Map<string, MatchSummary>();
        const byAgent = new Map<string, MatchSummary>();
        const tally = (map: Map<string, MatchSummary>, key: string, win: boolean) => {
          const prev = map.get(key) ?? { matches: 0, wins: 0, losses: 0 };
          map.set(key, {
            matches: prev.matches + 1,
            wins: prev.wins + (win ? 1 : 0),
            losses: prev.losses + (win ? 0 : 1),
          });
        };
        for (const log of logs) {
          const a = log.args as {
            winnerAgentId?: bigint;
            winnerHuman?: `0x${string}`;
            loserAgentId?: bigint;
            loserHuman?: `0x${string}`;
          };
          if (a.winnerHuman && a.winnerHuman !== ZERO_ADDRESS) tally(byAddr, a.winnerHuman, true);
          if (a.loserHuman && a.loserHuman !== ZERO_ADDRESS) tally(byAddr, a.loserHuman, false);
          if (a.winnerAgentId && a.winnerAgentId > 0n) tally(byAgent, a.winnerAgentId.toString(), true);
          if (a.loserAgentId && a.loserAgentId > 0n) tally(byAgent, a.loserAgentId.toString(), false);
        }
        setMatchByAddress(byAddr);
        setMatchByAgentId(byAgent);
      })
      .catch(() => { /* non-critical — match record just won't show */ });

    return () => { cancelled = true; };
  }, [publicClient, matchRegistry, active, chainId, staticEntries]);

  // Batch-read elo + endpoint from ENS PublicResolver for each discovered node.
  // When ensInfra is absent (e.g. localhost), resolver is undefined and calls
  // are skipped — elo/endpoint show as empty strings.
  const resolver = ensInfra?.publicResolver as `0x${string}` | undefined;
  const nodes = scanEntries.map((e) => e.node);
  const textCalls = resolver
    ? nodes.flatMap((node) => [
        {
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: "text" as const,
          args: [node, "elo"] as [`0x${string}`, string],
          chainId,
        },
        {
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: "text" as const,
          args: [node, "endpoint"] as [`0x${string}`, string],
          chainId,
        },
      ])
    : [];

  const { data: textResults } = useReadContracts({
    contracts: textCalls,
    query: { enabled: nodes.length > 0 && !!resolver },
  });

  // Fallback ELO for humans: ENS resolver only stores elo after KeeperHub
  // settlement. Read MatchRegistry.humanElo(owner) for every human entry so
  // freshly-minted subnames still show a rating (mirrors ProfileBadge).
  const humanEntries = scanEntries.filter((e) => e.kind !== "agent");
  const humanEloCalls = matchRegistry
    ? humanEntries.map((e) => ({
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "humanElo" as const,
        args: [e.owner] as [`0x${string}`],
        chainId,
      }))
    : [];

  const { data: humanEloResults } = useReadContracts({
    contracts: humanEloCalls,
    query: { enabled: humanEntries.length > 0 && !!matchRegistry },
  });

  // Map owner address → chain ELO for O(1) lookup in liveEntries.
  const humanEloByOwner = new Map<string, string>();
  humanEntries.forEach((e, i) => {
    const raw = humanEloResults?.[i]?.result;
    if (raw != null && e.owner) humanEloByOwner.set(e.owner, String(raw));
  });

  const liveEntries: DiscoveryEntry[] = scanEntries.map((e, i) => {
    const ensElo = resolver ? ((textResults?.[i * 2]?.result as string) ?? "") : "";
    const chainElo = e.kind !== "agent" && e.owner ? (humanEloByOwner.get(e.owner) ?? "") : "";
    const elo = ensElo || chainElo;
    const matchRecord =
      e.kind === "agent"
        ? matchByAgentId.get(e.inftId)
        : e.owner
        ? matchByAddress.get(e.owner)
        : undefined;
    return {
      ...e,
      elo,
      endpoint: resolver ? ((textResults?.[i * 2 + 1]?.result as string) ?? "") : "",
      matchRecord,
    };
  });

  const entries: DiscoveryEntry[] = staticEntries ?? liveEntries;
  const humans = entries.filter((e) => e.kind !== "agent");
  const agents = entries.filter((e) => e.kind === "agent");

  // --- Loading / error states (only relevant for live on-chain path) ---
  if (!staticEntries) {
    if (!active) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No Chaingammon deployment on this chain. Switch your wallet to see identities.
        </p>
      );
    }
    if (loading) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
    }
    if (scanError) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Could not reach PlayerSubnameRegistrar at{" "}
          <code className="font-mono">{playerSubnameRegistrar}</code>.
        </p>
      );
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section data-testid="discovery-humans-section">
        <h2
          data-testid="discovery-humans-header"
          className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Players
        </h2>
        {humans.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No players registered yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {humans.map((e) => (
              <EntryCard key={e.node} entry={e} />
            ))}
          </div>
        )}
      </section>

      {!playersOnly && (
        <section data-testid="discovery-agents-section">
          <h2
            data-testid="discovery-agents-header"
            className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Agents
          </h2>
          {agents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No agents registered yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((e) => (
                <EntryCard key={e.node} entry={e} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
