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

// Coach backend choices the user can pick in the toggle. "compute" is the
// paid 0G Compute path (Qwen 2.5 7B Instruct via @0glabs/0g-serving-broker);
// "local" is the free flan-t5-base running inside coach_service. The server
// also accepts "compute-only" but we don't expose that to the UI — the
// frontend always wants graceful degradation.
type CoachBackend = "compute" | "local";

interface HintResult {
  hint: string;
  // What actually served the request. May differ from the user's pick when
  // the server falls back from "compute" → "local" because 0G Compute is
  // unreachable. The UI surfaces this so the choice isn't silently ignored.
  backend: CoachBackend;
}

/**
 * Request a coaching hint from coach_service (port 8002 / COACH env var).
 * Returns the hint + which backend served it, or null on any failure.
 * Non-blocking: callers should fire-and-forget and update state only if
 * still mounted.
 */
async function fetchHint(
  positionId: string,
  matchId: string,
  dice: [number, number],
  docsHash: string,
  backend: CoachBackend,
): Promise<HintResult | null> {
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
        backend,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { hint?: string; backend?: string };
    if (!data.hint) return null;
    const served: CoachBackend = data.backend === "compute" ? "compute" : "local";
    return { hint: data.hint, backend: served };
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

  // Phase 28: persist the most-recently-played agentId so the sidebar can
  // link back to this agent on subsequent visits.
  useEffect(() => {
    window.localStorage.setItem("lastAgentId", String(agentId));
  }, [agentId]);

  const [game, setGame] = useState<MatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  // Phase 27: click-to-move state.
  // null = no checker selected, 1-24 = board point, 25 = bar (player 0).
  const [selectedSource, setSelectedSource] = useState<number | null>(null);

  // Coach state — best-effort; failures leave hint null.
  const [coachHint, setCoachHint] = useState<string | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  // Which backend actually served the last hint. Distinct from the user's
  // pick because the server may fall back from "compute" to "local" when
  // 0G Compute is unreachable.
  const [coachServedBy, setCoachServedBy] = useState<CoachBackend | null>(null);

  // User's coach-backend pick. Default to the paid 0G Compute path so the
  // sponsor-aligned demo runs without explicit toggling, with localStorage
  // persistence so a user who picks "free" doesn't get billed on reload.
  // SSR-safe: `useEffect` reads localStorage after mount; before then the
  // server-rendered HTML matches the initial client render ("compute").
  const [coachBackend, setCoachBackend] = useState<CoachBackend>("compute");
  useEffect(() => {
    const saved = window.localStorage.getItem("coachBackend");
    if (saved === "local" || saved === "compute") setCoachBackend(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("coachBackend", coachBackend);
  }, [coachBackend]);

  // Always carry the latest pick into fire-and-forget callbacks without
  // re-creating closures (which would force every move handler to depend
  // on `coachBackend` and re-render).
  const coachBackendRef = useRef<CoachBackend>(coachBackend);
  useEffect(() => {
    coachBackendRef.current = coachBackend;
  }, [coachBackend]);

  // Docs hash for the coach RAG context (uploaded once to 0G Storage).
  const docsHash = process.env.NEXT_PUBLIC_GNUBG_DOCS_HASH ?? "";

  // Concurrency guard — prevents duplicate /move + /apply cascades when
  // React re-renders while an agent step is mid-flight.
  const agentMoving = useRef(false);

  // Whether the human has handed off to the gnubg agent to finish the game.
  const [fastForward, setFastForward] = useState(false);

  // ── Coach hint after each move ─────────────────────────────────────────

  /**
   * Fire-and-forget coach hint request. Called with the state *after* a
   * move was applied so the hint reflects the new position. Silently
   * does nothing when the coach node isn't running.
   */
  const requestCoachHint = (state: MatchState) => {
    if (state.game_over || !state.dice) return;
    setCoachHint(null);
    setCoachServedBy(null);
    setCoachLoading(true);
    fetchHint(
      state.position_id,
      state.match_id,
      state.dice,
      docsHash,
      coachBackendRef.current,
    )
      .then((result) => {
        if (!result) return;
        setCoachHint(result.hint);
        setCoachServedBy(result.backend);
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

  // ── Auto-drive the agent when it's their turn OR fast-forward is active ──
  useEffect(() => {
    // Fire when it's the agent's turn (turn === 1), or when the human has
    // activated fast-forward and it's still their turn (turn === 0). In fast-
    // forward mode the gnubg agent plays both sides until game_over.
    if (!game || game.game_over || agentMoving.current) return;
    if (game.turn !== 1 && !fastForward) return;
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
  }, [game, fastForward]);

  // ── Human actions ──────────────────────────────────────────────────────

  // Clear click selection whenever it is no longer the human's turn.
  useEffect(() => {
    if (!game || game.turn !== 0) setSelectedSource(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.turn]);

  /**
   * Handle a click on a board point (Phase 27 click-to-move).
   *
   * First click: selects the point as the move source (only valid if the point
   * has a player-0 checker and player-0 has no checkers on the bar).
   * Second click on the same point: deselects.
   * Second click on a different point: appends "from/to" to the move input and
   * clears the selection so the user can start the next checker move.
   */
  const handlePointClick = (point: number) => {
    // needsMove = !!game.dice && game.turn === 0
    if (!game || !game.dice || game.turn !== 0) return;

    if (selectedSource === null) {
      // Player 0 must clear the bar before moving board checkers.
      if (game.bar[0] > 0) return;
      if (game.board[point - 1] > 0) setSelectedSource(point);
    } else if (selectedSource === point) {
      setSelectedSource(null); // deselect
    } else {
      const from = selectedSource === 25 ? "bar" : String(selectedSource);
      const seg = `${from}/${point}`;
      setMoveInput((prev) => (prev.trim() ? `${prev.trim()} ${seg}` : seg));
      setSelectedSource(null);
    }
  };

  /** Click the bar zone to select it as the move source (enter from bar). */
  const handleBarClick = () => {
    if (!game || !game.dice || game.turn !== 0 || game.bar[0] === 0) return;
    setSelectedSource(25);
  };

  /** Click the bear-off zone when a source is already selected. */
  const handleOffClick = () => {
    if (!game || !game.dice || game.turn !== 0 || selectedSource === null) return;
    const from = selectedSource === 25 ? "bar" : String(selectedSource);
    const seg = `${from}/off`;
    setMoveInput((prev) => (prev.trim() ? `${prev.trim()} ${seg}` : seg));
    setSelectedSource(null);
  };

  const doMove = async () => {
    if (!game || !moveInput.trim() || !game.dice) return;
    setLoading(true);
    setError(null);
    setSelectedSource(null);
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
          onPointClick={needsMove ? handlePointClick : undefined}
          onBarClick={needsMove ? handleBarClick : undefined}
          onOffClick={needsMove && selectedSource !== null ? handleOffClick : undefined}
          selectedPoint={selectedSource}
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

        {!game.game_over && isHumanTurn && needsMove && !fastForward && (
          <div className="flex flex-col gap-3">
            {/* Click-to-move instruction */}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Click</span>{" "}
              a blue checker to select it (amber highlight), then click a destination
              point. Repeat for each checker. Use the{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Bear off →</span>{" "}
              button when bearing off. Or type the notation directly below.
            </p>
            <div className="flex gap-2">
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doMove()}
                placeholder='e.g. "8/5 6/5" or "off"'
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
              {/* Reset clears both the typed/built notation and any click selection */}
              {(moveInput.trim() || selectedSource !== null) && (
                <button
                  type="button"
                  onClick={() => {
                    setMoveInput("");
                    setSelectedSource(null);
                  }}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Reset
                </button>
              )}
              <button
                onClick={doMove}
                disabled={loading || !moveInput.trim()}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? "…" : "Move"}
              </button>
            </div>
          </div>
        )}

        {!game.game_over && (isAgentTurn || fastForward) && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 animate-pulse">
            {fastForward ? "Fast forwarding…" : "Agent is thinking…"}
          </p>
        )}

        {/* ── Coach panel ───────────────────────────────────────────────── */}
        {!game.game_over && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700/40 dark:bg-amber-900/10">
            <div className="mb-1 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Coach
              </p>
              <div
                className="inline-flex overflow-hidden rounded-md border border-amber-300 text-[11px] font-medium dark:border-amber-700/60"
                role="group"
                aria-label="Coach backend"
              >
                <button
                  type="button"
                  aria-pressed={coachBackend === "compute"}
                  onClick={() => setCoachBackend("compute")}
                  className={
                    coachBackend === "compute"
                      ? "bg-amber-600 px-2 py-0.5 text-white"
                      : "bg-transparent px-2 py-0.5 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
                  }
                  title="0G Compute · Qwen 2.5 7B (paid, verifiable inference)"
                >
                  Paid · 0G
                </button>
                <button
                  type="button"
                  aria-pressed={coachBackend === "local"}
                  onClick={() => setCoachBackend("local")}
                  className={
                    coachBackend === "local"
                      ? "bg-amber-600 px-2 py-0.5 text-white"
                      : "bg-transparent px-2 py-0.5 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
                  }
                  title="Local flan-t5-base (free, runs in coach_service)"
                >
                  Free · Local
                </button>
              </div>
            </div>
            {coachLoading ? (
              <p className="text-sm text-amber-600 dark:text-amber-400 animate-pulse">
                Thinking…
              </p>
            ) : coachHint ? (
              <>
                <p className="text-sm text-amber-900 dark:text-amber-200">{coachHint}</p>
                {coachServedBy && (
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-amber-600/80 dark:text-amber-400/70">
                    Served by{" "}
                    {coachServedBy === "compute"
                      ? "0G Compute · Qwen 2.5 7B"
                      : "local flan-t5-base"}
                    {coachBackend === "compute" && coachServedBy === "local" && (
                      <span> (0G Compute unreachable — fell back)</span>
                    )}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-amber-500 dark:text-amber-600">
                Start the coach node to get per-turn hints:{" "}
                <code className="font-mono text-xs">cd agent &amp;&amp; ./start.sh</code>
              </p>
            )}
          </div>
        )}

        {!game.game_over && (
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFastForward(true)}
              disabled={loading || fastForward}
              className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {fastForward ? "Fast forwarding…" : "⏩ Fast forward"}
            </button>
            <button
              type="button"
              onClick={doForfeit}
              disabled={loading || fastForward}
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
