// app/play/page.tsx — unrated peer-to-peer backgammon over Nostr + WebRTC.
//
// Trimmed from frontend/app/play-human/PlayHumanClient.tsx: no wallet, no
// ENS, no on-chain settlement (Task 6 wires that up for rated play). Identity
// is just an ephemeral Nostr keypair (see ../../lib/nostr.ts). Dice are
// commit-reveal (../../lib/commit_reveal_dice.ts) instead of drand — this app
// has no chain/beacon dependency at all, so nothing external to fetch.
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Board } from "../Board";
import { DiceRoll } from "../DiceRoll";
import { loadTheme, pickGameCoins } from "../boardThemes";
import { evaluateMoves } from "../../lib/onnx_eval";
import {
  type MatchState,
  newMatch,
  applyMoveToState,
  hasLegalMoves,
  skipTurn,
} from "../../lib/match_engine";
import { type Board as GameBoard, generateLegalMoves } from "../../lib/rules_engine";
import {
  commitSecret,
  deriveDiceVerified,
  generateSecret,
  type DiceRoll as CommitRevealDiceRoll,
} from "../../lib/commit_reveal_dice";
import { peerMatches } from "../../lib/peer_connections";
import type { PeerConnection } from "../../lib/webrtc_match";
import type { Hex } from "viem";

// ── Wire message types ─────────────────────────────────────────────────────

type HelloMsg = { type: "hello"; nostrPubkey: string };
type DiceCommitMsg = { type: "dice-commit"; turnIndex: number; h: Hex };
type DiceRevealMsg = { type: "dice-reveal"; turnIndex: number; secret: Hex };
type GameMsg =
  | { type: "move"; move: string; positionId: string }
  | { type: "skip" }
  | { type: "resign" };

type WireMsg = HelloMsg | DiceCommitMsg | DiceRevealMsg | GameMsg;

const MATCH_LENGTH = 3;

// A fixed secret ordering (side 0 first, side 1 second) so both peers derive
// the same dice regardless of whose turn it is or who reveals first.
interface DiceRound {
  turnIndex: number;
  mySecret: Hex;
  myCommitment: Hex;
  myCommitSent: boolean;
  myRevealSent: boolean;
  oppCommitment: Hex | null;
  oppSecret: Hex | null;
}

function forceGameOver(state: MatchState, winner: 0 | 1): MatchState {
  const newScore: [number, number] =
    winner === 0
      ? [Math.max(state.score[0], state.match_length), state.score[1]]
      : [state.score[0], Math.max(state.score[1], state.match_length)];
  return { ...state, score: newScore, game_over: true, winner };
}

