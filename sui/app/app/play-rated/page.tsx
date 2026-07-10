// app/play-rated/page.tsx — rated peer-to-peer backgammon: real SUI stakes,
// on-chain dice (sui::random via chaingammon::game_match::roll), cosigned
// settlement (Task 6).
//
// Trimmed from ../play/page.tsx: same Nostr/WebRTC matchmaking, hello
// handshake, and move/skip wire messages, but dice come from the chain
// instead of commit-reveal, and the match itself is a real
// chaingammon::game_match::Match object with locked stakes. Kept as a
// separate page (not a branch inside ../play) so the already-verified
// unrated suite (Task 4/5) has zero regression risk from this file.
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

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
import { getOrCreateMockIdentity } from "../../lib/mock_identity";
import {
  loadLocalnetConfig,
  hasProfile,
  profileIdFor,
  createProfile,
  requestFaucet,
  type LocalnetConfig,
} from "../../lib/sui_client";
import {
  canonicalResultBytes,
  openRatedMatch,
  joinRatedMatch,
  rollOnChainDice,
  waitForDiceRoll,
  settleRatedMatch,
  settleRatedMatchWithProfiles,
} from "../../lib/rated_match_client";
import { peerMatches } from "../../lib/peer_connections";
import type { PeerConnection } from "../../lib/webrtc_match";

// ── Wire message types ─────────────────────────────────────────────────────

type HelloMsg = { type: "hello"; nostrPubkey: string; suiAddress: string; profileId: string | null };
type MatchOpenedMsg = { type: "match-opened"; matchObjectId: string };
type MatchJoinedMsg = { type: "match-joined" };
type ResultSigMsg = { type: "result-sig"; sig: string }; // hex
type GameMsg =
  | { type: "move"; move: string; positionId: string }
  | { type: "skip" }
  | { type: "resign" };

type WireMsg = HelloMsg | MatchOpenedMsg | MatchJoinedMsg | ResultSigMsg | GameMsg;

