// Discovery list — humans registered under chaingammon.eth, fetched from
// the ENS subgraph rather than scanning event logs from the registrar.
//
// After the NameWrapper migration, subname state lives entirely in real
// ENS. The subgraph is the canonical index for "all subdomains of
// chaingammon.eth"; the previous on-chain enumeration via subnameCount /
// subnameAt was removed.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";

import { useActiveChain, useActiveChainId, useEnsInfra } from "./chains";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { useChaingammonName } from "./useChaingammonName";
import { useChaingammonProfile } from "./useChaingammonProfile";
import { useHumanMatchSummary } from "./useHumanMatchSummary";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface DiscoveryEntry {
  node: `0x${string}`;
  label: string;
  kind: string;
  elo: string;
  endpoint: string;
  inftId: string; // agent iNFT id; "" for human entries
  address: `0x${string}` | null; // resolved wallet address from ENS resolver, when available
}

// -------------------------------------------------------------------------
// Subgraph query — list subdomains of chaingammon.eth with their resolver text records.
//
// The ENS subgraph stores Domain entities keyed by their namehash. Each
// has a labelName, an owner, and a `resolver` record with `texts` keys
// and `coinTypes`. We fetch a small page (100 is plenty for a demo) and
// pull the text records we care about in a follow-up call below.
// -------------------------------------------------------------------------

const PARENT_NAME = "chaingammon.eth";

const SUBNAMES_QUERY = `
  query Subnames($parent: String!) {
    domains(
      where: {
        parent_: { name: $parent },
        owner_not: "0x0000000000000000000000000000000000000000"
      },
      first: 100
    ) {
      id
      labelName
      name
      wrappedOwner {
        id
      }
      resolver {
        texts
        addr {
          id
        }
      }
    }
  }
`;

async function fetchSubnameEntries(subgraphUrl: string): Promise<DiscoveryEntry[]> {
  const res = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: SUBNAMES_QUERY,
      variables: { parent: PARENT_NAME },
    }),
  });
  if (!res.ok) throw new Error(`subgraph http ${res.status}`);
  const json = await res.json();
  const domains = (json?.data?.domains ?? []) as Array<{
    id: string;
    labelName: string | null;
    name: string;
    wrappedOwner: { id: string } | null;
    resolver: {
      texts: string[] | null;
      addr: { id: string } | null;
    } | null;
  }>;

  // The subgraph reports which text keys exist; the actual values are not
  // included in the listing query. We surface every domain and the consumer
  // falls back to "" for missing values.
  //
  // Address resolution for the per-card match-summary hook tries, in order:
  //   1. resolver.addr.id  — canonical `addr()` resolution; what every other
  //      ENS client reads for the wallet bound to a name.
  //   2. wrappedOwner.id   — for NameWrapper'd subnames the `owner` is the
  //      NameWrapper contract; the actual user is `wrappedOwner`. Useful
  //      when the registrar didn't set an explicit `addr()` on the resolver.
  // If neither is set the address is null and stats fall back to ENS-text
  // values where available.
  const ZERO = "0x0000000000000000000000000000000000000000";
  return domains.map((d) => {
    const texts = new Set(d.resolver?.texts ?? []);
    const candidates = [
      d.resolver?.addr?.id ?? null,
      d.wrappedOwner?.id ?? null,
    ];
    const address =
      (candidates.find(
        (a) =>
          a !== null &&
          /^0x[0-9a-fA-F]{40}$/.test(a) &&
          a.toLowerCase() !== ZERO,
      ) as `0x${string}` | undefined) ?? null;
    return {
      node: d.id as `0x${string}`,
      label: d.labelName ?? d.id.slice(0, 10),
      kind: texts.has("kind") ? "agent" : "human",
      elo: "",
      endpoint: "",
      inftId: "",
      address,
    };
  });
}

// -------------------------------------------------------------------------
// Discovery entry card
// -------------------------------------------------------------------------

