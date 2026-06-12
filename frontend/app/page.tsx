"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keccak256, toBytes } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { AgentsList } from "./AgentsList";
import { DiscoveryList } from "./DiscoveryList";
import { HomeActionChips } from "./HomeActionChips";
import { useAppMode } from "./AppModeContext";
import { useI18n } from "./i18n";
import { MatchRegistryABI, useChainContracts } from "./contracts";
import { useActiveChainId } from "./chains";
import { NostrMatchClient, newIdentity } from "../lib/nostr";
import { computePairing } from "../lib/matchmaker";
import { connectPeer } from "../lib/webrtc_match";
import { peerMatches } from "../lib/peer_connections";

const STABILIZE_MS = 3_000;
const PRESENCE_TTL_S = 22;
const PRESENCE_INTERVAL_MS = 10_000; // 10s: stays under relay rate limits while keeping discovery fast
const CONNECT_TIMEOUT_MS = 15_000;
const REPAIR_MS = 5_000;    // retry pairing interval
const GIVE_UP_MS = 120_000; // fall back to agent after 2 minutes without a match

function hvhMatchId(pubA: string, pubB: string): string {
  const [lo, hi] = pubA < pubB ? [pubA, pubB] : [pubB, pubA];
  return keccak256(toBytes(lo + hi));
}

// ── Elo homepage glyphs ──────────────────────────────────────────────────────
function DiceGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <rect x="3"  y="7"  width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="10" y="3"  width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6.5"  cy="10.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="14.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="6.5"  r="1" fill="currentColor" />
      <circle cx="15.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}
function CheckerGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}
function CoinGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

interface ActionCardProps {
  variant: "primary" | "secondary";
  glyph: React.ReactNode;
  label: string;
  sublabel: string;
  meta: string;
  href?: string;
  onClick?: () => void;
}

function ActionCard({ variant, glyph, label, sublabel, meta, href, onClick }: ActionCardProps) {
  const primary = variant === "primary";
  const cardStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "20px 18px",
    borderRadius: "var(--cg-radius)",
    background: primary ? "var(--cg-brass)" : "var(--cg-bg-2)",
    border: primary ? "1px solid var(--cg-brass-hi)" : "1px solid var(--cg-line-2)",
    color: primary ? "var(--cg-brass-ink)" : "var(--cg-fg-1)",
    textDecoration: "none",
    transition: "background 120ms ease, border-color 120ms ease",
    cursor: "pointer",
    textAlign: "left" as const,
    width: "100%",
  };
  const inner = (
    <>
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 44, height: 44,
        borderRadius: "var(--cg-radius-sm)",
        background: primary ? "var(--cg-brass-ink)" : "var(--cg-bg-0)",
        border: primary ? "1px solid rgba(26,18,8,0.6)" : "1px solid var(--cg-line-2)",
        color: "var(--cg-brass)",
        flexShrink: 0,
      }}>
        {glyph}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" as const }}>
          <span style={{
            fontFamily: "var(--cg-font-sans)",
            fontSize: 20, fontWeight: 600,
            letterSpacing: "-0.01em", lineHeight: 1,
          }}>{label}</span>
          <span style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 11, fontWeight: 500,
            letterSpacing: "0.04em",
            color: primary ? "rgba(26,18,8,0.65)" : "var(--cg-fg-3)",
          }}>{meta}</span>
        </span>
        <span style={{
          fontFamily: "var(--cg-font-sans)",
          fontSize: 12, fontWeight: 400, lineHeight: 1.4,
          color: primary ? "rgba(26,18,8,0.72)" : "var(--cg-fg-3)",
        }}>{sublabel}</span>
      </span>
      <span style={{
        fontFamily: "var(--cg-font-mono)", fontSize: 18, lineHeight: 1,
        color: primary ? "var(--cg-brass-ink)" : "var(--cg-fg-3)",
        flexShrink: 0,
      }}>→</span>
    </>
  );
  if (onClick) {
    return <button type="button" onClick={onClick} style={cardStyle}>{inner}</button>;
  }
  return <Link href={href!} style={cardStyle}>{inner}</Link>;
}

