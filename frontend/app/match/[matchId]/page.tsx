// Phase 20: match replay — step through a finalized match move-by-move.
//
// Route: /match/<matchId>
//
// Flow:
//   1. Read MatchRegistry.getMatch(matchId) on-chain → returns the match
//      tuple including the 0G Storage `gameRecordHash`.
//   2. Hit `GET /game-records/<hash>` on the server, which fetches the
//      blob from 0G Storage and decodes each `position_id_after` into a
//      board state.
//   3. Render <Board> for the currently-selected move, with prev/next
//      controls.
"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";

import { Board } from "../../Board";
import { useActiveChainId } from "../../chains";
import { DiceRoll } from "../../DiceRoll";
import { MatchRegistryABI, useChainContracts } from "../../contracts";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface ReplayState {
  turn: number;
  dice: number[];
  move: string;
  board: number[];
  bar: number[];
  off: number[];
}

interface PlayerRef {
  kind: "agent" | "human";
  address?: string;
  agent_id?: number;
}

interface ReplayPayload {
  record: {
    final_score: number[];
    match_length: number;
    winner: PlayerRef;
    loser: PlayerRef;
    started_at: string;
    ended_at: string;
  };
  states: ReplayState[];
}

interface MatchInfo {
  timestamp: bigint;
  winnerAgentId: bigint;
  winnerHuman: `0x${string}`;
  loserAgentId: bigint;
  loserHuman: `0x${string}`;
  matchLength: number;
  gameRecordHash: `0x${string}`;
}

function describePlayer(p: PlayerRef): string {
  if (p.kind === "agent") return `Agent #${p.agent_id ?? "?"}`;
  if (!p.address) return "Human";
  return `${p.address.slice(0, 6)}…${p.address.slice(-4)}`;
}

export default function ReplayPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  // Next 16 surfaces dynamic route params as a Promise; unwrap with React.use.
  const { matchId } = use(params);
  const matchIdBig = (() => {
    try {
      return BigInt(matchId);
    } catch {
      return null;
    }
  })();

  const chainId = useActiveChainId();
  const { matchRegistry } = useChainContracts();

  const { data: matchInfo, isLoading: matchLoading } = useReadContract({
    address: matchRegistry,
    abi: MatchRegistryABI,
    functionName: "getMatch",
    args: matchIdBig !== null ? [matchIdBig] : undefined,
    chainId,
    query: { enabled: matchIdBig !== null },
  });

  const info = matchInfo as MatchInfo | undefined;
  const gameRecordHash = info?.gameRecordHash;
  const hasRecord =
    !!gameRecordHash && gameRecordHash !== `0x${"00".repeat(32)}`;

  const {
    data: replay,
    isLoading: replayLoading,
    error: replayError,
  } = useQuery<ReplayPayload>({
    queryKey: ["game-record", gameRecordHash],
    queryFn: async () => {
      const res = await fetch(`${API}/game-records/${gameRecordHash}`);
      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        throw new Error(body);
      }
      return res.json() as Promise<ReplayPayload>;
    },
    enabled: hasRecord,
  });

  const [moveIndex, setMoveIndex] = useState(0);
  const states = replay?.states ?? [];
  const totalMoves = states.length;
  const currentState = states[moveIndex];

  // ── Render guards ──────────────────────────────────────────────────────
  if (matchIdBig === null) {
    return (
      <Shell>
        <p className="text-red-600 dark:text-red-400">
          Invalid match id: {matchId}
        </p>
      </Shell>
    );
  }
  if (matchLoading) {
    return (
      <Shell>
        <p className="text-zinc-500 dark:text-zinc-400">Loading match…</p>
      </Shell>
    );
  }
  if (!info || info.timestamp === BigInt(0)) {
    return (
      <Shell>
        <p className="text-zinc-500 dark:text-zinc-400">
          Match #{matchId} not found on-chain.
        </p>
      </Shell>
    );
  }
  if (!hasRecord) {
    return (
      <Shell>
        <p className="text-zinc-500 dark:text-zinc-400">
          Match #{matchId} has no archived game record.
        </p>
      </Shell>
    );
  }
  if (replayLoading) {
    return (
      <Shell>
        <p className="text-zinc-500 dark:text-zinc-400">
          Loading replay from 0G Storage…
        </p>
      </Shell>
    );
  }
  if (replayError || !replay) {
    return (
      <Shell>
        <p className="text-red-600 dark:text-red-400">
          Could not load replay: {String(replayError ?? "unknown error")}
        </p>
      </Shell>
    );
  }
  if (totalMoves === 0) {
    return (
      <Shell>
        <p className="text-zinc-500 dark:text-zinc-400">
          This match has no recorded moves to replay.
        </p>
      </Shell>
    );
  }

  // ── Replay UI ──────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
          Match #{matchId}
        </span>
        <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
          {replay.record.final_score[0]}–{replay.record.final_score[1]}
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          <div>
            <span className="font-semibold">Winner:</span>{" "}
            {describePlayer(replay.record.winner)}
          </div>
          <div>
            <span className="font-semibold">Loser:</span>{" "}
            {describePlayer(replay.record.loser)}
          </div>
          <div className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            archive: {gameRecordHash?.slice(0, 10)}… on 0G Storage
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMoveIndex(0)}
            disabled={moveIndex === 0}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            ⏮ Start
          </button>
          <button
            type="button"
            onClick={() => setMoveIndex(Math.max(0, moveIndex - 1))}
            disabled={moveIndex === 0}
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
            Move {moveIndex + 1} / {totalMoves}
          </span>
          <button
            type="button"
            onClick={() =>
              setMoveIndex(Math.min(totalMoves - 1, moveIndex + 1))
            }
            disabled={moveIndex === totalMoves - 1}
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Next →
          </button>
          <button
            type="button"
            onClick={() => setMoveIndex(totalMoves - 1)}
            disabled={moveIndex === totalMoves - 1}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            End ⏭
          </button>
        </div>

        <Board
          board={currentState.board}
          bar={currentState.bar}
          off={currentState.off}
          turn={currentState.turn}
        />

        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          {currentState.dice.length > 0 ? (
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Dice
              </span>
              <DiceRoll dice={currentState.dice} />
            </div>
          ) : null}
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            <span className="text-xs uppercase tracking-wide text-zinc-500">
              Player
            </span>{" "}
            {currentState.turn === 0 ? "Blue (player 0)" : "Red (player 1)"}
          </p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            <span className="text-xs uppercase tracking-wide text-zinc-500">
              Move
            </span>{" "}
            <code className="font-mono">{currentState.move || "—"}</code>
          </p>
        </div>
      </main>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
          Match replay
        </span>
        <span />
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-2 px-8 py-16">
        {children}
      </main>
    </div>
  );
}
