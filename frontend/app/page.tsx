// Phase 13: landing page extended with live on-chain agents list.
// The page shell is a server component; <AgentsList> is a client component
// that performs the wagmi reads.
import { ConnectButton } from "./ConnectButton";
import { AgentsList } from "./AgentsList";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Chaingammon
        </h1>
        <ConnectButton />
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-16">
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
            Available agents
          </h3>
          <AgentsList />
        </section>
      </main>
    </div>
  );
}
