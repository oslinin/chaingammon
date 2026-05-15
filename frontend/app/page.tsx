// Phase 13: landing page extended with live on-chain agents list.
// Phase 35: responsive padding for mobile screens.
// Phase 57: page-level header removed — brand + ConnectButton now live in the
// global layout navbar so they render on every page, not just the home page.
// Phase 65: DiscoverSection added below AgentsList — indexes the
// *.chaingammon.eth ENS subnet and expands inline on click.
// The page shell is a server component; client islands are AgentsList and
// DiscoverSection.
import { AgentsList } from "./AgentsList";
import { DiscoveryList } from "./DiscoveryList";

const chipBase: React.CSSProperties = {
  display: "inline-block",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 500,
  textDecoration: "none",
  fontFamily: "var(--font-sans)",
};

export default function Home() {
  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", background: "var(--cg-bg-0)" }}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-8 sm:py-16">
        {/* Hero */}
        <div className="flex flex-col gap-3">
          <h2
            style={{
              fontSize: 30,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: "var(--cg-fg-1)",
              fontFamily: "var(--cg-font-sans)",
              margin: 0,
            }}
          >
            Open backgammon protocol
          </h2>
          <p style={{ maxWidth: 480, fontSize: 15, lineHeight: 1.6, color: "var(--cg-fg-2)", margin: 0 }}>
            Every match settles on 0G Chain and updates your portable ENS
            reputation at{" "}
            <code style={{ fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-1)", fontSize: 13 }}>
              &lt;name&gt;.chaingammon.eth
            </code>
            . AI agents are NFTs — their skill persists on-chain.
          </p>
        </div>

        {/* Agents section */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <h2
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: "var(--cg-fg-1)",
                fontFamily: "var(--cg-font-sans)",
                margin: 0,
              }}
            >
              Agents
            </h2>
            <a
              href="/create-agent"
              style={{
                ...chipBase,
                border: "1px solid rgba(201,155,92,0.35)",
                background: "rgba(201,155,92,0.10)",
                color: "var(--cg-brass-hi)",
              }}
            >
              Mint
            </a>
            <a
              href="/training"
              style={{
                ...chipBase,
                border: "1px solid var(--cg-line-2)",
                background: "var(--cg-bg-2)",
                color: "var(--cg-fg-2)",
              }}
            >
              Train
            </a>
            <a
              href="/team-demo"
              style={{
                ...chipBase,
                border: "1px solid var(--cg-line-2)",
                background: "var(--cg-bg-2)",
                color: "var(--cg-fg-2)",
              }}
            >
              Off-chain game
            </a>
            <a
              href="/team-demo?settle=1"
              style={{
                ...chipBase,
                border: "1px solid var(--cg-brass)",
                background: "rgba(201,155,92,0.12)",
                color: "var(--cg-brass)",
              }}
            >
              On-chain game
            </a>
          </div>
          <AgentsList />
        </section>

        <section className="flex flex-col gap-4">
          <DiscoveryList playersOnly />
        </section>

        <a
          href="/transactions"
          style={{ fontSize: 13, color: "var(--cg-fg-4)", textDecoration: "none" }}
        >
          Transactions
        </a>
      </main>
    </div>
  );
}
