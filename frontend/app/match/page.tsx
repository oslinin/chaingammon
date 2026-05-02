// Phase 26: match flow over the local gnubg agent process (HTTP on localhost:8001).
// Phase 31: drag-and-drop checker movement with optimistic board display and undo.
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
// Phase 31 additions:
//   stagedMoves      — array of "from/to" segments the human has clicked/dragged
//   displayBoardState — optimistic board/bar/off after applying staged moves locally;
//                       null when no moves staged (falls back to game.board)
//   stageMove        — appends a segment, applies it to displayBoardState, and
//                       auto-submits via doMoveWithNotation when all dice are used
//   Undo button      — clears staged moves and resets display to start-of-turn
//   Drag events      — onDragStart/onDrop forwarded to Board so users can drag
//                       checkers in addition to clicking source then destination
//   Text input + Move button still present for backward compatibility with tests
//   and power users who prefer notation.
//
// After each move a non-blocking coach hint is requested (skipped during
// fast-forward since the human is not choosing moves):
//   → POST /evaluate (gnubg_service) → ranked candidates
//   → POST /hint    (coach_service)   → plain-English hint
// Coach calls are best-effort — any failure is silently swallowed so
// the game continues regardless of coach availability.
//
// Move notation is gnubg's standard: "8/5 6/5" (from-point/to-point,
// space-separated for multiple checker movements). See
// agent/gnubg_service.py or the agent test suite for examples.
"use client";

