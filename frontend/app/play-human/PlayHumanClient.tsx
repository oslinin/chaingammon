// play-human/[matchId]/page.tsx — H-vs-H board surface.
//
// Retrieves the live WebRTC PeerConnection stored by EloHome (page.tsx),
// runs a two-phase hello handshake to agree on player sides + exchange
// session-key auth sigs, then plays through the match using drand-derived
// dice and relaying moves over the data channel. On game end, both session
// keys auto-sign the result and either player submits settleHumanVsHuman.
"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, useReadContracts, useSignMessage } from "wagmi";

import { Board } from "../Board";
import { DiceRoll } from "../DiceRoll";
import { loadTheme, pickGameCoins } from "../boardThemes";
import { useActiveChainId } from "../chains";
import { MatchRegistryABI, useChainContracts } from "../contracts";
import { useChaingammonName } from "../useChaingammonName";
import { useChaingammonProfile } from "../useChaingammonProfile";
import { useSponsoredWrite } from "../useSponsoredWrite";
import {
  type MatchState,
  newMatch,
  applyMoveToState,
  hasLegalMoves,
  skipTurn,
  offerDouble,
  acceptDouble,
  dropDouble,
} from "../../lib/match_engine";
import { type Board as GameBoard, getMaxLegalMoves } from "../../lib/rules_engine";
import { deriveDice, fetchDrandRound } from "../../lib/drand_dice";
import { peerMatches } from "../../lib/peer_connections";
import type { PeerConnection } from "../../lib/webrtc_match";

// ── Wire message types ─────────────────────────────────────────────────────

type HelloMsg = {
  type: "hello";
  address: string;
  ensLabel: string | null;
  elo: number;
  nonce: string;       // BigInt serialized as decimal string
  sessionKey: string;  // session key address (0x...)
};

type AuthMsg = {
  type: "auth";
  authSig: string;
};

type GameMsg =
  | { type: "roll"; roundNumber: number; turnIndex: number }
  | { type: "move"; move: string; positionId: string }
  | { type: "double" }
  | { type: "accept" }
  | { type: "drop" }
  | { type: "resign" }
  | { type: "skip" }
  | { type: "result-sig"; resultSig: string };

type WireMsg = HelloMsg | AuthMsg | GameMsg;

// ── Constants ─────────────────────────────────────────────────────────────

const MATCH_LENGTH = 3;
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// ── Helpers ───────────────────────────────────────────────────────────────

function applyMoveSegment(
  board: number[],
  bar: [number, number],
  off: [number, number],
  from: number | "bar",
  to: number | "off",
): { board: number[]; bar: [number, number]; off: [number, number] } {
  const b = [...board];
  const r: [number, number] = [bar[0], bar[1]];
  const o: [number, number] = [off[0], off[1]];
  if (from === "bar") r[0] = Math.max(0, r[0] - 1);
  else b[from - 1] -= 1;
  if (to === "off") o[0] += 1;
  else {
    if (b[to - 1] === -1) { b[to - 1] = 0; r[1] += 1; }
    b[to - 1] += 1;
  }
  return { board: b, bar: r, off: o };
}

// Force game over (resign or connection loss) with an explicit winner.
function forceGameOver(state: MatchState, winner: 0 | 1): MatchState {
  const newScore: [number, number] =
    winner === 0
      ? [Math.max(state.score[0], state.match_length), state.score[1]]
      : [state.score[0], Math.max(state.score[1], state.match_length)];
  return { ...state, score: newScore, game_over: true, winner };
}

// ── Inner component ───────────────────────────────────────────────────────