function EloHome() {
  const { address } = useAccount();
  const { matchRegistry } = useChainContracts();
  const chainId = useActiveChainId();
  const { setMode } = useAppMode();
  const router = useRouter();

  const { data: chainEloRaw } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "humanElo",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!address, refetchInterval: 10000 },
  });
  const elo = chainEloRaw != null ? String(chainEloRaw) : undefined;

  // ELO delta: compare current on-chain value against the last-seen value
  // stored in localStorage. Updated only when the value actually changes so
  // the badge persists across page visits until the next match settles.
  const [eloDelta, setEloDelta] = useState<number | null>(null);
  useEffect(() => {
    if (chainEloRaw == null || !address) return;
    const key = `chaingammon.lastElo.${address.toLowerCase()}`;
    const prev = localStorage.getItem(key);
    const current = Number(chainEloRaw);
    if (prev !== null) {
      const delta = current - Number(prev);
      if (delta !== 0) setEloDelta(delta);
    }
    localStorage.setItem(key, String(current));
  }, [chainEloRaw, address]);

  // ── Human-vs-human matchmaking (falls back to train on no match) ──────────
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const nostrRef = useRef<NostrMatchClient | null>(null);
  const searchersRef = useRef<Map<string, { s: { pubkey: string; elo: number }; at: number }>>(new Map());
  const connectingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopSearching = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    connectingRef.current = false;
    nostrRef.current?.stopPresence();
    nostrRef.current?.close();
    nostrRef.current = null;
    searchersRef.current.clear();
    setSearching(false);
    setSearchStatus("");
  }, []);

  const tryConnect = useCallback((nostr: NostrMatchClient, myElo: number) => {
    if (connectingRef.current) return;
    const now = Date.now() / 1000;
    for (const [pk, entry] of searchersRef.current) {
      if (now - entry.at > PRESENCE_TTL_S) searchersRef.current.delete(pk);
    }
    const searchers = [
      { pubkey: nostr.pubkey, elo: myElo },
      ...Array.from(searchersRef.current.values()).map((e) => e.s),
    ];
    const { partner, isOfferer } = computePairing(nostr.pubkey, searchers);
    if (!partner) {
      // No partner yet — update status and let the repair timer retry.
      // Do NOT fall back to agent here: Nostr presence events may not have
      // propagated yet when this fires (race with STABILIZE_MS).
      setSearchStatus(
        searchersRef.current.size === 0
          ? "No one found yet — open console for debug"
          : `${searchersRef.current.size} found, pairing…`,
      );
      return;
    }
    connectingRef.current = true;
    const mid = hvhMatchId(nostr.pubkey, partner.pubkey);
    setSearchStatus("Connecting…");
    const peer = connectPeer(nostr, partner.pubkey, mid, isOfferer);
    peerMatches.set(mid, { peer, isOfferer });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      connectingRef.current = false;
      peer.close();
      peerMatches.delete(mid);
      setSearchStatus("Timed out, retrying…");
      // repair timer will retry
    }, CONNECT_TIMEOUT_MS);
    peer.onState((s) => {
      if (timedOut) return;
      if (s === "open") {
        clearTimeout(timer);
        nostr.stopPresence();
        // Use query-param form (?id=) — path segments cause 404 on static hosts.
        router.push(`/play-human?id=${mid}`);
      } else if (s === "failed" || s === "closed") {
        clearTimeout(timer);
        connectingRef.current = false;
        peerMatches.delete(mid);
        setSearchStatus("Retry…");
        // repair timer will retry
      }
    });
  }, [router]);

  const startPlay = useCallback(() => {
    const id = newIdentity();
    const nostr = new NostrMatchClient(id);
    nostrRef.current = nostr;
    const myEloNum = Number(chainEloRaw ?? 1500) || 1500;
    nostr.startPresence({ ensLabel: "", address: address ?? "", sessionPubkey: nostr.pubkey, elo: myEloNum }, PRESENCE_INTERVAL_MS);
    const unsub = nostr.subscribePresence((p, pubkey, at) => {
      // Skip our own presence echo (same wallet address AND same Nostr pubkey).
      // Different pubkey = different browser tab/window sharing a wallet — allow matching.
      if (p.address && address && p.address.toLowerCase() === address.toLowerCase() && pubkey === nostr.pubkey) {
        console.debug("[hvh] ignored self-echo", pubkey.slice(0, 8));
        return;
      }
      console.debug("[hvh] presence received from", pubkey.slice(0, 8), "elo", p.elo, "addr", p.address?.slice(0, 8));
      // Key by wallet address so multiple Nostr sessions from the same wallet
      // collapse to one entry; keep whichever arrived most recently.
      const key = p.address || pubkey;
      const existing = searchersRef.current.get(key);
      if (!existing || at >= existing.at) {
        searchersRef.current.set(key, { s: { pubkey, elo: p.elo ?? 1500 }, at });
      }
    });
    // First attempt after presence has had time to stabilize.
    const stabilizeTimer = setTimeout(() => tryConnect(nostr, myEloNum), STABILIZE_MS);
    // Retry every REPAIR_MS so late-arriving peers are picked up.
    const repairTimer = setInterval(() => {
      if (!connectingRef.current) tryConnect(nostr, myEloNum);
    }, REPAIR_MS);
    // Give up and fall back to agent after GIVE_UP_MS of searching.
    const giveUpTimer = setTimeout(() => {
      stopSearching();
      router.push("/team-demo?opponents=4");
    }, STABILIZE_MS + GIVE_UP_MS);
    cleanupRef.current = () => {
      clearTimeout(stabilizeTimer);
      clearInterval(repairTimer);
      clearTimeout(giveUpTimer);
      unsub();
    };
    setSearching(true);
    setSearchStatus("Searching for a human…");
  }, [address, chainEloRaw, tryConnect, stopSearching, router]);

  useEffect(() => () => stopSearching(), [stopSearching]);

  return (
    <div style={{
      flex: 1,
      background: [
        "radial-gradient(circle at 18% 10%, rgba(227,183,121,0.05) 0, transparent 45%)",
        "radial-gradient(circle at 84% 92%, rgba(201,155,92,0.03) 0, transparent 50%)",
        "var(--cg-bg-0)",
      ].join(", "),
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{
        maxWidth: 412, width: "100%",
        margin: "0 auto",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--cg-line-1)",
        borderRight: "1px solid var(--cg-line-1)",
      }}>
        {/* Hero */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: 18, padding: "40px 16px 28px",
        }}>
          <span style={{
            fontFamily: "var(--cg-font-sans)",
            fontSize: 11, fontWeight: 500,
            letterSpacing: "0.22em", textTransform: "uppercase" as const,
            color: "var(--cg-fg-3)",
          }}>Elo mode</span>

          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chaingammon-icon.svg`}
            alt=""
            width={84} height={84}
            style={{ display: "block" }}
          />

          <h1 style={{
            margin: 0,
            fontFamily: "var(--cg-font-display)",
            fontSize: 44, fontWeight: 400,
            lineHeight: 1, letterSpacing: "-0.02em",
            display: "inline-flex", alignItems: "baseline",
          }}>
            <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>Chain</span>
            <span style={{ color: "var(--cg-brass)", padding: "0 0.05em" }}>·</span>
            <span style={{ color: "var(--cg-fg-1)" }}>Gammon</span>
          </h1>

          {elo && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 10,
              padding: "8px 14px",
              borderRadius: "var(--cg-radius-pill)",
              background: "rgba(201,155,92,0.10)",
              border: "1px solid rgba(201,155,92,0.35)",
            }}>
              <span style={{
                fontFamily: "var(--cg-font-sans)",
                fontSize: 10, fontWeight: 500,
                letterSpacing: "0.18em", textTransform: "uppercase" as const,
                color: "var(--cg-brass-hi)",
              }}>ELO</span>
              <span style={{
                fontFamily: "var(--cg-font-mono)",
                fontSize: 20, fontWeight: 600,
                color: "var(--cg-fg-1)", lineHeight: 1,
              }}>{elo}</span>
              {eloDelta !== null && (
                <span style={{
                  fontFamily: "var(--cg-font-mono)",
                  fontSize: 11, fontWeight: 500,
                  color: eloDelta >= 0 ? "var(--cg-success)" : "var(--cg-danger)",
                }}>
                  {eloDelta >= 0 ? "▲" : "▼"}{Math.abs(eloDelta)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* CTAs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 16px 24px" }}>
          <ActionCard
            variant="secondary"
            glyph={<DiceGlyph />}
            label="Train"
            meta="UNRATED"
            sublabel="Practice vs. bot · no Elo change"
            href="/team-demo?opponents=4"
          />
          <ActionCard
            variant="primary"
            glyph={<CheckerGlyph />}
            label={searching ? "Searching…" : "Play"}
            meta="RATED"
            sublabel={searching ? searchStatus : "Find a human first · falls back to bot"}
            onClick={searching ? stopSearching : startPlay}
          />
          <ActionCard
            variant="secondary"
            glyph={<CoinGlyph />}
            label="Play ($)"
            meta="STAKE"
            sublabel="Wagered match · winner takes pot"
            href="/match?stake=1"
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Footer */}
        <div style={{
          padding: "16px",
          borderTop: "1px solid var(--cg-line-1)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12,
        }}>
          <span style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 10, color: "var(--cg-fg-4)",
            letterSpacing: "0.04em",
          }}>7-pt · single cube · 30s/move</span>
          <button
            onClick={() => setMode("advanced")}
            style={{
              fontFamily: "var(--cg-font-sans)",
              fontSize: 11, fontWeight: 500,
              color: "var(--cg-brass)",
              letterSpacing: "0.04em",
              background: "none", border: "none", cursor: "pointer", padding: 0,
            }}
          >
            Advanced ↗
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { t } = useI18n();
  const { mode, hydrated } = useAppMode();

  if (!hydrated) return null;

  if (mode === "elo") {
    return <EloHome />;
  }

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", background: "var(--cg-bg-0)" }}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-10 sm:px-8 sm:py-16">

        {/* Hero */}
        <div className="flex flex-col gap-5 cg-fade-up">
          {/* Eyebrow */}
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "var(--cg-font-sans)",
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "var(--cg-brass)",
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--cg-brass)",
              boxShadow: "0 0 10px rgba(201,155,92,0.7)",
              flexShrink: 0,
            }} />
            {t("hero_eyebrow")}
          </div>

          <h1 style={{
            fontFamily: "var(--cg-font-display)",
            fontWeight: 400,
            fontSize: "clamp(34px, 6vw, 56px)",
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            color: "var(--cg-fg-1)",
            margin: 0,
            maxWidth: "min(640px, 100%)",
          }}>
            {t("hero_line1")}<br />
            <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>{t("hero_line2_italic")}</span>
            <span style={{ color: "var(--cg-brass)" }}>{t("hero_line2_end")}</span>
          </h1>

          <p className="cg-fade-up-1" style={{ maxWidth: 500, fontSize: 15, lineHeight: 1.65, color: "var(--cg-fg-2)", margin: 0 }}>
            Every match settles on 0G Chain and updates your portable ENS
            reputation at{" "}
            <code style={{ fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-1)", fontSize: 13 }}>
              &lt;name&gt;.chaingammon.eth
            </code>
            . AI agents are NFTs — their skill persists on-chain.
          </p>
        </div>

        {/* Protocol strip */}
        <section style={{ borderTop: "1px solid var(--cg-line-1)", paddingTop: 48, paddingBottom: 56 }}>
          <div style={{
            fontFamily: "var(--cg-font-sans)", fontSize: 11, fontWeight: 500,
            letterSpacing: "0.22em", textTransform: "uppercase" as const,
            color: "var(--cg-fg-3)", marginBottom: 32,
          }}>
            How the protocol works
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 32,
          }}>
            {[
              {
                eb: "In your wallet",
                h: "A portable name.",
                p: "Every player gets an ENS subname — <name>.chaingammon.eth — whose text records hold your live ELO and a link to every match you have ever played.",
              },
              {
                eb: "On-chain",
                h: "A public registry.",
                p: "Match results write to a smart contract on 0G Chain. Ratings update by a transparent fixed-point ELO formula. No private database, no opaque matchmaking.",
              },
              {
                eb: "On 0G Storage",
                h: "Every move, replayable.",
                p: "Each game record — dice, moves, final position — is archived on 0G Storage. Anyone can replay the match from its on-chain hash alone.",
              },
            ].map((item) => (
              <div key={item.eb} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{
                  fontFamily: "var(--cg-font-sans)", fontSize: 11, fontWeight: 500,
                  letterSpacing: "0.18em", textTransform: "uppercase" as const,
                  color: "var(--cg-brass)",
                }}>{item.eb}</div>
                <div style={{
                  fontFamily: "var(--cg-font-display)", fontWeight: 400, fontSize: 28,
                  lineHeight: 1.2, letterSpacing: "-0.015em", color: "var(--cg-fg-1)",
                }}>{item.h}</div>
                <p style={{
                  fontFamily: "var(--cg-font-sans)", fontSize: 14, lineHeight: 1.6,
                  color: "var(--cg-fg-2)", margin: 0,
                }}>{item.p}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Agents section */}
        <section className="flex flex-col gap-4 cg-fade-up-2">
          <div style={{ borderTop: "1px solid var(--cg-line-1)", paddingTop: 24 }}>
            <div className="flex items-baseline gap-3 flex-wrap" style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: "var(--cg-font-sans)",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "var(--cg-fg-3)",
              }}>
                {t("live_agents")}
              </div>
              <HomeActionChips />
            </div>
          </div>
          <AgentsList />
        </section>

        <section className="flex flex-col gap-4 cg-fade-up-3">
          <DiscoveryList playersOnly />
        </section>

        <Link
          href="/transactions"
          style={{ fontSize: 13, color: "var(--cg-fg-4)", textDecoration: "none" }}
        >
          {t("transactions")}
        </Link>
      </main>

      {/* Footer */}
      <footer style={{
        borderTop: "1px solid var(--cg-line-1)",
        padding: "32px 32px",
        maxWidth: 768, margin: "0 auto", width: "100%",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 32, flexWrap: "wrap" as const,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chaingammon-icon-mono.svg`}
            alt=""
            width={24}
            height={24}
          />
          <span style={{
            fontFamily: "var(--cg-font-display)", fontStyle: "italic",
            fontSize: 16, color: "var(--cg-fg-3)",
          }}>
            Your rating, etched on chain.
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <a
            href="https://github.com/oslinin/chaingammon"
            style={{ fontFamily: "var(--cg-font-sans)", fontSize: 13, color: "var(--cg-fg-2)", textDecoration: "none" }}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://app.ens.domains/chaingammon.eth"
            style={{ fontFamily: "var(--cg-font-sans)", fontSize: 13, color: "var(--cg-fg-2)", textDecoration: "none" }}
            target="_blank"
            rel="noopener noreferrer"
          >
            chaingammon.eth
          </a>
          <span style={{ fontFamily: "var(--cg-font-mono)", fontSize: 11, color: "var(--cg-fg-4)" }}>
            v0.6 · testnet
          </span>
        </div>
      </footer>
    </div>
  );
}
