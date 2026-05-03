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

import { useActiveChain, useEnsInfra } from "./chains";

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
    domains(where: { parent_: { name: $parent } }, first: 100) {
      id
      labelName
      name
      resolver {
        texts
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
    resolver: { texts: string[] | null } | null;
  }>;

  // The subgraph reports which text keys exist; the actual values are not
  // included in the listing query. For the demo we only need the kind/elo/
  // endpoint/inft_id keys when the resolver advertises them. For now we
  // surface every domain and let the consumer fall back to "" for missing
  // values; pulling actual text values would need a per-domain follow-up
  // query against the resolver, which is outside the scope of this view.
  return domains.map((d) => {
    const texts = new Set(d.resolver?.texts ?? []);
    return {
      node: d.id as `0x${string}`,
      label: d.labelName ?? d.id.slice(0, 10),
      kind: texts.has("kind") ? "human" : "human",
      elo: "",
      endpoint: "",
      inftId: "",
    };
  });
}

// -------------------------------------------------------------------------
// Discovery entry card
// -------------------------------------------------------------------------

function EntryCard({ entry }: { entry: DiscoveryEntry }) {
  const hasEndpoint = !!entry.endpoint;
  const hasInfoLink = entry.kind === "agent" && !!entry.inftId;
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
          {entry.elo || "—"}
        </span>
      </div>

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