function HumanMatchInner() {
  const searchParams = useSearchParams();
  const matchId = searchParams.get("id") ?? "";

  const { address } = useAccount();
  const chainId = useActiveChainId();
  const { matchRegistry } = useChainContracts();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useSponsoredWrite();

  const { label } = useChaingammonName(address);
  const { elo } = useChaingammonProfile(label);

  // ── Nonces from chain ──────────────────────────────────────────────────
  const [oppAddress, setOppAddress] = useState<`0x${string}` | null>(null);
  const { label: oppLiveLabel } = useChaingammonName(oppAddress ?? undefined);

  const nonceCalls =
    address && oppAddress && matchRegistry
      ? [
          {
            address: matchRegistry,
            abi: MatchRegistryABI,
            functionName: "nonces" as const,
            args: [address] as [`0x${string}`],
            chainId,
          },
          {
            address: matchRegistry,
            abi: MatchRegistryABI,
            functionName: "nonces" as const,
            args: [oppAddress] as [`0x${string}`],
            chainId,
          },
        ]
      : [];

  const { data: nonceData } = useReadContracts({
    contracts: nonceCalls,
    query: { enabled: nonceCalls.length === 2 },
  });
  const myNonce = nonceData?.[0]?.result as bigint | undefined;
  const oppNonce = nonceData?.[1]?.result as bigint | undefined;

  // ── Game state ─────────────────────────────────────────────────────────
  type Phase =
    | "connecting"     // waiting for hello from opponent
    | "signing"        // signing auth (wallet prompt)
    | "playing"        // game in progress
    | "awaiting-result-sig" // waiting for opponent's result sig
    | "settling"
    | "settled"
    | "error";

  const [phase, setPhase] = useState<Phase>("connecting");
  const [phaseError, setPhaseError] = useState<string | null>(null);

  const [game, setGame] = useState<MatchState | null>(null);
  const [mySide, setMySide] = useState<0 | 1 | null>(null);
  const [oppInfo, setOppInfo] = useState<{
    address: string; ensLabel: string | null; elo: number;
    nonce: string; sessionKey: string;
  } | null>(null);

  const [sessionAccount, setSessionAccount] = useState<PrivateKeyAccount | null>(null);
  const [myAuthSig, setMyAuthSig] = useState<`0x${string}` | null>(null);
  const [myNonceUsed, setMyNonceUsed] = useState<bigint | null>(null);
  const [oppAuthSig, setOppAuthSig] = useState<`0x${string}` | null>(null);

  const [settleTxHash, setSettleTxHash] = useState<`0x${string}` | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

  // Interactive board state
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [stagedMoves, setStagedMoves] = useState<string[]>([]);
  const [displayBoard, setDisplayBoard] = useState<{
    board: number[]; bar: [number, number]; off: [number, number];
  } | null>(null);

  // Doubling cube UI
  const [cubePrompt, setCubePrompt] = useState<"accept-drop" | null>(null);

  // Coins & theme
  const [gameCoins] = useState(() => pickGameCoins());
  const themeKey = loadTheme();

  // ── Refs for async callbacks ───────────────────────────────────────────
  const gameRef = useRef<MatchState | null>(null);
  const mySideRef = useRef<0 | 1 | null>(null);
  const turnIndexRef = useRef(0);
  const waitingForRollRef = useRef(false);
  const waitingForMoveRef = useRef(false);
  const waitingForDoubleResponseRef = useRef(false);
  const pendingDoubleGameRef = useRef<MatchState | null>(null);
  const oppResultSigRef = useRef<string | null>(null);
  const myResultSigRef = useRef<string | null>(null);

  const peerRef = useRef<PeerConnection | null>(null);
  const sendMsg = useCallback((msg: WireMsg) => {
    peerRef.current?.send(msg);
  }, []);

  // ── Settlement ─────────────────────────────────────────────────────────
  const settleMatch = useCallback(
    async (
      finalGame: MatchState,
      sa: PrivateKeyAccount,
      myAddr: string,
      opp: NonNullable<typeof oppInfo>,
      myNonceVal: bigint,
      myAuthSig: `0x${string}`,
      oppAuthSig: `0x${string}`,
      myResultSigVal: string,
      oppResultSigVal: string,
    ) => {
      if (!matchRegistry || matchRegistry === "0x0000000000000000000000000000000000000000") return;
      setPhase("settling");

      const isALower = BigInt(myAddr) < BigInt(opp.address);
      const playerA = (isALower ? myAddr : opp.address) as `0x${string}`;
      const playerB = (isALower ? opp.address : myAddr) as `0x${string}`;
      const nonceA = isALower ? myNonceVal : BigInt(opp.nonce);
      const nonceB = isALower ? BigInt(opp.nonce) : myNonceVal;
      const sessionKeyA = (isALower ? sa.address : opp.sessionKey) as `0x${string}`;
      const sessionKeyB = (isALower ? opp.sessionKey : sa.address) as `0x${string}`;
      const authSigA = (isALower ? myAuthSig : oppAuthSig) as `0x${string}`;
      const authSigB = (isALower ? oppAuthSig : myAuthSig) as `0x${string}`;
      const resultSigA = (isALower ? myResultSigVal : oppResultSigVal) as `0x${string}`;
      const resultSigB = (isALower ? oppResultSigVal : myResultSigVal) as `0x${string}`;

      const winner = finalGame.winner;
      const mySideVal = mySideRef.current;
      let aWins: boolean;
      if (winner === null) {
        aWins = isALower; // fallback: I win
      } else {
        const myAddrWins = winner === mySideVal;
        aWins = isALower ? myAddrWins : !myAddrWins;
      }

      try {
        const txHash = await writeContractAsync({
          address: matchRegistry,
          abi: MatchRegistryABI,
          functionName: "settle",
          args: [
            { playerA, playerB, agentId: 0n, matchLength: MATCH_LENGTH, aWins, gameRecordHash: ZERO_HASH, nonceA, nonceB, sessionKeyA, sessionKeyB },
            authSigA,
            authSigB,
            resultSigA,
            resultSigB,
            ZERO_HASH,  // escrowMatchId (ELO-only)
            [],
            [],
          ],
        });
        setSettleTxHash(txHash as `0x${string}`);
        setPhase("settled");
      } catch (e) {
        setSettleError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [matchRegistry, writeContractAsync],
  );

  // ── Sign result and exchange ───────────────────────────────────────────
  const finishGame = useCallback(
    async (
      finalGame: MatchState,
      sa: PrivateKeyAccount,
      myAddr: string,
      opp: NonNullable<typeof oppInfo>,
      myNonceVal: bigint,
      authSigParam: `0x${string}`,
      oppAuthSigParam: `0x${string}`,
    ) => {
      if (!matchRegistry || matchRegistry === "0x0000000000000000000000000000000000000000") return;

      const isALower = BigInt(myAddr) < BigInt(opp.address);
      const playerA = (isALower ? myAddr : opp.address) as `0x${string}`;
      const nonceA = isALower ? myNonceVal : BigInt(opp.nonce);
      const playerB = (isALower ? opp.address : myAddr) as `0x${string}`;
      const nonceB = isALower ? BigInt(opp.nonce) : myNonceVal;

      const winner = finalGame.winner;
      const mySideVal = mySideRef.current;
      let aWins: boolean;
      if (winner === null) {
        aWins = isALower;
      } else {
        const myAddrWins = winner === mySideVal;
        aWins = isALower ? myAddrWins : !myAddrWins;
      }

      // escrowMatchId and splitHash are bound in the result hash even for
      // ELO-only games (zeros/empty) to prevent relayer payout injection.
      const emptySplitHash = keccak256(encodeAbiParameters(
        parseAbiParameters("address[], uint256[]"),
        [[], []],
      ));
      const resultHashRaw = keccak256(
        encodeAbiParameters(
          parseAbiParameters(
            "string, uint256, address, address, uint256, address, uint256, bool, bytes32, bytes32, bytes32",
          ),
          [
            "Chaingammon:result-hvh",
            BigInt(chainId ?? 0),
            matchRegistry as `0x${string}`,
            playerA,
            nonceA,
            playerB,
            nonceB,
            aWins,
            ZERO_HASH,
            ZERO_HASH,         // escrowMatchId (none for HvH ELO-only)
            emptySplitHash,
          ],
        ),
      );

      const myResultSig = await sa.signMessage({ message: { raw: resultHashRaw } });
      myResultSigRef.current = myResultSig;

      setPhase("awaiting-result-sig");
      sendMsg({ type: "result-sig", resultSig: myResultSig });

      // If opponent's sig already arrived, settle now.
      if (oppResultSigRef.current) {
        await settleMatch(
          finalGame,
          sa,
          myAddr,
          opp,
          myNonceVal,
          authSigParam,
          oppAuthSigParam,
          myResultSig,
          oppResultSigRef.current,
        );
      }
    },
    [chainId, matchRegistry, sendMsg, settleMatch],
  );

  // ── Per-turn: roll dice (mover side) ──────────────────────────────────
  const rollMyDice = useCallback(async (currentGame: MatchState) => {
    try {
      const round = await fetchDrandRound();
      const idx = turnIndexRef.current;
      const roll = deriveDice(`0x${round.randomness.replace(/^0x/, "")}` as `0x${string}`, idx, round.round);
      turnIndexRef.current += 1;

      sendMsg({ type: "roll", roundNumber: round.round, turnIndex: idx });

      const withDice: MatchState = { ...currentGame, dice: [roll.d1, roll.d2] };
      gameRef.current = withDice;
      setGame(withDice);

      // Auto-skip if no legal moves.
      const gboard: GameBoard = { points: withDice.board, bar: withDice.bar, off: withDice.off };
      if (!hasLegalMoves(gboard, mySideRef.current as 0 | 1, [roll.d1, roll.d2])) {
        const skipped = skipTurn(withDice);
        gameRef.current = skipped;
        setGame(skipped);
        sendMsg({ type: "skip" });
        // Opponent's turn — wait for their roll.
        waitingForRollRef.current = true;
      }
    } catch {
      // drand fetch failed — retry next turn
    }
  }, [sendMsg]);

  // ── Commit staged moves ────────────────────────────────────────────────
  const commitMove = useCallback(
    async (notation: string, currentGame: MatchState) => {
      try {
        const next = applyMoveToState(currentGame, notation);
        sendMsg({ type: "move", move: notation, positionId: next.position_id });
        gameRef.current = next;
        setGame(next);
        setSelectedSource(null);
        setStagedMoves([]);
        setDisplayBoard(null);

        if (next.game_over) {
          // Settlement handled by effect below.
        } else if (next.turn !== mySideRef.current) {
          // Now it's the opponent's turn.
          waitingForRollRef.current = true;
        }
      } catch {
        setSelectedSource(null);
        setStagedMoves([]);
        setDisplayBoard(null);
      }
    },
    [sendMsg],
  );

  // ── Board interaction (my turn only) ──────────────────────────────────
  const maxLegalMoves = useMemo(() => {
    if (!game || !game.dice || game.turn !== mySideRef.current) return 0;
    const rulesBoard = { points: game.board, bar: game.bar, off: game.off } as GameBoard;
    return getMaxLegalMoves(rulesBoard, game.turn, game.dice as [number, number]);
  }, [game]);

  const diceCount = game?.dice
    ? game.dice[0] === game.dice[1] ? 4 : 2
    : 0;

  const stageMove = useCallback(
    (from: number | "bar", to: number | "off") => {
      if (!game?.dice || waitingForRollRef.current || waitingForMoveRef.current) return;
      const fromStr = from === "bar" ? "bar" : String(from);
      const toStr = to === "off" ? "off" : String(to);
      const seg = `${fromStr}/${toStr}`;
      const newStaged = [...stagedMoves, seg];

      const curBoard = displayBoard?.board ?? game.board;
      const curBar = displayBoard?.bar ?? game.bar;
      const curOff = displayBoard?.off ?? game.off;
      const newDisplay = applyMoveSegment(curBoard, curBar as [number, number], curOff as [number, number], from, to);

      setStagedMoves(newStaged);
      setDisplayBoard(newDisplay);
      setSelectedSource(null);

      // Auto-submit if we hit the maximum legal moves possible for this board state.
      // (This safely handles situations where the player is blocked and can only
      // make < diceCount moves).
      if (newStaged.length >= maxLegalMoves) {
        void commitMove(newStaged.join(" "), game);
        setStagedMoves([]);
        setDisplayBoard(null);
      }
    },
    [game, stagedMoves, displayBoard, maxLegalMoves, commitMove],
  );

  const handlePointClick = useCallback(
    (point: number) => {
      if (!game?.dice || game.game_over || waitingForRollRef.current || waitingForMoveRef.current) return;
      const isMyTurn = game.turn === mySideRef.current;
      if (!isMyTurn) return;

      if (selectedSource === null) {
        // Clicking a source point.
        const side = mySideRef.current ?? 0;
        const hasBar = game.bar[side] > 0;
        if (hasBar) return; // must move from bar first
        const checker = game.board[point - 1];
        const isOwn = side === 0 ? checker > 0 : checker < 0;
        if (!isOwn) return;
        setSelectedSource(point);
      } else {
        stageMove(selectedSource, point);
        setSelectedSource(null);
      }
    },
    [game, selectedSource, stageMove],
  );

  const handleBarClick = useCallback(() => {
    if (!game?.dice || game.game_over || waitingForRollRef.current || waitingForMoveRef.current) return;
    if (game.turn !== mySideRef.current) return;
    const side = mySideRef.current ?? 0;
    if (game.bar[side] > 0) setSelectedSource(25); // 25 = bar sentinel
  }, [game]);

  const handleCubeClick = useCallback(() => {
    if (!game || game.game_over || waitingForRollRef.current || waitingForMoveRef.current) return;
    if (game.turn !== mySideRef.current) return;
    if (stagedMoves.length > 0) return;
    const canDouble = game.cubeOwner === -1 || game.cubeOwner === mySideRef.current;
    if (!canDouble) return;
    const offered = offerDouble(game);
    gameRef.current = offered;
    setGame(offered);
    sendMsg({ type: "double" });
    waitingForDoubleResponseRef.current = true;
  }, [game, stagedMoves.length, sendMsg]);

  const handleResign = useCallback(() => {
    if (!game || game.game_over) return;
    if (!window.confirm("Resign? You will be marked as the loser.")) return;
    const side = mySideRef.current ?? 0;
    const final = forceGameOver(game, (1 - side) as 0 | 1);
    gameRef.current = final;
    setGame(final);
    sendMsg({ type: "resign" });
  }, [game, sendMsg]);

  // ── Message handler ────────────────────────────────────────────────────
  const handleMsg = useCallback(
    async (raw: unknown) => {
      const msg = raw as WireMsg;
      const currentGame = gameRef.current;
      const mySideVal = mySideRef.current;

      if (msg.type === "roll") {
        if (!currentGame) return;
        try {
          const round = await fetchDrandRound(msg.roundNumber);
          const roll = deriveDice(`0x${round.randomness.replace(/^0x/, "")}` as `0x${string}`, msg.turnIndex, round.round);
          turnIndexRef.current = msg.turnIndex + 1;
          const withDice: MatchState = { ...currentGame, dice: [roll.d1, roll.d2] };
          gameRef.current = withDice;
          setGame(withDice);
          waitingForMoveRef.current = true;
          waitingForRollRef.current = false;
        } catch {/* ignore */}
      }

      if (msg.type === "move") {
        if (!currentGame) return;
        try {
          const next = applyMoveToState(currentGame, msg.move);
          if (next.position_id !== msg.positionId) {
            setPhaseError("Position desync — positions don't match. Game state is inconsistent.");
            return;
          }
          gameRef.current = next;
          setGame(next);
          waitingForMoveRef.current = false;

          if (!next.game_over && next.turn === mySideVal) {
            // My turn — roll.
            waitingForRollRef.current = false;
            await rollMyDice(next);
          } else if (!next.game_over && next.turn !== mySideVal) {
             // Opponent rolled a partial move and hasn't finished their turn yet.
             // Or they skipped. We wait for their next roll/move.
          }
        } catch {/* ignore */}
      }

      if (msg.type === "skip") {
        if (!currentGame) return;
        const skipped = skipTurn(currentGame);
        gameRef.current = skipped;
        setGame(skipped);
        waitingForMoveRef.current = false;
        waitingForRollRef.current = false;
        if (!skipped.game_over) {
          await rollMyDice(skipped);
        }
      }

      if (msg.type === "double") {
        if (!currentGame) return;
        const offered = offerDouble(currentGame);
        gameRef.current = offered;
        setGame(offered);
        setCubePrompt("accept-drop");
      }

      if (msg.type === "accept") {
        if (!currentGame) return;
        const accepted = acceptDouble(currentGame);
        gameRef.current = accepted;
        setGame(accepted);
        waitingForDoubleResponseRef.current = false;
        // Continue with my roll (I was the one who offered).
        await rollMyDice(accepted);
      }

      if (msg.type === "drop") {
        if (!currentGame || mySideVal === null) return;
        const dropped = dropDouble(currentGame);
        const final = dropped.game_over ? dropped : forceGameOver(currentGame, mySideVal);
        gameRef.current = final;
        setGame(final);
        waitingForDoubleResponseRef.current = false;
      }

      if (msg.type === "resign") {
        if (mySideVal === null) return;
        const final = forceGameOver(currentGame ?? newMatch(MATCH_LENGTH), mySideVal);
        gameRef.current = final;
        setGame(final);
      }

      if (msg.type === "result-sig") {
        oppResultSigRef.current = msg.resultSig;
        // If I've already signed, settle now.
        if (myResultSigRef.current && sessionAccount && address && oppInfo && myNonceUsed !== null && myAuthSig && oppAuthSig) {
          await settleMatch(
            gameRef.current ?? newMatch(MATCH_LENGTH),
            sessionAccount,
            address,
            oppInfo,
            myNonceUsed,
            myAuthSig,
            oppAuthSig,
            myResultSigRef.current,
            msg.resultSig,
          );
        }
      }
    },
    [rollMyDice, sessionAccount, address, oppInfo, myNonceUsed, myAuthSig, oppAuthSig, settleMatch],
  );

  // ── Handle doubling cube accept/drop (UI) ─────────────────────────────
  const handleAcceptDouble = useCallback(() => {
    if (!game) return;
    const accepted = acceptDouble(game);
    gameRef.current = accepted;
    setGame(accepted);
    setCubePrompt(null);
    sendMsg({ type: "accept" });
    // Opponent's turn continues (they offered, they play on after accept).
    waitingForMoveRef.current = true;
  }, [game, sendMsg]);

  const handleDropDouble = useCallback(() => {
    if (!game) return;
    const dropped = dropDouble(game);
    const final = dropped.game_over ? dropped : forceGameOver(game, (1 - (mySideRef.current ?? 0)) as 0 | 1);
    gameRef.current = final;
    setGame(final);
    setCubePrompt(null);
    sendMsg({ type: "drop" });
  }, [game, sendMsg]);

  // ── Mount: get peer connection ─────────────────────────────────────────
  useEffect(() => {
    const entry = peerMatches.get(matchId);
    if (!entry) return;
    const peer: PeerConnection = entry.peer;
    peerRef.current = peer;
    const cleanupMsg = peer.onMessage((raw) => void handleMsg(raw));
    return () => {
      cleanupMsg();
      peerRef.current = null;
    };
  }, [matchId, handleMsg]);

  // ── Phase 1: send hello when channel is open ──────────────────────────
  const helloSentRef = useRef(false);
  useEffect(() => {
    if (helloSentRef.current || !address || phase !== "connecting") return;
    const entry = peerMatches.get(matchId);
    if (!entry) return;

    // Listen for state open to send hello.
    const cleanupState = entry.peer.onState((s) => {
      if (s === "open" && !helloSentRef.current && address) {
        helloSentRef.current = true;
        const pk = generatePrivateKey();
        const acct = privateKeyToAccount(pk);
        setSessionAccount(acct);
        const hello: HelloMsg = {
          type: "hello",
          address,
          ensLabel: label ?? null,
          elo: Number(elo ?? "1500") || 1500,
          nonce: "0",     // placeholder — real nonce sent in auth phase
          sessionKey: acct.address,
        };
        entry.peer.send(hello);
      } else if (s === "failed" || s === "closed") {
        setPhase("error");
        setPhaseError("WebRTC connection lost.");
      }
    });

    // If already open (race: connection opened before this effect ran).
    if (!helloSentRef.current && address) {
      helloSentRef.current = true;
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      setSessionAccount(acct);
      const hello: HelloMsg = {
        type: "hello",
        address,
        ensLabel: label ?? null,
        elo: Number(elo ?? "1500") || 1500,
        nonce: "0",
        sessionKey: acct.address,
      };
      entry.peer.send(hello);
    }

    return () => cleanupState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, address, phase]);

  // ── Handle hello from opponent: set oppAddress, determine sides ────────
  const oppHelloRef = useRef<HelloMsg | null>(null);
  useEffect(() => {
    if (!address) return;
    const peerEntry = peerMatches.get(matchId);
    if (!peerEntry) return;

    const helloListener = (raw: unknown) => {
      const msg = raw as WireMsg;
      if (msg.type !== "hello") return;
      if (oppHelloRef.current) return; // already got it
      oppHelloRef.current = msg;
      setOppAddress(msg.address as `0x${string}`);
      setOppInfo({
        address: msg.address,
        ensLabel: msg.ensLabel,
        elo: msg.elo,
        nonce: msg.nonce,
        sessionKey: msg.sessionKey,
      });

      // Determine sides: lower address = side 0 (warm).
      const amILower = BigInt(address) < BigInt(msg.address);
      const side: 0 | 1 = amILower ? 0 : 1;
      setMySide(side);
      mySideRef.current = side;
    };

    // handleMsg is registered separately in the mount effect — only add
    // the hello-specific listener here so game messages are never dropped.
    const cleanupMsg = peerEntry.peer.onMessage(helloListener);
    return () => cleanupMsg();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, address]);

  // ── Phase 2: sign auth once we know opponent's address and nonce ───────
  const authSignedRef = useRef(false);
  useEffect(() => {
    if (authSignedRef.current) return;
    if (!address || !oppAddress || !sessionAccount || myNonce === undefined) return;
    if (!matchRegistry || matchRegistry === "0x0000000000000000000000000000000000000000") return;

    authSignedRef.current = true;
    setPhase("signing");

    const isALower = BigInt(address) < BigInt(oppAddress);
    const [selfAddr, oppAddr] = [address as `0x${string}`, oppAddress as `0x${string}`];

    const authHashRaw = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "string, uint256, address, address, address, uint256, uint16, address",
        ),
        [
          "Chaingammon:open-hvh",
          BigInt(chainId ?? 0),
          matchRegistry as `0x${string}`,
          selfAddr,
          oppAddr,
          myNonce,
          MATCH_LENGTH,
          sessionAccount.address as `0x${string}`,
        ],
      ),
    );

    void (async () => {
      try {
        const sig = await signMessageAsync({ message: { raw: authHashRaw } });
        setMyAuthSig(sig);
        setMyNonceUsed(myNonce);

        // Send auth phase 2 with real nonce + sig.
        const authMsg: AuthMsg = { type: "auth", authSig: sig };
        sendMsg(authMsg);

        // Also resend hello with real nonce so opponent can build the result hash.
        const hello2: HelloMsg = {
          type: "hello",
          address,
          ensLabel: label ?? null,
          elo: Number(elo ?? "1500") || 1500,
          nonce: myNonce.toString(),
          sessionKey: sessionAccount.address,
        };
        sendMsg(hello2);
      } catch {
        authSignedRef.current = false;
        setPhase("connecting");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, oppAddress, sessionAccount, myNonce, matchRegistry, chainId]);

  // ── Handle auth from opponent ──────────────────────────────────────────
  const oppAuthRef = useRef(false);
  useEffect(() => {
    if (oppAuthRef.current) return;
    const peerEntry = peerMatches.get(matchId);
    if (!peerEntry) return;

    const authListener = (raw: unknown) => {
      const msg = raw as WireMsg;
      if (msg.type === "hello" && oppHelloRef.current) {
        // Update opp nonce from second hello.
        setOppInfo((prev) =>
          prev ? { ...prev, nonce: (msg as HelloMsg).nonce } : prev,
        );
      }
      if (msg.type !== "auth") return;
      if (oppAuthRef.current) return;
      oppAuthRef.current = true;
      setOppAuthSig((msg as AuthMsg).authSig as `0x${string}`);
    };

    const cleanupMsg = peerEntry.peer.onMessage(authListener);
    return () => cleanupMsg();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // ── Start game once both auth sigs are in ─────────────────────────────
  const gameStartedRef = useRef(false);
  useEffect(() => {
    if (gameStartedRef.current) return;
    if (!myAuthSig || !oppAuthSig || mySideRef.current === null) return;

    gameStartedRef.current = true;
    setPhase("playing");

    const initial = newMatch(MATCH_LENGTH);
    gameRef.current = initial;
    setGame(initial);

    // Side 0 moves first.
    if (mySideRef.current === 0) {
      void rollMyDice(initial);
    } else {
      waitingForRollRef.current = true;
    }
  }, [myAuthSig, oppAuthSig, rollMyDice]);

  // ── Post-game: auto-sign and exchange result sigs ─────────────────────
  useEffect(() => {
    if (!game?.game_over) return;
    if (!sessionAccount || !address || !oppInfo || myNonceUsed === null) return;
    if (!myAuthSig || !oppAuthSig) return;
    if (myResultSigRef.current) return; // already signed

    void finishGame(game, sessionAccount, address, oppInfo, myNonceUsed, myAuthSig, oppAuthSig);
  }, [game?.game_over, sessionAccount, address, oppInfo, myNonceUsed, myAuthSig, oppAuthSig, finishGame]);

  // ── Render ─────────────────────────────────────────────────────────────
  const entry = peerMatches.get(matchId);
  if (!entry) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          gap: 16,
          fontFamily: "var(--cg-font-sans)",
          color: "var(--cg-fg-1)",
        }}
      >
        <p>No active connection for this match. Did you navigate here directly?</p>
        <Link href="/" style={{ color: "var(--cg-brass)" }}>
          ← Back to home
        </Link>
      </main>
    );
  }

  const currentBoard = displayBoard?.board ?? game?.board ?? [];
  const currentBar = (displayBoard?.bar ?? game?.bar ?? [0, 0]) as [number, number];
  const currentOff = (displayBoard?.off ?? game?.off ?? [0, 0]) as [number, number];

  const isMyTurn = game ? game.turn === mySideRef.current : false;
  const canInteract =
    phase === "playing" &&
    isMyTurn &&
    !!game?.dice &&
    !game.game_over &&
    !waitingForRollRef.current &&
    !waitingForMoveRef.current &&
    !waitingForDoubleResponseRef.current &&
    cubePrompt === null;

  const canOffer =
    canInteract &&
    stagedMoves.length === 0 &&
    (game?.cubeOwner === -1 || game?.cubeOwner === mySideRef.current);

  const oppLabel = oppLiveLabel || oppInfo?.ensLabel;
  const oppName = oppLabel
    ? `${oppLabel}.chaingammon.eth`
    : oppAddress
    ? `${oppAddress.slice(0, 8)}…`
    : "Opponent";

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 8px",
        minHeight: "100vh",
        background: "var(--cg-bg-1)",
        gap: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          width: "100%",
          maxWidth: 740,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Link
          href="/"
          style={{
            fontSize: 13,
            color: "var(--cg-fg-3)",
            fontFamily: "var(--cg-font-sans)",
            textDecoration: "none",
          }}
        >
          ← Home
        </Link>
        <span
          style={{
            fontSize: 13,
            fontFamily: "var(--cg-font-mono)",
            color: "var(--cg-fg-3)",
          }}
        >
          vs {oppName}
          {oppInfo?.elo ? ` · ELO ${oppInfo.elo}` : ""}
        </span>
      </div>

      {/* Phase banners */}
      {phase === "connecting" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Waiting for opponent…
        </p>
      )}
      {phase === "signing" && (
        <p style={{ fontSize: 14, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          Please sign in your wallet to authorize this match…
        </p>
      )}
      {(phase === "error" || phaseError) && (
        <p style={{ fontSize: 14, color: "var(--cg-danger)", fontFamily: "var(--cg-font-sans)" }}>
          {phaseError ?? "Connection error."}
        </p>
      )}

      {/* Board */}
      {(phase === "playing" || phase === "awaiting-result-sig" || phase === "settling" || phase === "settled" || game) && (
        <Board
          board={currentBoard}
          bar={currentBar}
          off={currentOff}
          turn={game?.turn ?? 0}
          isMyTurn={isMyTurn}
          opponentName={oppName}
          themeKey={themeKey}
          cubeValue={game?.cubeValue ?? 1}
          cubeOwner={game?.cubeOwner ?? -1}
          onCubeClick={canOffer ? handleCubeClick : undefined}
          selectedPoint={selectedSource}
          onPointClick={canInteract ? handlePointClick : undefined}
          onBarClick={canInteract ? handleBarClick : undefined}
          playerAvatarUrls={gameCoins}
        />
      )}

      {/* Dice */}
      {game?.dice && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <DiceRoll dice={game.dice} />
        </div>
      )}

      {/* Score */}
      {game && (
        <div style={{ fontSize: 13, fontFamily: "var(--cg-font-mono)", color: "var(--cg-fg-2)" }}>
          Score: {game.score[mySideRef.current ?? 0]} – {game.score[(1 - (mySideRef.current ?? 0)) as 0 | 1]}
          {" (first to "}{game.match_length}{")"}
        </div>
      )}

      {/* Double cube prompt */}
      {cubePrompt === "accept-drop" && (
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            padding: "12px 20px",
            borderRadius: "var(--cg-radius)",
            border: "1px solid var(--cg-brass)",
            background: "rgba(201,155,92,0.12)",
          }}
        >
          <span style={{ fontSize: 14, fontFamily: "var(--cg-font-sans)", color: "var(--cg-fg-1)" }}>
            Opponent doubled the cube to {game?.cubeValue ?? 2}. Accept or drop?
          </span>
          <button type="button" className="cg-btn-primary" onClick={handleAcceptDouble}>
            Accept
          </button>
          <button type="button" className="cg-chip" onClick={handleDropDouble}>
            Drop
          </button>
        </div>
      )}

      {/* Turn status */}
      {phase === "playing" && game && !game.game_over && (
        <p style={{ fontSize: 13, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          {isMyTurn
            ? waitingForDoubleResponseRef.current
              ? "Waiting for opponent to accept or drop…"
              : game.dice
              ? "Your turn — click a checker to move"
              : "Rolling dice…"
            : "Opponent's turn…"}
        </p>
      )}

      {/* Staged moves counter */}
      {stagedMoves.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}>
          {stagedMoves.length}/{maxLegalMoves} moves staged
        </p>
      )}

      {/* Actions */}
      {phase === "playing" && game && !game.game_over && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="cg-chip"
            onClick={handleResign}
          >
            Resign
          </button>
        </div>
      )}

      {/* Game over banner */}
      {game?.game_over && (
        <div
          style={{
            padding: "14px 20px",
            borderRadius: "var(--cg-radius)",
            border: "1px solid var(--cg-line-1)",
            background: "var(--cg-bg-2)",
            textAlign: "center",
            fontFamily: "var(--cg-font-sans)",
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, color: "var(--cg-fg-1)" }}>
            {game.winner === mySideRef.current ? "You win!" : "Opponent wins"}
          </p>
          <p style={{ fontSize: 13, color: "var(--cg-fg-3)", marginTop: 4 }}>
            {phase === "awaiting-result-sig" && "Waiting for opponent to co-sign result…"}
            {phase === "settling" && "Submitting settlement…"}
            {phase === "settled" && `Settled on-chain ✓${settleTxHash ? ` · tx ${settleTxHash.slice(0, 10)}…` : ""}`}
            {phase === "error" && `Settlement failed: ${settleError ?? "unknown"}`}
          </p>
          <Link href="/" style={{ display: "inline-block", marginTop: 12, color: "var(--cg-brass)" }}>
            Back to home
          </Link>
        </div>
      )}
    </main>
  );
}

export default function PlayHumanClient() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            color: "var(--cg-fg-3)",
            fontFamily: "var(--cg-font-sans)",
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
