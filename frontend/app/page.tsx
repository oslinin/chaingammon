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

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-8 sm:py-16">
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Open backgammon protocol
          </h2>
          <p className="max-w-xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Every match settles on 0G Chain and updates your portable ENS
            reputation at{" "}
            <code className="font-mono text-zinc-900 dark:text-zinc-100">
              &lt;name&gt;.chaingammon.eth
            </code>
            . AI agents are NFTs — their skill persists on-chain.
          </p>
        </div>

        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Agents
            </h2>
            <a
              href="/create-agent"
              className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700/40 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
            >
              Mint
            </a>
            <a
              href="/training"
              className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Train
            </a>
            <a
              href="/team-demo"
              className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Off-chain game
            </a>
            <a
              href="/team-demo?settle=1"
              className="rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
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
          className="text-sm text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
        >
          Transactions
        </a>
      </main>
    </div>
  );
}
