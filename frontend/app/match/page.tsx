// Phase 26: match flow over the AXL gnubg agent node.
//
// URL: /match?agentId=<N>
//
// State machine (browser-owned game state — no central server):
//   on mount         → POST /new {match_length} → opening MatchState
//                       → roll dice client-side for whichever side starts
//   if turn === 0    → render board + dice + move input, wait for human
//   human submits    → POST /apply {position_id, match_id, dice, move}
//                       on 200 → replace state, roll next side's dice
//                       on 422 → surface error, leave state unchanged
//   agent loop (turn === 1)
//                    → POST /move → best move
//                    → POST /apply with that move
//                    → replace state, roll next side's dice
//   forfeit          → POST /resign → game_over response
//
// After each move a non-blocking coach hint is requested:
//   → POST /evaluate (gnubg_service) → ranked candidates
//   → POST /hint    (coach_service)   → plain-English hint
// Coach calls are best-effort — any failure is silently swallowed so
// the game continues regardless of coach availability.
//
// Move notation is gnubg's standard: "8/5 6/5" (from-point/to-point,
// space-separated for multiple checker movements). See
// agent/gnubg_service.py or the agent test suite for examples.
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Board } from "../Board";
import { ConnectButton } from "../ConnectButton";
import { DiceRoll } from "../DiceRoll";
import { rollDice } from "../dice";

// ── Types matching agent/gnubg_state.py:MatchStateDict ────────────────────

interface MatchState {
  position_id: string;
  match_id: string;
  board: number[];
  bar: [number, number];
  off: [number, number];
  turn: 0 | 1;
  dice: [number, number] | null;
  score: [number, number];
  match_length: number;
  game_over: boolean;
  winner: 0 | 1 | null;
}

// ── API helpers ───────────────────────────────────────────────────────────

const GNUBG = process.env.NEXT_PUBLIC_GNUBG_URL ?? "http://localhost:8001";
const COACH = process.env.NEXT_PUBLIC_COACH_URL ?? "http://localhost:8002";

/**
 * POST helper for gnubg_service. All endpoints use POST with a JSON
 * body. 422 responses surface as Error with the `detail` string so
 * the page can render gnubg's complaint to the user.
 */
async function gnubgPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GNUBG}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // text wasn't JSON — keep raw.
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Request a coaching hint from coach_service (port 8002 / COACH env var).
 * Returns the hint string, or null on any failure. Non-blocking: callers
 * should fire-and-forget and update state only if still mounted.
 */