import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useChainId, useWalletClient, usePublicClient, useWriteContract } from "wagmi";
import { encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { Board } from "../Board";
import { ConnectButton } from "../ConnectButton";
import { DiceRoll } from "../DiceRoll";
import { rollDice } from "../dice";
import { recordExpense } from "../expenses";
import { useActiveChain } from "../chains";
import { useComputeBackends } from "../ComputeBackendsContext";
import { MatchRegistryABI, useChainContracts } from "../contracts";

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
const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

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

// ── Phase 31: Optimistic board helper ────────────────────────────────────

/**
 * Apply one checker movement to board/bar/off and return the new state.
 * Player 0 (human) is always the mover. Handles blot hits (single
 * opponent checker at destination is sent to the bar).
 */
function applyMoveSegment(
  board: number[],
  bar: [number, number],
  off: [number, number],
  from: number | "bar",
  to: number | "off",
): { board: number[]; bar: [number, number]; off: [number, number] } {
  const newBoard = [...board];
  const newBar: [number, number] = [bar[0], bar[1]];
  const newOff: [number, number] = [off[0], off[1]];

  // Remove one checker from the source.
  if (from === "bar") {
    newBar[0] = Math.max(0, newBar[0] - 1);
  } else {
    newBoard[from - 1] -= 1;
  }

  // Place the checker at the destination (or bear it off).
  if (to === "off") {
    newOff[0] += 1;
  } else {
    // Hit a blot: if exactly one opponent checker is there, send it to the bar.
    if (newBoard[to - 1] === -1) {
      newBoard[to - 1] = 0;
      newBar[1] += 1;
    }
    newBoard[to - 1] += 1;
  }

  return { board: newBoard, bar: newBar, off: newOff };
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

// Default candidate pool for the team-mode teammate-recommendation chip.
// Read from `?candidates=2,3,4` if present; otherwise fall back to a small
// demo list. The requester (agentId) is filtered out before the call.
const DEFAULT_TEAMMATE_CANDIDATES = [1, 2, 3, 4, 5];

interface TeammateRec {
  best_teammate_id: number;
  equities: Record<string, number>;
  spread: number;
  requester_kind: "model" | "overlay" | "null";
  candidate_kinds: Record<string, "model" | "overlay" | "null">;
}

function MatchInner() {
  const params = useSearchParams();
  const agentId = Number(params.get("agentId") ?? "1");

  // Read team-mode + candidates from the URL. `?teamMode=1` enables the
  // teammate-recommendation chip; `?candidates=2,3,4` overrides the
  // default candidate pool. Both are optional — without `?teamMode=1`
  // the chip never renders so existing match flows are unaffected.
  const teamMode = params.get("teamMode") === "1";
  const candidatesParam = params.get("candidates");
  const teammateCandidates = candidatesParam
    ? candidatesParam.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    : DEFAULT_TEAMMATE_CANDIDATES;

  // Phase 28: persist the most-recently-played agentId so the sidebar can
  // link back to this agent on subsequent visits.
  useEffect(() => {
    window.localStorage.setItem("lastAgentId", String(agentId));
  }, [agentId]);

  // Career-mode teammate recommendation. Fires once on mount when team
  // mode is on; result feeds the read-only chip in the main column.
  // Failures are silent — the chip is a hint, not the page's reason
  // for existing.
  const [teammateRec, setTeammateRec] = useState<TeammateRec | null>(null);
  useEffect(() => {
    if (!teamMode) return;
    const filtered = teammateCandidates.filter((c) => c !== agentId);
    if (filtered.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${COACH}/agents/${agentId}/recommend-teammate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidates: filtered }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as TeammateRec;
        if (!cancelled) setTeammateRec(data);
      } catch {
        // Endpoint unreachable — keep teammateRec null so the chip
        // renders nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
    // teamMode + agentId change → page is effectively re-loaded; the
    // candidate list is derived once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamMode, agentId]);

  // Phase 36: write a stable UUID for this match session so the sidebar's
  // 0G Storage log / ENS / KeeperHub entries deep-link to the current match.
  // A new UUID is generated on each page load (= each new game session).
  // The archive URI (set after keeper settlement) is stored separately under
  // "currentMatchArchiveUri" and keyed by this UUID.
  useEffect(() => {
    // crypto.randomUUID exists only in secure contexts (HTTPS / localhost),
    // so it's undefined when the dev server is reached over plain-HTTP via
    // a LAN IP (e.g. 192.168.x.x:3000). Fall back to a non-cryptographic
    // unique-enough id — this only keys local match-session state.
    const matchSessionId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem("currentMatchId", matchSessionId);
    // Clear any archive URI from a previous match so the log page correctly
    // shows "in progress" until this match is settled.
    window.localStorage.removeItem("currentMatchArchiveUri");
  }, []);

  const [game, setGame] = useState<MatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  // Phase 27: click-to-move state.
  // null = no checker selected, 1-24 = board point, 25 = bar (player 0).
  const [selectedSource, setSelectedSource] = useState<number | null>(null);

  // Phase 31: staged moves and optimistic board display.
  // Each element is a "from/to" notation segment, e.g. "8/5" or "bar/24".
  const [stagedMoves, setStagedMoves] = useState<string[]>([]);
  // Optimistic board state while moves are staged; null = show game.board.
  const [displayBoardState, setDisplayBoardState] = useState<{
    board: number[];
    bar: [number, number];
    off: [number, number];
  } | null>(null);

  // Coach state — best-effort; failures leave hint null.
  const [coachHint, setCoachHint] = useState<string | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  // Which backend actually served the last hint. Distinct from the user's
  // pick because the server may fall back from "compute" to "local" when
  // 0G Compute is unreachable.
  const [coachServedBy, setCoachServedBy] = useState<CoachBackend | null>(null);

  // User's coach-backend pick. Default to the free local path so no 0G tokens
  // are charged without the user explicitly opting in. Persisted to
  // localStorage so a user who switches to "compute" stays on it across
  // page loads. SSR-safe: ComputeBackendsContext defers localStorage
  // reads behind a `hydrated` flag so the server-rendered HTML matches
  // the initial client render ("local").
  //
  // Phase I.4: derive coachBackend from the global ComputeBackendsContext
  // (the pill in layout.tsx) so flipping Coach in the pill updates this
  // page's coach calls — and vice versa via the per-match buttons below.
  // The context value is "local" | "0g"; the coach API's wire format is
  // "local" | "compute"; we adapt at the boundary.
  const { backends: computeBackends, setBackend: setComputeBackend } =
    useComputeBackends();
  const coachBackend: CoachBackend =
    computeBackends.coach === "0g" ? "compute" : "local";
  const setCoachBackend = (value: CoachBackend) => {
    setComputeBackend("coach", value === "compute" ? "0g" : "local");
  };

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

  // KeeperHub mode: game hasn't started yet (show "Start Game" card first).
  // Always true for agent matches — the card explains KeeperHub will auto-settle.
  const [gameStarted, setGameStarted] = useState(agentId === 0);

  // KeeperHub auto-finalize state. After game-end the frontend automatically
  // calls /finalize-direct then /keeper-workflow/{matchId}/run so settlement
  // is never gated on a manual "Settle on-chain" click.
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [keeperMatchId, setKeeperMatchId] = useState<number | null>(null);
  const [keeperRunning, setKeeperRunning] = useState(false);

  // ── Settlement via settleWithSessionKeys ──────────────────────────────────
  // Wallet hooks — used only when a wallet is connected.
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { matchRegistry } = useChainContracts();
  const { writeContractAsync } = useWriteContract();
  const activeChain = useActiveChain();
  const explorerUrl = activeChain?.chain.blockExplorers?.default?.url;

  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settleTxHash, setSettleTxHash] = useState<`0x${string}` | null>(null);

  // ── Phase 31: Derived board display state ─────────────────────────────

  // Current visual board — optimistic while moves are staged, otherwise
  // the authoritative server state.
  const currentBoard = displayBoardState?.board ?? game?.board ?? [];
  const currentBar = (displayBoardState?.bar ?? game?.bar ?? [0, 0]) as [number, number];
  const currentOff = (displayBoardState?.off ?? game?.off ?? [0, 0]) as [number, number];

  // How many move segments we expect before auto-submitting.
  // Doubles → 4 moves; any other roll → 2 moves.
  const diceCount = game?.dice
    ? game.dice[0] === game.dice[1] ? 4 : 2
    : 0;

  // ── Coach hint after each move ─────────────────────────────────────────

  /**
   * Fire-and-forget coach hint request. Called with the state *after* a
   * move was applied so the hint reflects the new position. Silently
   * does nothing when the coach node isn't running.
   */
  const requestCoachHint = (state: MatchState) => {
    if (fastForward) return; // human is not choosing moves — coach not needed
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
        // Record an expense entry whenever 0G Compute actually served the
        // hint (the server may fall back to local even when "compute" is
        // requested, so we key off the *served* backend, not the user's pick).
        if (result.backend === "compute") {
          recordExpense({
            type: "coach_hint",
            description: `Coach hint · Agent #${agentId} · Qwen 2.5 7B via 0G Compute`,
          });
        }
      })
      .finally(() => {
        setCoachLoading(false);
      });
  };

  // ── Start a new game ──────────────────────────────────────────────────
  // For agent matches, waits until the user clicks "Start Game" so KeeperHub
  // mode is clearly communicated before play begins. Human-vs-human starts
  // immediately (gameStarted initialises to true when agentId === 0).
  useEffect(() => {
    if (!gameStarted) return;
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
  }, [gameStarted]);

  // ── Auto-drive the agent when it's their turn (normal pace) ──────────────
  // In fast-forward mode this effect is bypassed entirely; the tight loop
  // below handles all turns without per-render delays or the 400 ms pause.
  useEffect(() => {
    if (fastForward) return;
    if (!game || game.game_over || agentMoving.current) return;
    if (game.turn !== 1) return;
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
          // No legal moves — typically a bar dance (checker on the bar,
          // opponent's home board closed). Pass the turn via gnubg
          // (board unchanged, match_id flipped to the other side) and
          // roll dice for the new side. requestCoachHint is skipped
          // because the side that lost the turn didn't actually choose
          // a move worth narrating.
          const skipped = await gnubgPost<MatchState>("/skip", {
            position_id: game.position_id,
            match_id: game.match_id,
            current_turn: game.turn,
          });
          const skippedWithDice = skipped.game_over
            ? skipped
            : withFreshDice(skipped);
          setGame(skippedWithDice);
          return;
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

  // ── Fast-forward (server-side) ────────────────────────────────────────────
  // Single round-trip: gnubg auto-plays both seats inside one subprocess at
  // 0-ply evaluation and returns the final match state. The previous client-
  // side per-turn loop spawned a fresh gnubg subprocess for every /move and
  // /apply (tens of seconds for a typical match); /play_to_end collapses
  // that to one call that completes in well under a second. Trade-off: dice
  // come from gnubg's PRNG instead of the browser's crypto.getRandomValues.
  // That's acceptable — fast-forward is a UX shortcut, not the rated path.
  useEffect(() => {
    if (!fastForward || !game || game.game_over) return;
    if (agentMoving.current) return;

    let cancelled = false;
    agentMoving.current = true;

    void (async () => {
      try {
        const final = await gnubgPost<MatchState>("/play_to_end", {
          position_id: game.position_id,
          match_id: game.match_id,
        });
        if (!cancelled) setGame(final);
      } catch (e: unknown) {
        if (!cancelled) setError(String(e));
      } finally {
        agentMoving.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fastForward]);

  // ── Auto-skip the human's turn when they have no legal moves ──────────────
  // Symmetric counterpart to the agent loop above. Runs only on the human's
  // turn outside fast-forward (fast-forward already routes through the agent
  // loop). Calls /evaluate to detect a bar dance; when the candidate list is
  // empty, /skip flips the turn and a fresh roll is seeded for the new side.
  useEffect(() => {
    if (!game || game.game_over) return;
    if (game.turn !== 0 || fastForward) return;
    if (!game.dice) return;
    if (agentMoving.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const { candidates } = await gnubgPost<{
          candidates: { move: string; equity: number }[];
        }>("/evaluate", {
          position_id: game.position_id,
          match_id: game.match_id,
          dice: game.dice,
        });
        if (cancelled || candidates.length > 0) return;
        const skipped = await gnubgPost<MatchState>("/skip", {
          position_id: game.position_id,
          match_id: game.match_id,
          current_turn: 0,
        });
        if (cancelled) return;
        const skippedWithDice = skipped.game_over
          ? skipped
          : withFreshDice(skipped);
        setGame(skippedWithDice);
      } catch {
        // gnubg offline — silently no-op so the human can still use /resign.
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, fastForward]);

  // ── Human actions ──────────────────────────────────────────────────────

  // Clear click selection and staged moves whenever it is no longer the human's turn.
  useEffect(() => {
    if (!game || game.turn !== 0) {
      setSelectedSource(null);
      setStagedMoves([]);
      setDisplayBoardState(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.turn]);

  /**
   * Submit a move notation string to /apply. Shared by the manual Move
   * button (text input) and the auto-submit path (click/drag staging).
   * Clears all staged state on success or error.
   */
  const doMoveWithNotation = async (notation: string) => {
    if (!game || !game.dice) return;
    setLoading(true);
    setError(null);
    setSelectedSource(null);
    try {
      const next = await gnubgPost<MatchState>("/apply", {
        position_id: game.position_id,
        match_id: game.match_id,
        dice: game.dice,
        move: notation,
      });
      const nextWithDice = next.game_over ? next : withFreshDice(next);
      setGame(nextWithDice);
      setStagedMoves([]);
      setDisplayBoardState(null);
      setMoveInput("");
      requestCoachHint(nextWithDice);
    } catch (e: unknown) {
      setError(String(e));
      // On error, reset optimistic state so the board snaps back.
      setStagedMoves([]);
      setDisplayBoardState(null);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Stage one checker movement (Phase 31 click/drag-to-move).
   *
   * Appends the segment to stagedMoves, applies it to displayBoardState
   * so the checker appears at its destination immediately, then
   * auto-submits when all dice have been used.
   */
  const stageMove = (from: number | "bar", to: number | "off") => {
    if (!game || !game.dice) return;

    const fromStr = from === "bar" ? "bar" : String(from);
    const toStr = to === "off" ? "off" : String(to);
    const seg = `${fromStr}/${toStr}`;
    const newStaged = [...stagedMoves, seg];

    // Apply the move locally for immediate visual feedback.
    const curBoard = displayBoardState?.board ?? game.board;
    const curBar = displayBoardState?.bar ?? game.bar;
    const curOff = displayBoardState?.off ?? game.off;
    const newDisplay = applyMoveSegment(curBoard, curBar, curOff, from, to);

    setStagedMoves(newStaged);
    setDisplayBoardState(newDisplay);
    setSelectedSource(null);

    // Auto-submit when all dice are consumed.
    if (newStaged.length >= diceCount) {
      void doMoveWithNotation(newStaged.join(" "));
    }
  };

  /**
   * Handle a click on a board point (Phase 27 click-to-move, extended in Phase 31).
   *
   * First click: selects the point as the move source (only valid if the point
   * has a player-0 checker and player-0 has no checkers on the bar).
   * Second click on the same point: deselects.
   * Second click on a different point: stages the move and updates the display
   * board optimistically.
   */
  const handlePointClick = (point: number) => {
    if (!game || !game.dice || game.turn !== 0) return;

    // Use the display board (post-staging) for source validation.
    const curBar = displayBoardState?.bar ?? game.bar;
    const curBoard = displayBoardState?.board ?? game.board;

    if (selectedSource === null) {
      // Player 0 must clear the bar before moving board checkers.
      if (curBar[0] > 0) return;
      if (curBoard[point - 1] > 0) setSelectedSource(point);
    } else if (selectedSource === point) {
      setSelectedSource(null); // deselect
    } else {
      const from: number | "bar" = selectedSource === 25 ? "bar" : selectedSource;
      stageMove(from, point);
    }
  };

  /** Click the bar zone to select it as the move source (enter from bar). */
  const handleBarClick = () => {
    if (!game || !game.dice || game.turn !== 0) return;
    const curBar = displayBoardState?.bar ?? game.bar;
    if (curBar[0] === 0) return;
    setSelectedSource(25);
  };

  /** Click the bear-off zone when a source is already selected. */
  const handleOffClick = () => {
    if (!game || !game.dice || game.turn !== 0 || selectedSource === null) return;
    const from: number | "bar" = selectedSource === 25 ? "bar" : selectedSource;
    stageMove(from, "off");
  };

  /** Phase 31: drag-start — select the dragged point as the move source. */
  const handleDragStart = (point: number) => {
    if (!game || !game.dice || game.turn !== 0) return;
    const curBar = displayBoardState?.bar ?? game.bar;
    const curBoard = displayBoardState?.board ?? game.board;
    if (curBar[0] > 0) return; // must enter from bar first
    if (curBoard[point - 1] > 0) setSelectedSource(point);
  };

  /** Phase 31: drop — stage the move from selectedSource to the dropped point. */
  const handleDrop = (point: number) => {
    if (selectedSource === null || !game || !game.dice || game.turn !== 0) return;
    const from: number | "bar" = selectedSource === 25 ? "bar" : selectedSource;
    stageMove(from, point);
  };

  /** Manual submit via the text input + Move button (backward compat). */
  const doMove = async () => {
    if (!game || !moveInput.trim() || !game.dice) return;
    await doMoveWithNotation(moveInput.trim());
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

  // ── Trustless on-chain settlement ─────────────────────────────────────────
  //
  // Flow (two MetaMask interactions, both initiated by the user):
  //   1. Generate an ephemeral session key (in-browser, no network).
  //   2. Read the human's current nonce from MatchRegistry.
  //   3. Human wallet signs "Chaingammon:open" auth (MetaMask popup #1).
  //   4. Session key signs "Chaingammon:result" instantly (no popup).
  //   5. Send settleWithSessionKeys tx (MetaMask popup #2 — the actual tx).
  //
  // On success the contract updates ELO for both the human and the agent.
  // gameRecordHash is left as bytes32(0) here; 0G Storage upload is a
  // follow-up task.
  const doSettle = async () => {
    if (!game?.game_over || !address || !walletClient || !publicClient) return;

    setSettleError(null);
    setSettling(true);

    try {
      // Step 1 — fresh session key (ephemeral, browser-only).
      const privKey = generatePrivateKey();
      const sessAccount = privateKeyToAccount(privKey);

      // Step 2 — read the human's current nonce from MatchRegistry.
      const nonce = await publicClient.readContract({
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "nonces",
        args: [address],
      }) as bigint;

      // Step 3 — human signs "Chaingammon:open" (MetaMask popup #1).
      // Encoding mirrors the contract's abi.encode call exactly:
      //   keccak256(abi.encode("Chaingammon:open", chainid, address(this),
      //                        human, nonce, agentId, matchLength, sessionKey))
      const humanWins = game.winner === 0;
      const gameRecordHash = `0x${"00".repeat(32)}` as `0x${string}`;

      const authInner = keccak256(
        encodeAbiParameters(
          [
            { type: "string" },
            { type: "uint256" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint16" },
            { type: "address" },
          ],
          [
            "Chaingammon:open",
            BigInt(chainId),
            matchRegistry,
            address,
            nonce,
            BigInt(agentId),
            game.match_length,
            sessAccount.address,
          ],
        ),
      );
      // signMessage with { raw } applies EIP-191 personal_sign prefix,
      // matching MessageHashUtils.toEthSignedMessageHash in the contract.
      const humanAuthSig = await walletClient.signMessage({
        message: { raw: authInner },
      });

      // Step 4 — session key signs "Chaingammon:result" (instant, no popup).
      const resultInner = keccak256(
        encodeAbiParameters(
          [
            { type: "string" },
            { type: "uint256" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
            { type: "bytes32" },
          ],
          [
            "Chaingammon:result",
            BigInt(chainId),
            matchRegistry,
            address,
            nonce,
            BigInt(agentId),
            humanWins,
            gameRecordHash,
          ],
        ),
      );
      const resultSig = await sessAccount.signMessage({
        message: { raw: resultInner },
      });

      // Step 5 — submit the settlement tx (MetaMask popup #2).
      const txHash = await writeContractAsync({
        address: matchRegistry,
        abi: MatchRegistryABI,
        functionName: "settleWithSessionKeys",
        args: [
          address,
          BigInt(agentId),
          game.match_length,
          humanWins,
          gameRecordHash,
          nonce,
          sessAccount.address,
          humanAuthSig,
          resultSig,
        ],
      });
      setSettleTxHash(txHash);
      recordExpense({
        type: "game_settlement",
        description: `Match settled on-chain · Agent #${agentId} · tx ${txHash.slice(0, 10)}…`,
      });
    } catch (e: unknown) {
      setSettleError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettling(false);
    }
  };

  // ── KeeperHub auto-finalize + workflow trigger ────────────────────────────
  // Called automatically when the game ends (agent mode). Uploads the game
  // record to 0G Storage, commits recordMatch on-chain, then kicks off the
  // 9-step audit workflow. No wallet interaction required — the server's
  // deployer key signs the recordMatch tx.
  const doFinalizeAndTriggerKeeper = async () => {
    if (!game?.game_over || finalizing || keeperMatchId !== null) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const humanWins = game.winner === 0;
      const ZERO = "0x0000000000000000000000000000000000000000";
      const res = await fetch(`${SERVER}/finalize-direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winner_agent_id: humanWins ? 0 : agentId,
          winner_human_address: humanWins && address ? address : ZERO,
          loser_agent_id: humanWins ? agentId : 0,
          loser_human_address: !humanWins && address ? address : ZERO,
          match_length: game.match_length,
          position_id: game.position_id,
          gnubg_match_id: game.match_id,
          score: game.score,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        let detail = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed?.detail) detail = String(parsed.detail);
        } catch { /* keep raw */ }
        throw new Error(detail);
      }
      const data = (await res.json()) as { match_id: number };
      const mid = data.match_id;
      setKeeperMatchId(mid);
      // Trigger the audit workflow in the background.
      setKeeperRunning(true);
      fetch(`${SERVER}/keeper-workflow/${mid}/run`, { method: "POST" }).finally(() => {
        setKeeperRunning(false);
      });
    } catch (e: unknown) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinalizing(false);
    }
  };

  // Auto-trigger finalize when the game ends (agent mode only).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (game?.game_over && agentId > 0) {
      void doFinalizeAndTriggerKeeper();
    }
  // Intentional: only re-run when game_over transitions to true.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.game_over]);

  // ── Render ─────────────────────────────────────────────────────────────

  // Pre-game "Start Game" card for agent matches. KeeperHub mode is always
  // active when playing against an agent — this card makes that visible before
  // the first move so the user understands settlement is automatic.
  if (!gameStarted && agentId > 0) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
        <header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Agents
          </Link>
          <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">Agent #{agentId}</span>
          <ConnectButton />
        </header>
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
          <div className="w-full rounded-xl border border-emerald-200 bg-emerald-50 p-6 dark:border-emerald-700/40 dark:bg-emerald-900/10">
            <h2 className="mb-2 text-lg font-semibold text-emerald-900 dark:text-emerald-200">
              KeeperHub mode
            </h2>
            <p className="text-sm leading-6 text-emerald-800 dark:text-emerald-300">
              When you click <strong>Start Game</strong>, KeeperHub takes over settlement.
              Your result is recorded on 0G Chain and your ELO is updated automatically —
              even if you close the tab before the game ends.
            </p>
            <ul className="mt-3 space-y-1 text-xs text-emerald-700 dark:text-emerald-400">
              <li>✓ drand dice — publicly verifiable randomness each turn</li>
              <li>✓ gnubg move validation — every move audited on-chain</li>
              <li>✓ automatic ELO settlement — no manual "Settle on-chain" click</li>
            </ul>
          </div>
          <button
            type="button"
            onClick={() => setGameStarted(true)}
            className="w-full rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            Start Game vs Agent #{agentId}
          </button>
        </main>
      </div>
    );
  }

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
          Make sure the local gnubg agent process is running at{" "}
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

  // Show the Undo button whenever there is something to undo.
  const canUndo = stagedMoves.length > 0 || moveInput.trim() !== "" || selectedSource !== null;

  // Show Apply button when moves are staged but not all dice are used (player
  // can't use remaining dice — let them submit a partial move for gnubg to validate).
  const canApplyPartial = stagedMoves.length > 0 && diceCount > 0 && stagedMoves.length < diceCount;

  const winnerLabel =
    game.winner === 0 ? "You win!" : game.winner === 1 ? "Agent wins." : "Draw";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 sm:gap-4 sm:px-8 sm:py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="shrink-0 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 sm:gap-4">
          <span className="truncate font-mono text-xs text-zinc-500 sm:text-sm dark:text-zinc-400">
            Agent #{agentId} · {game.match_length}-pt match
          </span>
          <span className="shrink-0 font-mono text-xs text-zinc-900 sm:text-sm dark:text-zinc-50">
            {game.score[0]} – {game.score[1]}
          </span>
        </div>
        <ConnectButton />
      </header>

      {/* Main */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-3 py-6 sm:px-8 sm:py-8">
        {/* Phase F: inference-backend chip. Mirrors the global Compute
            pill so the user can see at a glance which backend the
            agent's per-move equity calls run on. Currently decorative
            — /agent-move uses gnubg, not the per-agent NN. Phase G
            wires the flag through to og_compute_eval_client.evaluate. */}
        <InferenceChip />

        {/* Career-mode teammate-preference chip. Renders only when the
            page is loaded with ?teamMode=1 AND the endpoint returned
            a recommendation. Read-only — clicking does nothing in this
            phase; swap-to-teammate is a follow-up. */}
        {teamMode && teammateRec && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/10 dark:text-emerald-200">
            <span className="mr-2" aria-hidden>🤝</span>
            <span className="font-medium">
              Agent prefers teammate #{teammateRec.best_teammate_id}
            </span>
            <span className="ml-2 font-mono text-xs text-emerald-700 dark:text-emerald-400">
              (+{teammateRec.spread.toFixed(3)} eq · vs {Object.keys(teammateRec.equities).length - 1} other{Object.keys(teammateRec.equities).length === 2 ? "" : "s"})
            </span>
            {teammateRec.requester_kind === "overlay" && (
              <span className="ml-2 italic text-xs text-emerald-700/80 dark:text-emerald-400/80">
                (based on style only — agent not yet trained)
              </span>
            )}
          </div>
        )}
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
            {/* KeeperHub auto-settle for agent matches — no manual button needed */}
            {agentId > 0 ? (
              keeperMatchId !== null ? (
                <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 dark:bg-emerald-900/20">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    KeeperHub settled — ELO updated!
                  </p>
                  <Link
                    href={`/keeper/${keeperMatchId}`}
                    className="mt-1 block text-xs text-indigo-600 underline dark:text-indigo-400"
                  >
                    View KeeperHub audit trail ↗
                  </Link>
                  {keeperRunning && (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Workflow running…
                    </p>
                  )}
                </div>
              ) : finalizing ? (
                <p className="mt-3 animate-pulse text-sm text-zinc-500 dark:text-zinc-400">
                  KeeperHub settling…
                </p>
              ) : finalizeError ? (
                <div className="mt-3">
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Auto-settle failed: {finalizeError}
                  </p>
                  <button
                    type="button"
                    onClick={() => void doFinalizeAndTriggerKeeper()}
                    className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    Retry
                  </button>
                </div>
              ) : null
            ) : (
              /* Human-vs-human: keep the manual settle path */
              isConnected ? (
                settleTxHash ? (
                  <div className="mt-3">
                    <p className="text-sm font-semibold text-green-700 dark:text-green-400">
                      Settled on-chain — ELO updated!
                    </p>
                    {explorerUrl && (
                      <a
                        href={`${explorerUrl}/tx/${settleTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 block text-xs text-indigo-600 underline dark:text-indigo-400"
                      >
                        View transaction ↗
                      </a>
                    )}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void doSettle()}
                      disabled={settling}
                      className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                      title="Record result and update ELO on-chain (2 wallet interactions)"
                    >
                      {settling ? "Settling…" : "Settle on-chain"}
                    </button>
                    {settleError && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-400">{settleError}</p>
                    )}
                  </>
                )
              ) : (
                <button
                  disabled
                  className="mt-3 cursor-not-allowed rounded-md bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
                  title="Connect wallet to settle on-chain"
                >
                  Settle on-chain (connect wallet)
                </button>
              )
            )}
          </div>
        )}

        {/* Board renders the optimistic display state during staging, otherwise game.board */}
        <Board
          board={currentBoard}
          bar={currentBar}
          off={currentOff}
          turn={game.turn}
          onPointClick={needsMove ? handlePointClick : undefined}
          onBarClick={needsMove ? handleBarClick : undefined}
          onOffClick={needsMove && selectedSource !== null ? handleOffClick : undefined}
          selectedPoint={selectedSource}
          onDragStart={needsMove ? handleDragStart : undefined}
          onDrop={needsMove ? handleDrop : undefined}
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
            {/* Instruction */}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Drag or click</span>{" "}
              a blue checker to select it (amber highlight), then drag or click a destination point.
              The checker moves immediately — after using all dice the move is submitted automatically.
              Use the{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Bear off →</span>{" "}
              button to bear off. Or type the notation directly below.
            </p>

            {/* Staged-move status */}
            {stagedMoves.length > 0 && (
              <p className="text-xs text-indigo-600 dark:text-indigo-400">
                {stagedMoves.length}/{diceCount} move{stagedMoves.length !== 1 ? "s" : ""} staged
                {stagedMoves.length < diceCount && " — click the next checker to continue"}
              </p>
            )}

            <div className="flex gap-2">
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doMove()}
                placeholder='e.g. "8/5 6/5" or "off"'
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
              {/* Undo clears staged moves, the text input, and any click selection */}
              {canUndo && (
                <button
                  type="button"
                  onClick={() => {
                    setStagedMoves([]);
                    setDisplayBoardState(null);
                    setMoveInput("");
                    setSelectedSource(null);
                  }}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Undo
                </button>
              )}
              {/* Apply button lets player submit with fewer moves than diceCount
                  when some dice cannot legally be used. */}
              {canApplyPartial && (
                <button
                  type="button"
                  onClick={() => void doMoveWithNotation(stagedMoves.join(" "))}
                  disabled={loading}
                  className="rounded-md border border-indigo-300 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
                >
                  Apply ({stagedMoves.length}/{diceCount})
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
        {!game.game_over && !fastForward && (
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

// Phase I.3: chip mirroring the global Compute pill's inference
// backend. When 0G is on, fetches a one-shot probe from
// /training/estimate so the chip can render real provider state +
// per-inference cost when a backgammon-net provider is registered.
// When local, the chip is a static label.
//
// The match flow today goes through gnubg_service (port 8001) which
// doesn't know about 0G; per-move billing through /agent-move is
// part of Phase J's per-agent-NN cutover. For now the chip surfaces
// the standing 0G availability + cost so judges can see the matrix
// is wired, even though each in-flight move doesn't tick the meter.
function InferenceChip() {
  const { backends, hydrated } = useComputeBackends();
  const is0G = hydrated && backends.inference === "0g";

  // One-shot probe via /training/estimate (epochs=1, agent_ids=1,2 ->
  // per_inference_og + available). Cheap; backed by React Query so
  // re-renders don't re-fetch.
  const probe = useQuery({
    enabled: is0G,
    queryKey: ["inference-probe"],
    staleTime: 60_000,
    queryFn: async () => {
      const url = new URL(`${COACH}/training/estimate`);
      url.searchParams.set("epochs", "1");
      url.searchParams.set("agent_ids", "1,2");
      url.searchParams.set("use_0g_inference", "true");
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as {
        available: boolean;
        per_inference_og: number;
        gas_og: number;
        note?: string;
      };
    },
  });

  if (!hydrated) return null;

  let label: string;
  let title: string;
  let className: string;
  if (!is0G) {
    label = "Inference: local";
    title = "Agent inference runs locally";
    className =
      "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400";
  } else if (probe.isLoading) {
    label = "Inference: 0G (probing…)";
    title = "Checking the 0G eval bridge for a backgammon-net provider";
    className =
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300";
  } else if (probe.error || !probe.data?.available) {
    const note = probe.data?.note ?? "provider unavailable";
    label = "Inference: 0G · provider unavailable";
    title = `0G eval bridge: ${note}. Local inference will be used during play.`;
    className =
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300";
  } else {
    const cost = probe.data.per_inference_og.toFixed(6);
    label = `Inference: 0G · ~${cost} OG/move`;
    title = `0G compute provider live; per-move cost ≈ ${cost} OG`;
    className =
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300";
  }

  return (
    <div
      className={[
        "self-start rounded-md border px-2 py-1 text-xs font-mono",
        className,
      ].join(" ")}
      title={title}
    >
      {label}
    </div>
  );
}
