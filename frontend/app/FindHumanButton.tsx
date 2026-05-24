// FindHumanButton — basic-mode human-vs-human matchmaking, fully serverless.
//
// Clicking "Play a human" writes a `searching` text record (a unix-ms
// timestamp) to your OWN <label>.chaingammon.eth subname via the ENS
// PublicResolver — the same owner-signed setText path useSyncEnsProfile uses
// for `elo`. Other clients read that record directly from the resolver, so
// presence lives on-chain in ENS, not on any server. While you're searching,
// this surfaces the other humans whose `searching` flag is still live (written
// within SEARCHING_TTL_MS) and offers to connect to the nearest-ELO one using
// the existing per-human play link.
//
// Scope: this is the *matchmaking* (find a human who is also searching). The
// actual game connection reuses whatever the discovery list already links to
// for a human (their `endpoint` record, else their profile page).
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { parseAbiItem } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";

import { useActiveChain, useActiveChainId, useEnsInfra } from "./chains";
import { PublicResolverABI, useChainContracts } from "./contracts";
import { useAppMode } from "./AppModeContext";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string label, bytes32 indexed node, address indexed subnameOwner, uint256 inftId)",
);

// publicnode Sepolia caps eth_getLogs at 50k blocks; stay safely under.
const MAX_BLOCK_RANGE = BigInt(49_000);
// A `searching` flag counts as live only if written within this window.
const SEARCHING_TTL_MS = 90_000;
// How often to re-read the searching set (and re-check freshness) in queue.
const POLL_MS = 12_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

interface HumanNode {
  label: string;
  node: `0x${string}`;
  owner: `0x${string}`;
}