async function fetchHint(
  positionId: string,
  matchId: string,
  dice: [number, number],
  docsHash: string,
): Promise<string | null> {
  try {
    // Step 1: get ranked candidates from gnubg_service.
    const { candidates } = await gnubgPost<{ candidates: { move: string; equity: number }[] }>(
      "/evaluate",
      { position_id: positionId, match_id: matchId, dice },
    );
    if (!candidates || candidates.length === 0) return null;

    // Step 2: ask coach_service to narrate the top move.
    const res = await fetch(`${COACH}/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        position_id: positionId,
        match_id: matchId,
        dice,
        candidates,
        docs_hash: docsHash,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { hint?: string };
    return data.hint ?? null;
  } catch {
    // Coach offline or unreachable — game continues without hint.
    return null;
  }
}

/**
 * Roll dice for the side that's about to play and return a new
 * MatchState. Pure helper so the match-end branch (where we want the
 * dice to stay null) is a one-liner: skip this call.
 */
function withFreshDice(state: MatchState): MatchState {
  return { ...state, dice: rollDice() };
}

// ── Component ─────────────────────────────────────────────────────────────

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

  const [game, setGame] = useState<MatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  // Coach state — best-effort; failures leave hint null.
  const [coachHint, setCoachHint] = useState<string | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);

  // Docs hash for the coach RAG context (uploaded once to 0G Storage).
  const docsHash = process.env.NEXT_PUBLIC_GNUBG_DOCS_HASH ?? "";

  // Concurrency guard — prevents duplicate /move + /apply cascades when
  // React re-renders while an agent step is mid-flight.
  const agentMoving = useRef(false);

  // ── Coach hint after each move ─────────────────────────────────────────

  /**
   * Fire-and-forget coach hint request. Called with the state *after* a
   * move was applied so the hint reflects the new position. Silently
   * does nothing when the coach node isn't running.
   */
  const requestCoachHint = (state: MatchState) => {
    if (state.game_over || !state.dice) return;
    setCoachHint(null);
    setCoachLoading(true);
    fetchHint(state.position_id, state.match_id, state.dice, docsHash)
      .then((hint) => {
        setCoachHint(hint);
      })
      .finally(() => {
        setCoachLoading(false);
      });
  };

  // ── Start a new game on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    gnubgPost<MatchState>("/new", { match_length: 3 })
      .then((state) => {
        if (cancelled) return;
        const withDice = withFreshDice(state);
        setGame(withDice);
        requestCoachHint(withDice);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-drive the agent when it's their turn ──────────────────────────
  useEffect(() => {
    if (!game || game.game_over || game.turn !== 1 || agentMoving.current) {
      return;
    }
    if (!game.dice) return; // dice are seeded by withFreshDice on the previous step
    agentMoving.current = true;

    const step = async () => {
      try {
        const { move: best } = await gnubgPost<{ move: string | null }>(
          "/move",
          {
            position_id: game.position_id,
            match_id: game.match_id,
            dice: game.dice,
          },
        );
        if (!best) {
          // No legal moves — typically a bar dance. Not handled in v1;
          // surface the situation rather than silently looping.
          throw new Error("Agent has no legal move (bar dance) — not yet handled");
        }
        const next = await gnubgPost<MatchState>("/apply", {
          position_id: game.position_id,
          match_id: game.match_id,
          dice: game.dice,
          move: best,
        });
        const nextWithDice = next.game_over ? next : withFreshDice(next);
        setGame(nextWithDice);
        requestCoachHint(nextWithDice);
      } catch (e: unknown) {
        setError(String(e));
      } finally {
        agentMoving.current = false;
      }
    };

    // Small delay so the human sees the agent's dice land before its move.
    const timer = setTimeout(step, 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  // ── Human actions ──────────────────────────────────────────────────────

  const doMove = async () => {
    if (!game || !moveInput.trim() || !game.dice) return;
    setLoading(true);
    setError(null);
    try {
      const next = await gnubgPost<MatchState>("/apply", {
        position_id: game.position_id,
        match_id: game.match_id,
        dice: game.dice,
        move: moveInput.trim(),
      });
      const nextWithDice = next.game_over ? next : withFreshDice(next);
      setGame(nextWithDice);
      setMoveInput("");
      requestCoachHint(nextWithDice);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const doForfeit = async () => {
    if (!game || game.game_over) return;
    if (!window.confirm("Forfeit this match? You'll be marked as the loser.")) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await gnubgPost<MatchState>("/resign", {
        position_id: game.position_id,
        match_id: game.match_id,
      });
      setGame(next);
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
          Make sure the AXL gnubg agent node is running at{" "}
          <code className="font-mono">{GNUBG}</code>.
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
  const needsMove = !!game.dice && isHumanTurn;

  const winnerLabel =
    game.winner === 0 ? "You win!" : game.winner === 1 ? "Agent wins." : "Draw";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <div className="flex flex-1 items-center justify-center gap-4">
          <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
            Agent #{agentId} · {game.match_length}-pt match
          </span>
          <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
            {game.score[0]} – {game.score[1]}
          </span>
        </div>
        <ConnectButton />
      </header>

      {/* Main */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
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
            {/* Settle on-chain via settleWithSessionKeys — wired in sub-project C. */}
            <button
              disabled
              className="mt-3 cursor-not-allowed rounded-md bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
              title="Connect wallet to settle on-chain"
            >
              Settle on-chain (connect wallet)
            </button>
          </div>
        )}

        <Board
          board={game.board}
          bar={game.bar}
          off={game.off}
          turn={game.turn}
        />

        {game.dice && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Rolled:
            </span>
            <DiceRoll dice={game.dice} />
          </div>
        )}

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </p>
        )}

        {!game.game_over && isHumanTurn && needsMove && (
          <div className="flex flex-col gap-3">
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
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Notation: <code className="font-mono">from/to</code> per checker,
              space-separated. Bar: <code className="font-mono">bar/N</code>.
              Bear-off: <code className="font-mono">N/off</code>.
            </p>
          </div>
        )}

        {!game.game_over && isAgentTurn && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 animate-pulse">
            Agent is thinking…
          </p>
        )}

        {/* ── Coach panel ───────────────────────────────────────────────── */}
        {!game.game_over && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700/40 dark:bg-amber-900/10">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Coach
            </p>
            {coachLoading ? (
              <p className="text-sm text-amber-600 dark:text-amber-400 animate-pulse">
                Thinking…
              </p>
            ) : coachHint ? (
              <p className="text-sm text-amber-900 dark:text-amber-200">{coachHint}</p>
            ) : (
              <p className="text-sm text-amber-500 dark:text-amber-600">
                Start the coach node to get per-turn hints:{" "}
                <code className="font-mono text-xs">cd agent &amp;&amp; ./start.sh</code>
              </p>
            )}
          </div>
        )}

        {!game.game_over && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={doForfeit}
              disabled={loading}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700/60 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              Forfeit match
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
