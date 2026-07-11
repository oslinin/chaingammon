// app/play-agent/page.tsx — play vs an agent's model, locally (Task 7
// Step 4's app-side bullet: "'play vs agent' loads the decrypted ONNX into
// the copied onnx_eval worker (owner-side only in v1)").
//
// "Owner-side only" means: this page never talks to Seal/Walrus itself —
// the OWNER runs sui/scripts/fetch_weights.ts (which is where the on-chain
// seal_approve ownership check actually gates decryption), gets a plain
// .onnx file out, and loads it here via the file picker. A non-owner never
// gets that file in the first place, so this page needs no chain access at
// all. Without a loaded file it plays the bundled base model — same
// weights as the unrated auto-play — so the page is fully usable (and
// E2E-testable in CI) with zero network dependencies.
//
// Everything is local: no matchmaking, no WebRTC, no stakes. Dice are
// plain local randomness (same idiom as match_engine's playMatchToEnd) —
// fine for casual play against your own agent; rated play's trustless
// on-chain dice live in /play-rated.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Board } from "../Board";
import { DiceRoll } from "../DiceRoll";
import { loadTheme, pickGameCoins } from "../boardThemes";
import { evaluateMoves, loadAgentModel, warmupOnnx } from "../../lib/onnx_eval";
import {
  type MatchState,
  newMatch,
  applyMoveToState,
  skipTurn,
  getBestMove,
} from "../../lib/match_engine";
import { type Board as GameBoard, generateLegalMoves, hasLegalMoves } from "../../lib/rules_engine";

const MATCH_LENGTH = 1;
const HUMAN: 0 | 1 = 0;
const AGENT: 0 | 1 = 1;