function EntryCard({ entry }: { entry: DiscoveryEntry }) {
  const hasEndpoint = !!entry.endpoint;
  const hasInfoLink = entry.kind === "agent" && !!entry.inftId;
  const isHuman = entry.kind === "human";

  // The connected wallet's own subname; lets us recover an address for the
  // user's own card even when the subgraph didn't expose `resolver.addr` or
  // `wrappedOwner`. This is the same trick ProfileBadge relies on.
  const { address: connectedAddress } = useAccount();
  const { label: connectedLabel } = useChaingammonName(connectedAddress);

  const resolvedAddress: `0x${string}` | undefined =
    entry.address ??
    (isHuman && connectedAddress && connectedLabel === entry.label
      ? connectedAddress
      : undefined);

  // ENS text records (`elo`, `match_count`) for humans. Agents render an
  // ELO placeholder; their stats come from AgentsList.
  const { elo: eloText, matchCount } = useChaingammonProfile(
    isHuman ? entry.label : null,
  );
  // MatchRecorded event scan to break match_count into wins/losses.
  const { summary } = useHumanMatchSummary(
    isHuman ? resolvedAddress : undefined,
  );
  // Fallback ELO source: MatchRegistry.humanElo(address). The settlement
  // flow doesn't always write the ENS `elo` text record, so the on-chain
  // map is the authoritative current rating. Mirrors ProfileBadge.
  const chainId = useActiveChainId();
  const { matchRegistry } = useChainContracts();
  const { data: chainEloRaw } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "humanElo",
    args: resolvedAddress ? [resolvedAddress] : undefined,
    chainId,
    query: { enabled: isHuman && !!resolvedAddress && !eloText },
  });

  const eloDisplay =
    eloText ||
    (chainEloRaw != null ? String(chainEloRaw) : "") ||
    entry.elo ||
    "—";
  const matches = summary?.matches ?? (matchCount ? Number(matchCount) : null);
  const wins = summary?.wins ?? null;
  const losses = summary?.losses ?? null;

  return (
    <div
      data-testid="discovery-entry"
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">
          {entry.label}.chaingammon.eth
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {hasInfoLink && (
            <a
              href={`/agent/${entry.inftId}`}
              target="_blank"
              rel="noreferrer"
              data-testid="discovery-agent-info-link"
              title="Open agent info in a new tab"
              className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            >
              Info ↗
            </a>
          )}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-mono text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {entry.kind || "unknown"}
          </span>
        </div>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          ELO
        </span>
        <span className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {eloDisplay}
        </span>
      </div>

      {isHuman && (
        <dl
          data-testid="discovery-human-stats"
          className="grid grid-cols-3 gap-2 border-t border-zinc-200 pt-3 text-center dark:border-zinc-800"
        >
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Played
            </dt>
            <dd className="font-mono text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {matches ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Won
            </dt>
            <dd className="font-mono text-base font-semibold text-emerald-600 dark:text-emerald-400">
              {wins ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Lost
            </dt>
            <dd className="font-mono text-base font-semibold text-rose-600 dark:text-rose-400">
              {losses ?? "—"}
            </dd>
          </div>
        </dl>
      )}

      {hasEndpoint && (
        <Link
          href={`/match?endpoint=${encodeURIComponent(entry.endpoint)}`}
          data-testid="discovery-play-button"
          className="mt-1 rounded-md bg-indigo-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          Play
        </Link>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Prop types for static fixture use
// -------------------------------------------------------------------------

export interface DiscoveryListProps {
  /** Pre-populated entries for test fixture pages (no blockchain read). */
  staticEntries?: DiscoveryEntry[];
}

// -------------------------------------------------------------------------
// Main component
// -------------------------------------------------------------------------

export function DiscoveryList({ staticEntries }: DiscoveryListProps = {}) {
  const active = useActiveChain();
  const ensInfra = useEnsInfra();
  const [entries, setEntries] = useState<DiscoveryEntry[] | null>(staticEntries ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (staticEntries) return;
    if (!ensInfra) return;
    let cancelled = false;
    fetchSubnameEntries(ensInfra.subgraphUrl)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [ensInfra, staticEntries]);

  if (!staticEntries) {
    if (!active) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No Chaingammon deployment on this chain. Switch your wallet to see identities.
        </p>
      );
    }
    if (!ensInfra) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No ENS infrastructure configured for this chain.
        </p>
      );
    }
    if (error) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Could not reach the ENS subgraph at <code className="font-mono">{ensInfra.subgraphUrl}</code>.
        </p>
      );
    }
    if (entries === null) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
    }
  }

  const allEntries = entries ?? [];
  const humans = allEntries.filter((e) => e.kind === "human");

  return (
    <div className="flex flex-col gap-8">
      <section data-testid="discovery-humans-section">
        <h2
          data-testid="discovery-humans-header"
          className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Humans
        </h2>
        {humans.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No humans registered yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {humans.map((e) => (
              <EntryCard key={e.node} entry={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