export function FindHumanButton() {
  const { mode, hydrated } = useAppMode();
  const { address, isConnected } = useAccount();
  const chainId = useActiveChainId();
  const active = useActiveChain();
  const publicClient = usePublicClient({ chainId });
  const ensInfra = useEnsInfra();
  const { playerSubnameRegistrar } = useChainContracts();
  const { writeContractAsync, isPending } = useWriteContract();

  const [humans, setHumans] = useState<HumanNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const resolver = ensInfra?.publicResolver as `0x${string}` | undefined;

  // 1. Enumerate human subnames via SubnameMinted (inftId == 0 == human),
  //    mirroring DiscoveryList's chunked scan.
  useEffect(() => {
    if (!publicClient || !playerSubnameRegistrar || !active) return;
    let cancelled = false;

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
        const out: HumanNode[] = [];
        for (const log of logs) {
          const { label, node, subnameOwner, inftId } = log.args as {
            label?: string;
            node?: `0x${string}`;
            subnameOwner?: `0x${string}`;
            inftId?: bigint;
          };
          if (!node || !label || seen.has(node)) continue;
          if ((inftId ?? 0n) > 0n) continue; // agents have a non-zero iNFT id
          seen.add(node);
          out.push({ label, node, owner: subnameOwner ?? ZERO_ADDRESS });
        }
        setHumans(out);
      })
      .catch(() => {
        /* non-fatal — the button just won't find anyone */
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, playerSubnameRegistrar, active, chainId]);

  // My own subname (must own one to advertise that I'm searching).
  const mine = useMemo(
    () =>
      address
        ? humans.find((h) => h.owner.toLowerCase() === address.toLowerCase())
        : undefined,
    [humans, address],
  );

  // 2. Read `searching` / `elo` / `endpoint` for every human node. Polls only
  //    while I'm in queue so we're not hammering the RPC otherwise.
  const calls = resolver
    ? humans.flatMap((h) => [
        {
          address: resolver,
          abi: PublicResolverABI,
          functionName: "text" as const,
          args: [h.node, "searching"] as [`0x${string}`, string],
          chainId,
        },
        {
          address: resolver,
          abi: PublicResolverABI,
          functionName: "text" as const,
          args: [h.node, "elo"] as [`0x${string}`, string],
          chainId,
        },
        {
          address: resolver,
          abi: PublicResolverABI,
          functionName: "text" as const,
          args: [h.node, "endpoint"] as [`0x${string}`, string],
          chainId,
        },
      ])
    : [];

  const { data: textResults } = useReadContracts({
    contracts: calls,
    query: {
      enabled: humans.length > 0 && !!resolver,
      refetchInterval: searching ? POLL_MS : false,
    },
  });

  // Re-evaluate freshness between polls.
  useEffect(() => {
    if (!searching) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [searching]);

  const myElo = useMemo(() => {
    if (!mine) return 1500;
    const i = humans.indexOf(mine);
    const raw = (textResults?.[i * 3 + 1]?.result as string) ?? "";
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1500;
  }, [mine, humans, textResults]);

  // Other humans whose `searching` flag is still live.
  const candidates = humans
    .map((h, i) => {
      const ts = Number((textResults?.[i * 3]?.result as string) ?? "");
      const elo = (textResults?.[i * 3 + 1]?.result as string) ?? "";
      const endpoint = (textResults?.[i * 3 + 2]?.result as string) ?? "";
      const fresh = Number.isFinite(ts) && ts > 0 && now - ts < SEARCHING_TTL_MS;
      return { ...h, elo, endpoint, fresh };
    })
    .filter(
      (h) =>
        h.fresh &&
        (!address || h.owner.toLowerCase() !== address.toLowerCase()),
    );

  // Match = nearest by ELO (falls back to 1500 when a rating is missing).
  const match = candidates
    .slice()
    .sort(
      (a, b) =>
        Math.abs(Number(a.elo || 1500) - myElo) -
        Math.abs(Number(b.elo || 1500) - myElo),
    )[0];

  const playHref = (h: { label: string; endpoint: string }) =>
    h.endpoint
      ? `/match?endpoint=${encodeURIComponent(h.endpoint)}`
      : `/humans/${h.label}`;

  const setFlag = async (value: string) => {
    if (!resolver || !mine) throw new Error("no subname");
    await writeContractAsync({
      address: resolver,
      abi: PublicResolverABI,
      functionName: "setText",
      args: [mine.node, "searching", value],
    });
  };

  const onToggle = async () => {
    setError(null);
    try {
      if (!searching) {
        await setFlag(String(Date.now()));
        setNow(Date.now());
        setSearching(true);
      } else {
        await setFlag("");
        setSearching(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Basic mode only, and only once mode has hydrated + wallet is connected.
  if (!hydrated || mode !== "elo" || !isConnected) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: "var(--cg-radius-lg)",
        border: "1px solid var(--cg-line-1)",
        background: "var(--cg-bg-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onToggle}
          disabled={isPending || !mine}
          className="cg-btn-primary"
          style={{ opacity: !mine ? 0.5 : 1 }}
        >
          {isPending
            ? "Confirm in wallet…"
            : searching
            ? "Stop searching"
            : "Play a human"}
        </button>
        {searching && (
          <span style={{ fontSize: 13, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
            Searching for an opponent…{" "}
            {candidates.length > 0
              ? `${candidates.length} also searching`
              : "no one else searching yet"}
          </span>
        )}
        {!mine && (
          <span style={{ fontSize: 13, color: "var(--cg-fg-4)" }}>
            Claim your &lt;name&gt;.chaingammon.eth first to be matchable.
          </span>
        )}
      </div>

      {searching && match && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            borderRadius: "var(--cg-radius)",
            border: "1px solid var(--cg-brass)",
            background: "rgba(201,155,92,0.12)",
          }}
        >
          <span style={{ fontFamily: "var(--cg-font-mono)", fontSize: 14, color: "var(--cg-fg-1)" }}>
            Matched: {match.label}.chaingammon.eth
            {match.elo ? ` · ELO ${match.elo}` : ""}
          </span>
          <Link href={playHref(match)} className="cg-chip cg-chip-gold">
            Play
          </Link>
        </div>
      )}

      {error && (
        <p style={{ fontSize: 12, color: "var(--cg-danger)", margin: 0 }}>{error}</p>
      )}
    </div>
  );
}