function rollDie(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function toGameBoard(s: MatchState): GameBoard {
  return { points: s.board, bar: s.bar, off: s.off };
}

export default function PlayAgentPage() {
  const testMode =
    typeof window !== "undefined" &&
    !!(window as Window & { __HVH_TEST_MODE?: boolean }).__HVH_TEST_MODE;

  const matchLength =
    (testMode &&
      Number((window as Window & { __HVH_MATCH_LENGTH?: number }).__HVH_MATCH_LENGTH)) ||
    MATCH_LENGTH;

  const [game, setGame] = useState<MatchState | null>(null);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [stagedMoves, setStagedMoves] = useState<string[]>([]);
  const [agentThinking, setAgentThinking] = useState(false);
  const [modelNote, setModelNote] = useState<string>("bundled base model");
  const [modelError, setModelError] = useState<string | null>(null);

  const [gameCoins] = useState(() => pickGameCoins());
  const themeKey = loadTheme();

  const gameRef = useRef<MatchState | null>(null);
  // Guards the async agent-turn driver against double entry (React strict
  // mode re-runs effects; a slow ONNX eval must not overlap the next one).
  const drivingRef = useRef(false);

  const setBoth = useCallback((s: MatchState) => {
    gameRef.current = s;
    setGame(s);
  }, []);

  // ── Turn driver: roll for whoever's turn it is; play agent turns and
  // auto-skips until the game is over or it's the human's move. ───────────
  const driveToHumanTurn = useCallback(async () => {
    if (drivingRef.current) return;
    drivingRef.current = true;
    try {
      let s = gameRef.current;
      while (s && !s.game_over) {
        if (!s.dice) {
          s = { ...s, dice: [rollDie(), rollDie()] };
          setBoth(s);
        }
        const dice = s.dice as [number, number];
        if (!hasLegalMoves(toGameBoard(s), s.turn, dice)) {
          s = skipTurn(s);
          setBoth(s);
          continue;
        }
        if (s.turn === HUMAN) break; // wait for clicks
        setAgentThinking(true);
        const move = await getBestMove(toGameBoard(s), AGENT, dice);
        setAgentThinking(false);
        s = move === null ? skipTurn(s) : applyMoveToState(s, move);
        setBoth(s);
      }
    } finally {
      drivingRef.current = false;
      setAgentThinking(false);
    }
  }, [setBoth]);
  const driveRef = useRef(driveToHumanTurn);
  useEffect(() => { driveRef.current = driveToHumanTurn; }, [driveToHumanTurn]);

  // ── Mount: warm the base model, start the match. ────────────────────────
  useEffect(() => {
    warmupOnnx();
    setBoth(newMatch(matchLength));
    void driveRef.current();
  }, [matchLength, setBoth]);

  // ── Load a decrypted agent .onnx (fetch_weights.ts output). ────────────
  const onModelFile = useCallback(async (file: File) => {
    setModelError(null);
    try {
      const bytes = await file.arrayBuffer();
      await loadAgentModel(bytes); // transfers the buffer to the worker
      setModelNote(`agent model: ${file.name}`);
    } catch (e) {
      setModelError(`Failed to load model: ${e instanceof Error ? e.message : String(e)}`);
      setModelNote("bundled base model");
    }
  }, []);

  // ── Human move staging (same click flow as /play, minus the wire). ─────
  const diceCount = game?.dice ? (game.dice[0] === game.dice[1] ? 4 : 2) : 0;

  const commitMove = useCallback((notation: string, currentGame: MatchState) => {
    try {
      const next = applyMoveToState(currentGame, notation);
      setBoth(next);
      setSelectedSource(null);
      setStagedMoves([]);
      if (!next.game_over) void driveRef.current();
    } catch {
      setSelectedSource(null);
      setStagedMoves([]);
    }
  }, [setBoth]);

  const stageMove = useCallback(
    (from: number | "bar", to: number | "off") => {
      if (!game?.dice || game.turn !== HUMAN) return;
      const fromStr = from === "bar" ? "bar" : String(from);
      const toStr = to === "off" ? "off" : String(to);
      const dstCount = typeof to === "number" ? game.board[to - 1] : 0;
      const isHit = typeof to === "number" && dstCount === -1; // human is side 0
      const seg = `${fromStr}/${toStr}${isHit ? "*" : ""}`;
      const newStaged = [...stagedMoves, seg];
      setStagedMoves(newStaged);
      setSelectedSource(null);
      if (newStaged.length >= diceCount) {
        commitMove(newStaged.join(" "), game);
      }
    },
    [game, stagedMoves, diceCount, commitMove],
  );

  const handlePointClick = useCallback(
    (point: number) => {
      if (!game?.dice || game.game_over || game.turn !== HUMAN || agentThinking) return;
      if (selectedSource === null) {
        if (game.bar[HUMAN] > 0) return;
        const checker = game.board[point - 1];
        if (checker <= 0) return; // side 0 owns positive counts
        setSelectedSource(point);
      } else {
        stageMove(selectedSource, point);
        setSelectedSource(null);
      }
    },
    [game, selectedSource, stageMove, agentThinking],
  );

  const handleBarClick = useCallback(() => {
    if (!game?.dice || game.game_over || game.turn !== HUMAN || agentThinking) return;
    if (game.bar[HUMAN] > 0) setSelectedSource(25);
  }, [game, agentThinking]);

  const handleOffClick = useCallback(() => {
    if (!game?.dice || game.game_over || game.turn !== HUMAN || agentThinking) return;
    if (selectedSource !== null && selectedSource !== 25) {
      stageMove(selectedSource, "off");
      setSelectedSource(null);
    }
  }, [game, selectedSource, stageMove, agentThinking]);

  const handleNewGame = useCallback(() => {
    setSelectedSource(null);
    setStagedMoves([]);
    setBoth(newMatch(matchLength));
    void driveRef.current();
  }, [matchLength, setBoth]);

  // ── testMode: auto-play the HUMAN side so an E2E spec can drive a full
  // game (mirrors /play's hook contract: __HVH_MODEL_MOVES picks the
  // model's best move, else first legal). ─────────────────────────────────
  useEffect(() => {
    if (!testMode || !game || game.game_over || game.turn !== HUMAN || !game.dice || agentThinking) return;
    const modelMoves = !!(window as Window & { __HVH_MODEL_MOVES?: boolean }).__HVH_MODEL_MOVES;
    const board = toGameBoard(game);
    const dice = game.dice;

    let cancelled = false;
    const t = setTimeout(async () => {
      let candidates: string[] = [];
      if (modelMoves) {
        try {
          const ranked = await evaluateMoves(board, HUMAN, dice);
          candidates = ranked.map((c) => c.move);
          if (candidates.length > 0) {
            const w = window as Window & { __HVH_MODEL_MOVE_COUNT?: number };
            w.__HVH_MODEL_MOVE_COUNT = (w.__HVH_MODEL_MOVE_COUNT ?? 0) + 1;
          }
        } catch {
          // ONNX unavailable — legal-move order below.
        }
      }
      if (candidates.length === 0) candidates = generateLegalMoves(board, HUMAN, dice);
      candidates = candidates.filter((m) => m.trim());
      if (cancelled || candidates.length === 0) return;
      for (const move of candidates) {
        try {
          applyMoveToState(game, move);
          commitMove(move, game);
          break;
        } catch {
          // invalid — try the next candidate
        }
      }
    }, 50);
    return () => { cancelled = true; clearTimeout(t); };
  }, [testMode, game, agentThinking, commitMove]);

  // ── testMode: mirror live state onto window. ───────────────────────────
  useEffect(() => {
    if (!testMode) return;
    const w = window as Window & {
      __HVH_GAME_STATE?: MatchState | null;
      __HVH_MY_SIDE?: 0 | 1 | null;
    };
    w.__HVH_GAME_STATE = game;
    w.__HVH_MY_SIDE = HUMAN;
  }, [testMode, game]);

  // ── Render ───────────────────────────────────────────────────────────────
  const isMyTurn = game ? game.turn === HUMAN : false;
  const canInteract = isMyTurn && !!game?.dice && !game.game_over && !agentThinking;

  return (
    <main
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        padding: "16px 8px", minHeight: "100vh", background: "var(--cg-bg-1)", gap: 12,
      }}
    >
      <div style={{ width: "100%", maxWidth: 740, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)", textDecoration: "none" }}>
          ← Home
        </Link>
        <label style={{ fontSize: 12, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)", cursor: "pointer" }}>
          <span className="cg-chip" style={{ padding: "4px 10px" }}>Load agent weights (.onnx)</span>
          <input
            type="file"
            accept=".onnx"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onModelFile(f);
            }}
          />
        </label>
      </div>

      <p style={{ fontSize: 12, color: "var(--cg-fg-4)", fontFamily: "var(--cg-font-mono)" }}>
        vs {modelNote}
        {" · decrypted via sui/scripts/fetch_weights.ts (owner-only)"}
      </p>
      {modelError && (
        <p style={{ fontSize: 12, color: "var(--cg-danger)", fontFamily: "var(--cg-font-sans)" }}>{modelError}</p>
      )}

      {game && (
        <Board
          board={game.board}
          bar={game.bar}
          off={game.off}
          turn={game.turn}
          mySide={HUMAN}
          opponentName="Agent"
          themeKey={themeKey}
          cubeValue={1}
          cubeOwner={-1}
          selectedPoint={selectedSource}
          ghostMove={null}
          onPointClick={canInteract ? handlePointClick : undefined}
          onBarClick={canInteract ? handleBarClick : undefined}
          onOffClick={canInteract ? handleOffClick : undefined}
          playerAvatarUrls={gameCoins}
        />
      )}

      {game?.dice && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <DiceRoll dice={game.dice} />
        </div>
      )}

      {game && (
        <div style={{ fontSize: 13, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-2)" }}>
          Score: {game.score[HUMAN]} – {game.score[AGENT]}
          {" (first to "}{game.match_length}{")"}
        </div>
      )}

      {game && !game.game_over && (
        <p style={{ fontSize: 13, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          {agentThinking
            ? "Agent is thinking…"
            : isMyTurn
            ? "Your turn — click a checker to move"
            : "Agent's turn…"}
        </p>
      )}

      {stagedMoves.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          {stagedMoves.length}/{diceCount} moves staged
        </p>
      )}

      {game?.game_over && (
        <div
          style={{
            padding: "14px 20px", borderRadius: "var(--cg-radius)", border: "1px solid var(--cg-line-1)",
            background: "var(--cg-bg-2)", textAlign: "center", fontFamily: "var(--cg-font-sans)",
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, color: "var(--cg-fg-1)" }}>
            {game.winner === HUMAN ? "You win!" : "Agent wins"}
          </p>
          <button
            type="button"
            className="cg-chip"
            style={{ marginTop: 12, fontSize: 13 }}
            onClick={handleNewGame}
          >
            Play again
          </button>
        </div>
      )}
    </main>
  );
}