const MATCH_LENGTH = 1; // single game by default — a full multi-game rated match is a follow-up
const STAKE_MIST = 100_000_000n; // 0.1 SUI per side

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

  type Phase = "connecting" | "opening" | "joining" | "playing" | "settling" | "over" | "error";
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
  const [settledTxNote, setSettledTxNote] = useState<string | null>(null);

  const [gameCoins] = useState(() => pickGameCoins());
  const themeKey = loadTheme();

  const gameRef = useRef<MatchState | null>(null);
  const msgBufferRef = useRef<WireMsg[]>([]);
  const mySideRef = useRef<0 | 1 | null>(null);
  const turnIndexRef = useRef(0);
  const waitingForMoveRef = useRef(false);
  const waitingForDiceRef = useRef(false);

  const identityRef = useRef(getOrCreateMockIdentity());
  const sessionKeypairRef = useRef<Ed25519Keypair>(Ed25519Keypair.generate());
  const configRef = useRef<LocalnetConfig | null>(null);
  const matchObjectIdRef = useRef<string | null>(null);
  const mySuiAddressRef = useRef(identityRef.current.address);
  const oppSuiAddressRef = useRef<string | null>(null);
  const myProfileIdRef = useRef<string | null>(null);
  const oppProfileIdRef = useRef<string | null>(null);
  const myResultSigRef = useRef<Uint8Array | null>(null);
  const oppResultSigRef = useRef<Uint8Array | null>(null);
  const appMatchIdBytesRef = useRef<Uint8Array>(hexToBytes(matchId || "0x00"));

  const peerRef = useRef<PeerConnection | null>(null);
  const sendMsg = useCallback((msg: WireMsg) => {
    peerRef.current?.send(msg);
  }, []);

  // ── On-chain dice for `turnIndex` ───────────────────────────────────────
  const startOnChainDiceRound = useCallback(async (turnIndex: number) => {
    const config = configRef.current;
    const matchObjectId = matchObjectIdRef.current;
    if (!config || !matchObjectId || mySideRef.current === null) return;
    waitingForDiceRef.current = true;

    const amIRoller = (turnIndex % 2 === 0) === (mySideRef.current === 0);
    try {
      const roll = amIRoller
        ? await rollOnChainDice(config, identityRef.current.keypair, matchObjectId)
        : await waitForDiceRoll(config, matchObjectId, turnIndex);

      const currentGame = gameRef.current;
      if (!currentGame) return;
      const withDice: MatchState = { ...currentGame, dice: [roll.d1, roll.d2] };
      gameRef.current = withDice;
      setGame(withDice);
      waitingForDiceRef.current = false;

      const gboard: GameBoard = { points: withDice.board, bar: withDice.bar, off: withDice.off };
      if (mySideRef.current === withDice.turn && !hasLegalMoves(gboard, withDice.turn, [roll.d1, roll.d2])) {
        const skipped = skipTurn(withDice);
        gameRef.current = skipped;
        setGame(skipped);
        sendMsg({ type: "skip" });
        turnIndexRef.current += 1;
        void startOnChainDiceRound(turnIndexRef.current);
      } else {
        waitingForMoveRef.current = withDice.turn !== mySideRef.current;
      }
    } catch (e) {
      setPhase("error");
      setPhaseError(`On-chain roll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sendMsg]);
  const startOnChainDiceRoundRef = useRef(startOnChainDiceRound);
  useEffect(() => { startOnChainDiceRoundRef.current = startOnChainDiceRound; }, [startOnChainDiceRound]);

  // ── Settlement ───────────────────────────────────────────────────────────
  const trySettle = useCallback(async () => {
    const config = configRef.current;
    const matchObjectId = matchObjectIdRef.current;
    const mySig = myResultSigRef.current;
    const oppSig = oppResultSigRef.current;
    if (!config || !matchObjectId || !mySig || !oppSig || mySideRef.current === null) return;

    const finalGame = gameRef.current;
    if (!finalGame || finalGame.winner === null) return;
    const winnerAddress = finalGame.winner === mySideRef.current ? mySuiAddressRef.current : oppSuiAddressRef.current;
    if (!winnerAddress) return;

    // Side 0 (creator) is always ResultMsg/settle's "sig_a" side, matching
    // session_pk_a registered at open(); side 1 (joiner) is sig_b.
    const sigA = mySideRef.current === 0 ? mySig : oppSig;
    const sigB = mySideRef.current === 0 ? oppSig : mySig;

    setPhase("settling");
    try {
      const profileAId = mySideRef.current === 0 ? myProfileIdRef.current : oppProfileIdRef.current;
      const profileBId = mySideRef.current === 0 ? oppProfileIdRef.current : myProfileIdRef.current;
      if (profileAId && profileBId) {
        await settleRatedMatchWithProfiles(
          config, identityRef.current.keypair, matchObjectId, winnerAddress, sigA, sigB, profileAId, profileBId,
        );
      } else {
        await settleRatedMatch(config, identityRef.current.keypair, matchObjectId, winnerAddress, sigA, sigB);
      }
      setSettledTxNote(`Settled on-chain — pot paid to ${winnerAddress.slice(0, 10)}…`);
    } catch (e) {
      // The other side may have already settled first (double-settle is
      // rejected on-chain) — that's success from this side's perspective too.
      setSettledTxNote(`Settlement: ${e instanceof Error ? e.message : String(e)}`);
    }
    setPhase("over");
  }, []);

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
          void startOnChainDiceRoundRef.current(turnIndexRef.current);
        }
      } catch {
        setSelectedSource(null);
        setStagedMoves([]);
        setDisplayBoard(null);
      }
    },
    [sendMsg],
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
      const needsGame = msg.type === "move" || msg.type === "skip" || msg.type === "resign";
      if (needsGame && !gameRef.current) {
        msgBufferRef.current.push(msg);
        return;
      }
      const currentGame = gameRef.current;

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
            void startOnChainDiceRoundRef.current(turnIndexRef.current);
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
          void startOnChainDiceRoundRef.current(turnIndexRef.current);
        }
      }

      if (msg.type === "resign") {
        const mySideVal = mySideRef.current;
        if (mySideVal === null) return;
        const final = forceGameOver(currentGame ?? newMatch(matchLength), mySideVal);
        gameRef.current = final;
        setGame(final);
      }

      if (msg.type === "result-sig") {
        oppResultSigRef.current = hexToBytes(msg.sig);
        if (myResultSigRef.current) void trySettle();
      }
    },
    [matchLength, trySettle],
  );

  const handleMsgRef = useRef(handleMsg);
  useEffect(() => { handleMsgRef.current = handleMsg; }, [handleMsg]);

  // ── Post-game: sign and exchange result sigs ────────────────────────────
  useEffect(() => {
    if (!game?.game_over || game.winner === null) return;
    if (myResultSigRef.current) return; // already signed
    const mySideVal = mySideRef.current;
    if (mySideVal === null) return;

    void (async () => {
      const winnerAddress = game.winner === mySideVal ? mySuiAddressRef.current : oppSuiAddressRef.current;
      if (!winnerAddress) return;
      const bytes = canonicalResultBytes(appMatchIdBytesRef.current, winnerAddress);
      const sig = await sessionKeypairRef.current.sign(bytes);
      myResultSigRef.current = sig;
      sendMsg({ type: "result-sig", sig: bytesToHex(sig) });
      if (oppResultSigRef.current) void trySettle();
    })();
  }, [game?.game_over, game?.winner, sendMsg, trySettle]);

  // ── Mount: connect, hello, then open/join the on-chain match ───────────
  useEffect(() => {
    const entry = peerMatches.get(matchId);
    if (!entry) return;
    const peer: PeerConnection = entry.peer;
    peerRef.current = peer;

    void (async () => {
      const config = await loadLocalnetConfig();
      configRef.current = config;
      if (!config) {
        setPhase("error");
        setPhaseError("Rated play requires a published localnet (see sui/README.md) — none configured.");
        return;
      }
      // A player who lands here without ever clicking "Sign in" on the home
      // page (the common path — "Play rated" goes straight to matchmaking)
      // still needs a funded address to lock a stake; request the faucet
      // unconditionally, same as SignInPanel's signIn(). Rate-limits/errors
      // are swallowed — a returning guest with an already-funded address
      // doesn't need it anyway.
      await requestFaucet(config, mySuiAddressRef.current).catch(() => {});
      try {
        // Rated play always tracks ELO, so ensure a profile exists here too
        // (not just via the home page's "Sign in") rather than silently
        // falling back to the no-ELO settle path.
        if (!(await hasProfile(config, mySuiAddressRef.current))) {
          const shortAddr = mySuiAddressRef.current.slice(0, 8);
          await createProfile(config, identityRef.current.keypair, `guest-${shortAddr}`);
        }
        myProfileIdRef.current = await profileIdFor(config, mySuiAddressRef.current);
      } catch {
        // Profile creation failed — settle falls back to the no-ELO path.
      }

      const sendHello = () => {
        peer.send({
          type: "hello",
          nostrPubkey: entry.myNostrPubkey,
          suiAddress: mySuiAddressRef.current,
          profileId: myProfileIdRef.current,
        } as HelloMsg);
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
          if (mySideRef.current !== null) return;
          const myNostrPk = entry.myNostrPubkey;
          const oppNostrPk = msg.nostrPubkey;
          const side: 0 | 1 = myNostrPk < oppNostrPk ? 0 : 1;
          setMySide(side);
          mySideRef.current = side;
          setOppPubkey(oppNostrPk);
          oppSuiAddressRef.current = msg.suiAddress;
          oppProfileIdRef.current = msg.profileId;

          const initial = newMatch(matchLength);
          gameRef.current = initial;
          setGame(initial);

          void (async () => {
            try {
              if (side === 0) {
                setPhase("opening");
                const { matchObjectId } = await openRatedMatch(
                  config,
                  identityRef.current.keypair,
                  appMatchIdBytesRef.current,
                  sessionKeypairRef.current.getPublicKey().toRawBytes(),
                  STAKE_MIST,
                  myProfileIdRef.current,
                );
                matchObjectIdRef.current = matchObjectId;
                sendMsg({ type: "match-opened", matchObjectId });
              } else {
                setPhase("joining");
              }
            } catch (e) {
              setPhase("error");
              setPhaseError(`Failed to open match: ${e instanceof Error ? e.message : String(e)}`);
            }
          })();
          return;
        }

        if (msg.type === "match-opened") {
          void (async () => {
            matchObjectIdRef.current = msg.matchObjectId;
            try {
              await joinRatedMatch(
                config,
                identityRef.current.keypair,
                msg.matchObjectId,
                sessionKeypairRef.current.getPublicKey().toRawBytes(),
                STAKE_MIST,
                myProfileIdRef.current,
              );
              sendMsg({ type: "match-joined" });
              setPhase("playing");
              const buffered = msgBufferRef.current.splice(0);
              for (const m of buffered) handleMsgRef.current(m);
              turnIndexRef.current = 0;
              void startOnChainDiceRoundRef.current(0);
            } catch (e) {
              setPhase("error");
              setPhaseError(`Failed to join match: ${e instanceof Error ? e.message : String(e)}`);
            }
          })();
          return;
        }

        if (msg.type === "match-joined") {
          setPhase("playing");
          const buffered = msgBufferRef.current.splice(0);
          for (const m of buffered) handleMsgRef.current(m);
          turnIndexRef.current = 0;
          void startOnChainDiceRoundRef.current(0);
          return;
        }

        handleMsgRef.current(raw);
      });
    })();

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
    const w = window as Window & {
      __HVH_GAME_STATE?: MatchState | null;
      __HVH_MY_SIDE?: 0 | 1 | null;
      __HVH_PHASE?: Phase;
      __HVH_MATCH_OBJECT_ID?: string | null;
      __HVH_MY_SUI_ADDRESS?: string;
      __HVH_SETTLED_NOTE?: string | null;
    };
    w.__HVH_GAME_STATE = game;
    w.__HVH_MY_SIDE = mySide;
    w.__HVH_PHASE = phase;
    w.__HVH_MATCH_OBJECT_ID = matchObjectIdRef.current;
    w.__HVH_MY_SUI_ADDRESS = mySuiAddressRef.current;
    w.__HVH_SETTLED_NOTE = settledTxNote;
  }, [testMode, game, mySide, phase, settledTxNote]);

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
            vs {oppLabel} · staked {(Number(STAKE_MIST) / 1e9).toFixed(2)} SUI
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
      {phase === "opening" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Locking your stake on-chain…
        </p>
      )}
      {phase === "joining" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Joining the match on-chain…
        </p>
      )}
      {phase === "settling" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Submitting settlement…
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
          {waitingForDiceRef.current
            ? "Rolling on-chain…"
            : isMyTurn
            ? (game.dice ? "Your turn — click a checker to move" : "Rolling dice…")
            : "Opponent's turn…"}
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
          {settledTxNote && (
            <p style={{ fontSize: 12, color: "var(--cg-fg-3)", marginTop: 6 }}>{settledTxNote}</p>
          )}
          <Link href="/" style={{ display: "inline-block", marginTop: 12, color: "var(--cg-brass)" }}>
            Back to home
          </Link>
        </div>
      )}
    </main>
  );
}

export default function PlayRatedPage() {
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