function HumanMatchInner() {
  const searchParams = useSearchParams();
  const matchId = searchParams.get("id") ?? "";

  const testMode =
    typeof window !== "undefined" &&
    !!(window as Window & { __HVH_TEST_MODE?: boolean }).__HVH_TEST_MODE;

  const matchLength =
    (testMode &&
      Number((window as Window & { __HVH_MATCH_LENGTH?: number }).__HVH_MATCH_LENGTH)) ||
    MATCH_LENGTH;

  type Phase = "connecting" | "playing" | "over" | "error";
  const [phase, setPhase] = useState<Phase>("connecting");
  const [phaseError, setPhaseError] = useState<string | null>(null);

  const [game, setGame] = useState<MatchState | null>(null);
  const [mySide, setMySide] = useState<0 | 1 | null>(null);
  const [oppPubkey, setOppPubkey] = useState<string | null>(null);

  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [stagedMoves, setStagedMoves] = useState<string[]>([]);
  const [displayBoard, setDisplayBoard] = useState<{
    board: number[]; bar: [number, number]; off: [number, number];
  } | null>(null);
  const [hoveredMove] = useState<string | null>(null);

  const [gameCoins] = useState(() => pickGameCoins());
  const themeKey = loadTheme();

  const gameRef = useRef<MatchState | null>(null);
  const msgBufferRef = useRef<WireMsg[]>([]);
  const mySideRef = useRef<0 | 1 | null>(null);
  const turnIndexRef = useRef(0);
  const diceRoundRef = useRef<DiceRound | null>(null);
  const waitingForMoveRef = useRef(false);
  // The peer that just moved starts its next dice round synchronously; the
  // other peer only starts it after asynchronously processing that move
  // message. A dice-commit/-reveal for turn N+1 can therefore arrive here
  // before this side has locally called startDiceRound(N+1) — buffer it
  // instead of dropping it, and replay on the next startDiceRound call.
  const pendingDiceMsgsRef = useRef<(DiceCommitMsg | DiceRevealMsg)[]>([]);

  const peerRef = useRef<PeerConnection | null>(null);
  const sendMsg = useCallback((msg: WireMsg) => {
    peerRef.current?.send(msg);
  }, []);

  // Always points at the latest maybeRevealAndDerive — startDiceRound needs
  // to call it (to apply buffered messages below) but is defined first, so a
  // direct reference would be circular.
  const maybeRevealAndDeriveRef = useRef<() => void>(() => {});

  // ── Dice: start a commit-reveal round for `turnIndex` ──────────────────
  const startDiceRound = useCallback((turnIndex: number, currentGame: MatchState) => {
    const mySecret = generateSecret();
    const myCommitment = commitSecret(mySecret);
    const round: DiceRound = {
      turnIndex,
      mySecret,
      myCommitment,
      myCommitSent: true,
      myRevealSent: false,
      oppCommitment: null,
      oppSecret: null,
    };
    diceRoundRef.current = round;
    sendMsg({ type: "dice-commit", turnIndex, h: myCommitment });
    void currentGame; // referenced for symmetry with the caller; state read via gameRef

    // Apply any dice-commit/-reveal for this turn that arrived before we got
    // here (see pendingDiceMsgsRef's comment above). Discard anything for an
    // earlier turn — it's stale by definition once we've moved on.
    const pending = pendingDiceMsgsRef.current;
    pendingDiceMsgsRef.current = pending.filter((m) => m.turnIndex > turnIndex);
    for (const m of pending) {
      if (m.turnIndex !== turnIndex) continue;
      if (m.type === "dice-commit") round.oppCommitment = m.h;
      else round.oppSecret = m.secret;
    }
    if (pending.some((m) => m.turnIndex === turnIndex)) maybeRevealAndDeriveRef.current();
  }, [sendMsg]);

  const maybeRevealAndDerive = useCallback(() => {
    const round = diceRoundRef.current;
    if (!round) return;
    if (round.oppCommitment && !round.myRevealSent) {
      round.myRevealSent = true;
      sendMsg({ type: "dice-reveal", turnIndex: round.turnIndex, secret: round.mySecret });
    }
    if (round.oppSecret && round.myRevealSent) {
      let roll: CommitRevealDiceRoll;
      try {
        const side0 = mySideRef.current === 0
          ? { secret: round.mySecret, commitment: round.myCommitment }
          : { secret: round.oppSecret, commitment: round.oppCommitment! };
        const side1 = mySideRef.current === 0
          ? { secret: round.oppSecret, commitment: round.oppCommitment! }
          : { secret: round.mySecret, commitment: round.myCommitment };
        roll = deriveDiceVerified(round.turnIndex, side0, side1);
      } catch {
        setPhase("error");
        setPhaseError("Dice commitment mismatch — opponent revealed a secret that doesn't match their commitment.");
        return;
      }
      diceRoundRef.current = null;
      const currentGame = gameRef.current;
      if (!currentGame) return;
      const withDice: MatchState = { ...currentGame, dice: [roll.d1, roll.d2] };
      gameRef.current = withDice;
      setGame(withDice);

      const gboard: GameBoard = { points: withDice.board, bar: withDice.bar, off: withDice.off };
      if (mySideRef.current === withDice.turn && !hasLegalMoves(gboard, withDice.turn, [roll.d1, roll.d2])) {
        const skipped = skipTurn(withDice);
        gameRef.current = skipped;
        setGame(skipped);
        sendMsg({ type: "skip" });
        turnIndexRef.current += 1;
        startDiceRound(turnIndexRef.current, skipped);
      } else {
        waitingForMoveRef.current = withDice.turn !== mySideRef.current;
      }
    }
  }, [sendMsg, startDiceRound]);
  maybeRevealAndDeriveRef.current = maybeRevealAndDerive;

  // ── Commit staged moves ─────────────────────────────────────────────────
  const commitMove = useCallback(
    (notation: string, currentGame: MatchState) => {
      try {
        const next = applyMoveToState(currentGame, notation);
        sendMsg({ type: "move", move: notation, positionId: next.position_id });
        gameRef.current = next;
        setGame(next);
        setSelectedSource(null);
        setStagedMoves([]);
        setDisplayBoard(null);

        if (!next.game_over) {
          waitingForMoveRef.current = true;
          turnIndexRef.current += 1;
          startDiceRound(turnIndexRef.current, next);
        }
      } catch {
        setSelectedSource(null);
        setStagedMoves([]);
        setDisplayBoard(null);
      }
    },
    [sendMsg, startDiceRound],
  );

  const diceCount = game?.dice ? (game.dice[0] === game.dice[1] ? 4 : 2) : 0;

  const stageMove = useCallback(
    (from: number | "bar", to: number | "off") => {
      if (!game?.dice || waitingForMoveRef.current) return;
      const fromStr = from === "bar" ? "bar" : String(from);
      const toStr = to === "off" ? "off" : String(to);
      const curBoardForHit = displayBoard?.board ?? game.board;
      const side = mySideRef.current ?? 0;
      const dstCount = typeof to === "number" ? curBoardForHit[to - 1] : 0;
      const isHit = typeof to === "number" && ((side === 0 && dstCount === -1) || (side === 1 && dstCount === 1));
      const seg = `${fromStr}/${toStr}${isHit ? "*" : ""}`;
      const newStaged = [...stagedMoves, seg];

      setStagedMoves(newStaged);
      setSelectedSource(null);

      if (newStaged.length >= diceCount) {
        commitMove(newStaged.join(" "), game);
        setStagedMoves([]);
        setDisplayBoard(null);
      }
    },
    [game, stagedMoves, displayBoard, diceCount, commitMove],
  );

  const handlePointClick = useCallback(
    (point: number) => {
      if (!game?.dice || game.game_over || waitingForMoveRef.current) return;
      if (game.turn !== mySideRef.current) return;

      if (selectedSource === null) {
        const side = mySideRef.current ?? 0;
        const activeBoard = displayBoard?.board ?? game.board;
        const activeBar = displayBoard?.bar ?? game.bar;
        if ((activeBar as [number, number])[side] > 0) return;
        const checker = activeBoard[point - 1];
        const isOwn = side === 0 ? checker > 0 : checker < 0;
        if (!isOwn) return;
        setSelectedSource(point);
      } else {
        stageMove(selectedSource, point);
        setSelectedSource(null);
      }
    },
    [game, selectedSource, stageMove, displayBoard],
  );

  const handleBarClick = useCallback(() => {
    if (!game?.dice || game.game_over || waitingForMoveRef.current) return;
    if (game.turn !== mySideRef.current) return;
    const side = mySideRef.current ?? 0;
    if (game.bar[side] > 0) setSelectedSource(25);
  }, [game]);

  const handleResign = useCallback(() => {
    if (!game || game.game_over) return;
    if (!window.confirm("Resign? You will be marked as the loser.")) return;
    const side = mySideRef.current ?? 0;
    const final = forceGameOver(game, (1 - side) as 0 | 1);
    gameRef.current = final;
    setGame(final);
    sendMsg({ type: "resign" });
  }, [game, sendMsg]);

  // ── Message handler ─────────────────────────────────────────────────────
  const handleMsg = useCallback(
    (raw: unknown) => {
      const msg = raw as WireMsg;
      const isGameMsg = msg.type !== "hello";
      if (isGameMsg && !gameRef.current) {
        msgBufferRef.current.push(msg);
        return;
      }
      const currentGame = gameRef.current;

      if (msg.type === "dice-commit") {
        const round = diceRoundRef.current;
        if (!round || round.turnIndex !== msg.turnIndex) {
          // Our local round for this turn hasn't started yet — buffer it
          // (see pendingDiceMsgsRef's comment above) rather than dropping it.
          if (!round || msg.turnIndex > round.turnIndex) pendingDiceMsgsRef.current.push(msg);
          return;
        }
        round.oppCommitment = msg.h;
        maybeRevealAndDerive();
      }

      if (msg.type === "dice-reveal") {
        const round = diceRoundRef.current;
        if (!round || round.turnIndex !== msg.turnIndex) {
          if (!round || msg.turnIndex > round.turnIndex) pendingDiceMsgsRef.current.push(msg);
          return;
        }
        round.oppSecret = msg.secret;
        maybeRevealAndDerive();
      }

      if (msg.type === "move") {
        if (!currentGame) return;
        try {
          const next = applyMoveToState(currentGame, msg.move);
          if (next.position_id !== msg.positionId) {
            setPhase("error");
            setPhaseError("Position desync — positions don't match. Game state is inconsistent.");
            return;
          }
          gameRef.current = next;
          setGame(next);
          waitingForMoveRef.current = false;
          if (!next.game_over) {
            turnIndexRef.current += 1;
            startDiceRound(turnIndexRef.current, next);
          }
        } catch {/* ignore */}
      }

      if (msg.type === "skip") {
        if (!currentGame) return;
        const skipped = skipTurn(currentGame);
        gameRef.current = skipped;
        setGame(skipped);
        waitingForMoveRef.current = false;
        if (!skipped.game_over) {
          turnIndexRef.current += 1;
          startDiceRound(turnIndexRef.current, skipped);
        }
      }

      if (msg.type === "resign") {
        const mySideVal = mySideRef.current;
        if (mySideVal === null) return;
        const final = forceGameOver(currentGame ?? newMatch(matchLength), mySideVal);
        gameRef.current = final;
        setGame(final);
      }
    },
    [maybeRevealAndDerive, startDiceRound, matchLength],
  );

  const handleMsgRef = useRef(handleMsg);
  useEffect(() => { handleMsgRef.current = handleMsg; }, [handleMsg]);

  // ── Mount: get peer connection, send hello, wire message handler ───────
  useEffect(() => {
    const entry = peerMatches.get(matchId);
    if (!entry) return;
    const peer: PeerConnection = entry.peer;
    peerRef.current = peer;

    // peer.send() is a silent no-op while the channel isn't open, and the
    // receiver ignores a duplicate hello once a side is already assigned
    // (see the "hello" case in onMessage below) — so it's safe to call this
    // both immediately (the connection is virtually always already "open" by
    // the time this page mounts, since matchmaking in ../page.tsx navigates
    // here only after reaching "open") and again from the state callback,
    // which is a pure setter that won't replay a state change that already
    // happened (covering the rare case where this page mounts before "open").
    const sendHello = () => {
      peer.send({ type: "hello", nostrPubkey: entry.myNostrPubkey } as HelloMsg);
    };
    peer.onState((s) => {
      if (s === "open") sendHello();
      else if (s === "failed" || s === "closed") {
        setPhase("error");
        setPhaseError("WebRTC connection lost.");
      }
    });
    sendHello();

    peer.onMessage((raw) => {
      const msg = raw as WireMsg;
      if (msg.type === "hello") {
        if (mySideRef.current !== null) return; // already assigned
        const myNostrPk = entry.myNostrPubkey;
        const oppNostrPk = msg.nostrPubkey;
        const side: 0 | 1 = myNostrPk < oppNostrPk ? 0 : 1;
        setMySide(side);
        mySideRef.current = side;
        setOppPubkey(oppNostrPk);

        setPhase("playing");
        const initial = newMatch(matchLength);
        gameRef.current = initial;
        setGame(initial);

        const buffered = msgBufferRef.current.splice(0);
        for (const m of buffered) handleMsgRef.current(m);

        turnIndexRef.current = 0;
        startDiceRound(0, initial);
        return;
      }
      handleMsgRef.current(raw);
    });

    return () => { peerRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // ── testMode: auto-commit a move on each turn ──────────────────────────
  useEffect(() => {
    if (!testMode || phase !== "playing" || !game || game.game_over) return;
    if (game.turn !== mySideRef.current || !game.dice) return;

    const modelMoves = !!(window as Window & { __HVH_MODEL_MOVES?: boolean }).__HVH_MODEL_MOVES;
    const board: GameBoard = { points: game.board, bar: game.bar, off: game.off };
    const side = mySideRef.current;
    const dice = game.dice;

    let cancelled = false;
    const t = setTimeout(async () => {
      let candidates: string[] = [];
      let fromModel = false;
      if (modelMoves) {
        try {
          const ranked = await evaluateMoves(board, side, dice);
          if (ranked.length > 0) {
            candidates = ranked.map((c) => c.move);
            fromModel = true;
          }
        } catch {
          // ONNX unavailable — fall through to legal-move order below.
        }
      }
      if (candidates.length === 0) candidates = generateLegalMoves(board, side, dice);
      candidates = candidates.filter((m) => m.trim());
      if (cancelled || candidates.length === 0) return;

      for (const move of candidates) {
        try {
          applyMoveToState(game, move);
          if (fromModel) {
            const w = window as Window & { __HVH_MODEL_MOVE_COUNT?: number };
            w.__HVH_MODEL_MOVE_COUNT = (w.__HVH_MODEL_MOVE_COUNT ?? 0) + 1;
          }
          commitMove(move, game);
          break;
        } catch {
          // invalid — try the next candidate
        }
      }
    }, 50);
    return () => { cancelled = true; clearTimeout(t); };
  }, [testMode, game, phase, commitMove]);

  // ── testMode: mirror live game state onto window ────────────────────────
  useEffect(() => {
    if (!testMode) return;
    const w = window as Window & { __HVH_GAME_STATE?: MatchState | null; __HVH_MY_SIDE?: 0 | 1 | null };
    w.__HVH_GAME_STATE = game;
    w.__HVH_MY_SIDE = mySide;
  }, [testMode, game, mySide]);

  useEffect(() => {
    if (game?.game_over) setPhase("over");
  }, [game?.game_over]);

  // ── Render ───────────────────────────────────────────────────────────────
  const entry = peerMatches.get(matchId);
  if (!entry) {
    return (
      <main
        style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: "100vh", gap: 16,
          fontFamily: "var(--cg-font-sans)", color: "var(--cg-fg-1)",
        }}
      >
        <p>No active connection for this match. Did you navigate here directly?</p>
        <Link href="/" style={{ color: "var(--cg-brass)" }}>← Back to home</Link>
      </main>
    );
  }

  const currentBoard = displayBoard?.board ?? game?.board ?? [];
  const currentBar = (displayBoard?.bar ?? game?.bar ?? [0, 0]) as [number, number];
  const currentOff = (displayBoard?.off ?? game?.off ?? [0, 0]) as [number, number];
  const isMyTurn = game ? game.turn === mySide : false;
  const canInteract = phase === "playing" && isMyTurn && !!game?.dice && !game.game_over && !waitingForMoveRef.current;
  const oppLabel = oppPubkey ? `${oppPubkey.slice(0, 8)}…` : "Opponent";

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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-3)" }}>
            vs {oppLabel}
          </span>
          {phase === "playing" && game && !game.game_over && (
            <button type="button" className="cg-chip" style={{ fontSize: 12 }} onClick={handleResign}>
              Resign
            </button>
          )}
        </div>
      </div>

      {phase === "connecting" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Waiting for opponent…
        </p>
      )}
      {(phase === "error" || phaseError) && (
        <p style={{ fontSize: 14, color: "var(--cg-danger)", fontFamily: "var(--cg-font-sans)" }}>
          {phaseError ?? "Connection error."}
        </p>
      )}

      {game && (
        <Board
          board={currentBoard}
          bar={currentBar}
          off={currentOff}
          turn={game.turn}
          mySide={mySide ?? 0}
          opponentName={oppLabel}
          themeKey={themeKey}
          cubeValue={1}
          cubeOwner={-1}
          selectedPoint={selectedSource}
          ghostMove={hoveredMove}
          onPointClick={canInteract ? handlePointClick : undefined}
          onBarClick={canInteract ? handleBarClick : undefined}
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
          Score: {game.score[mySide ?? 0]} – {game.score[(1 - (mySide ?? 0)) as 0 | 1]}
          {" (first to "}{game.match_length}{")"}
        </div>
      )}

      {phase === "playing" && game && !game.game_over && (
        <p style={{ fontSize: 13, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          {isMyTurn ? (game.dice ? "Your turn — click a checker to move" : "Rolling dice…") : "Opponent's turn…"}
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
            {game.winner === mySide ? "You win!" : "Opponent wins"}
          </p>
          <Link href="/" style={{ display: "inline-block", marginTop: 12, color: "var(--cg-brass)" }}>
            Back to home
          </Link>
        </div>
      )}
    </main>
  );
}

export default function PlayPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            minHeight: "100vh", color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)",
          }}
        >
          Loading…
        </div>
      }
    >
      <HumanMatchInner />
    </Suspense>
  );
}
