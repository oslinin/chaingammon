// Phase 14: match flow page — start, roll, move, end.
//
// URL: /match?agentId=<N>
//
// State machine:
//   idle          → call POST /games, transition to playing
//   playing       → human turn (turn=0) or agent turn (turn=1)
//     human, no dice  → show Roll button → POST /games/:id/roll
//     human, dice     → show move input  → POST /games/:id/move
//     agent           → auto-POST /games/:id/roll (if no dice), then /games/:id/agent-move
//   over          → show result + placeholder "Settle on-chain" button
//
// Move notation is gnubg's standard: "8/5 6/5" (from-point/to-point, space-
// separated for multiple checker movements). See docs/gnubg-notation.md or
// the server test suite for examples.
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Board } from "../Board";
import { DiceRoll } from "../DiceRoll";

// ── Types matching server/app/game_state.py ────────────────────────────────

interface GameState {
  game_id: string;
  match_id: string;
  position_id: string;
  board: number[];
  bar: number[];
  off: number[];
  turn: number;
  dice: number[] | null;
  cube: number;
  cube_owner: number;
  match_length: number;
  score: number[];
  game_over: boolean;
  winner: number | null;
}

// ── API helpers ────────────────────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function apiFetch(path: string, body?: object): Promise<GameState> {
  const res = await fetch(`${API}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<GameState>;
}

// ── Component ──────────────────────────────────────────────────────────────

// Suspense boundary is required by Next.js when useSearchParams is used inside
// a page — without it, static prerendering bails out at build time.
export default function MatchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Loading…</p>
        </div>
      }
    >
      <MatchInner />
    </Suspense>
  );
}

function MatchInner() {
  const params = useSearchParams();
  const agentId = Number(params.get("agentId") ?? "1");

  const [game, setGame] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  // Guard against triggering the agent move multiple times while a request
  // is already in flight.
  const agentMoving = useRef(false);

  // ── Start a new game on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch("/games", { match_length: 3, agent_id: agentId })
      .then((state) => {
        if (!cancelled) setGame(state);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // agentId is intentionally fixed for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-drive agent turn ──────────────────────────────────────────────
  useEffect(() => {
    if (!game || game.game_over || game.turn !== 1 || agentMoving.current) {
      return;
    }
    agentMoving.current = true;

    const step = async () => {
      try {
        // Roll first if dice haven't been rolled yet.
        let state = game;
        if (!state.dice) {
          state = await apiFetch(`/games/${state.game_id}/roll`);
          setGame(state);
        }
        if (state.game_over) return;

        // Agent picks and applies its move.
        state = await apiFetch(`/games/${state.game_id}/agent-move`);
        setGame(state);
      } catch (e: unknown) {
        setError(String(e));
      } finally {
        agentMoving.current = false;
      }
    };

    // Small delay so the board flash is visible before the agent moves.
    const timer = setTimeout(step, 400);
    return () => clearTimeout(timer);
  }, [game]);

  // ── Human actions ──────────────────────────────────────────────────────

  const doRoll = async () => {
    if (!game) return;
    setLoading(true);
    setError(null);
    try {
      const state = await apiFetch(`/games/${game.game_id}/roll`);
      setGame(state);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const doMove = async () => {
    if (!game || !moveInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const state = await apiFetch(`/games/${game.game_id}/move`, {
        move: moveInput.trim(),
      });
      setGame(state);
      setMoveInput("");
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  if (!game && loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-zinc-500 dark:text-zinc-400">Starting game…</p>
      </div>
    );
  }

  if (!game && error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 dark:bg-black p-8">
        <p className="text-red-600 dark:text-red-400">
          Could not start game: {error}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Make sure the game server is running at{" "}
          <code className="font-mono">{API}</code>.
        </p>
        <Link
          href="/"
          className="text-sm text-indigo-600 underline dark:text-indigo-400"
        >
          ← Back to agents
        </Link>
      </div>
    );
  }

  if (!game) return null;

  const isHumanTurn = game.turn === 0;
  const isAgentTurn = game.turn === 1;
  const needsRoll = !game.dice;
  const needsMove = !!game.dice && isHumanTurn;

  const winnerLabel =
    game.winner === 0 ? "You win!" : game.winner === 1 ? "Agent wins." : "Draw";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
          Agent #{agentId} · {game.match_length}-pt match
        </span>
        <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
          {game.score[0]} – {game.score[1]}
        </span>
      </header>

      {/* Main */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {/* Game-over banner */}
        {game.game_over && (
          <div
            className={`rounded-lg border p-4 ${
              game.winner === 0
                ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20"
                : "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20"
            }`}
          >
            <p
              className={`text-lg font-bold ${
                game.winner === 0
                  ? "text-blue-700 dark:text-blue-300"
                  : "text-red-700 dark:text-red-300"
              }`}
            >
              {winnerLabel}
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Final score: {game.score[0]} – {game.score[1]}
            </p>
            {/* Phase 17 will wire this to the KeeperHub settlement workflow. */}
            <button
              disabled
              className="mt-3 cursor-not-allowed rounded-md bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
              title="Settlement wired in Phase 17"
            >
              Settle on-chain (coming Phase 17)
            </button>
          </div>
        )}

        {/* Board */}
        <Board
          board={game.board}
          bar={game.bar}
          off={game.off}
          turn={game.turn}
        />

        {/* Dice */}
        {game.dice && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Rolled:
            </span>
            <DiceRoll dice={game.dice} />
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </p>
        )}

        {/* Human controls — hidden when it's agent's turn or game over */}
        {!game.game_over && isHumanTurn && (
          <div className="flex flex-col gap-3">
            {needsRoll && (
              <button
                onClick={doRoll}
                disabled={loading}
                className="w-fit rounded-md bg-indigo-600 px-6 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? "Rolling…" : "Roll dice"}
              </button>
            )}
            {needsMove && (
              <div className="flex gap-2">
                <input
                  value={moveInput}
                  onChange={(e) => setMoveInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doMove()}
                  placeholder='e.g. "8/5 6/5" or "off"'
                  className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                />
                <button
                  onClick={doMove}
                  disabled={loading || !moveInput.trim()}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {loading ? "…" : "Move"}
                </button>
              </div>
            )}
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Notation: <code className="font-mono">from/to</code> per checker,
              space-separated. Bar: <code className="font-mono">bar/N</code>.
              Bear-off: <code className="font-mono">N/off</code>.
            </p>
          </div>
        )}

        {/* Agent thinking indicator */}
        {!game.game_over && isAgentTurn && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 animate-pulse">
            Agent is thinking…
          </p>
        )}
      </main>
    </div>
  );
}
