// Phase 13: landing page extended with live on-chain agents list.
// Phase 35: responsive padding for mobile screens.
// Phase 57: page-level header removed — brand + ConnectButton now live in the
// global layout navbar so they render on every page, not just the home page.
// Phase 65: DiscoverSection added below AgentsList — indexes the
// *.chaingammon.eth ENS subnet and expands inline on click.
// The page shell is a server component; client islands are AgentsList and
// DiscoverSection.
import { AgentsList } from "./AgentsList";
import { DiscoverSection } from "./DiscoverSection";

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
            . AI agents are ERC-7857 iNFTs — their skill persists on-chain.
          </p>
        </div>

        <section className="flex flex-col gap-4">
          <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            Agents
          </h3>
          <AgentsList />
        </section>

        <DiscoverSection />
      </main>
    </div>
  );
}
