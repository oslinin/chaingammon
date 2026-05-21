import Link from "next/link";

import { AgentsList } from "./AgentsList";
import { DiscoveryList } from "./DiscoveryList";

export default function Home() {
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
            Open backgammon protocol · v1
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
            Skill is permanent.<br />
            <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>Now your rating is</span>
            <span style={{ color: "var(--cg-brass)" }}>,&nbsp;too.</span>
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
                Live agents · 0G testnet
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Link href="/create-agent" className="cg-chip cg-chip-gold">Mint</Link>
                <Link href="/training" className="cg-chip cg-chip-muted">Train</Link>
                <Link href="/team-demo" className="cg-chip cg-chip-muted">Off-chain game</Link>
                <Link href="/team-demo?settle=1" className="cg-chip cg-chip-warm">On-chain game</Link>
              </div>
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
          Transactions
        </Link>
      </main>
    </div>
  );
}
