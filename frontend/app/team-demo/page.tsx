// Phase K.5: team-mode advisor signal live demo.
//
// Enhanced version: teammate + opponent selection, interactive board,
// and LLM coaching window (0G Compute). No on-chain settlement.
"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useAccount, useReadContract, useReadContracts } from "wagmi";

import { Board } from "../Board";
import { AgentTeammatePanel } from "../ChiefOfStaffPanel";
import { DiceRoll } from "../DiceRoll";
import { rollDice } from "../dice";
import { useActiveChain, useActiveChainId } from "../chains";
import { AgentRegistryABI, MatchRegistryABI, useChainContracts } from "../contracts";
import {
  type MatchState,
  newMatch,
  applyMoveToState,
  getBestMove,
  skipTurn,
  playMatchToEnd,
  resignMatch,
} from "../../lib/match_engine";
import { type Board as GameBoard } from "../../lib/rules_engine";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

// ── Types ──────────────────────────────────────────────────────────────────

interface AgentRow {
  agent_id: number;
  weights_hash: string;
  match_count: number;
  tier: number;
}

interface AdvisorSignal {
  teammate_id: string;
  proposed_move: string;
  confidence: number;
  message?: string;
}

interface AdvisorSnapshot {
  signals: AdvisorSignal[];
  captain_id: string | null;
  move_idx: number;
  team_mode: boolean;
}

/**
 * Apply one checker movement to board/bar/off and return the new state.
 * Player 0 (human) is always the mover.
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

  if (from === "bar") {
    newBar[0] = Math.max(0, newBar[0] - 1);
  } else {
    newBoard[from - 1] -= 1;
  }

  if (to === "off") {
    newOff[0] += 1;
  } else {
    if (newBoard[to - 1] === -1) {
      newBoard[to - 1] = 0;
      newBar[1] += 1;
    }
    newBoard[to - 1] += 1;
  }

  return { board: newBoard, bar: newBar, off: newOff };
}

// ── Shared style helpers ───────────────────────────────────────────────────

const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "var(--cg-fg-3)",
  fontFamily: "var(--cg-font-sans)",
};

const card: React.CSSProperties = {
  background: "var(--cg-bg-2)",
  border: "1px solid var(--cg-line-2)",
  borderRadius: "var(--cg-radius)",
  boxShadow: "var(--cg-shadow-1)",
};

// ── Component ─────────────────────────────────────────────────────────────

export default function TeamDemoPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{ color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}
          className="flex flex-1 items-center justify-center"
        >
          Loading…
        </div>
      }
    >
      <TeamDemoPageInner />
    </Suspense>
  );
}

function TeamDemoPageInner() {
  const params = useSearchParams();
  const router = useRouter();

  const opponentsParam = params.get("opponents");
  const teammatesParam = params.get("teammates");
  const initialOpponents = opponentsParam
    ? opponentsParam.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const initialTeammates = teammatesParam
    ? teammatesParam.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const hasUrlParams = initialOpponents.length > 0;
  const settleOnChain = params.get("settle") === "1";

  const [setup, setSetup] = useState(!hasUrlParams);
  const [teammateIds, setTeammateIds] = useState<number[]>(initialTeammates);
  const [opponentIds, setOpponentIds] = useState<number[]>(initialOpponents);

  const [game, setGame] = useState<MatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  const [stagedMoves, setStagedMoves] = useState<string[]>([]);
  const [displayBoardState, setDisplayBoardState] = useState<{
    board: number[];
    bar: [number, number];
    off: [number, number];
  } | null>(null);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);

  const [fastForward, setFastForward] = useState(false);

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [keeperMatchId, setKeeperMatchId] = useState<number | null>(null);
  const [keeperRunning, setKeeperRunning] = useState(false);

  const { address } = useAccount();
  const chainId = useActiveChainId();
  const activeChain = useActiveChain();
  const { agentRegistry, matchRegistry } = useChainContracts();

  const primaryOpponentId = opponentIds[0];
  const eloQuery = useReadContracts({
    contracts: primaryOpponentId ? [{
      address: matchRegistry,
      abi: MatchRegistryABI,
      functionName: "agentElo",
      args: [BigInt(primaryOpponentId)],
      chainId,
    }] : [],
    query: { enabled: !!primaryOpponentId, refetchInterval: 15000 },
  });
  const opponentElo = eloQuery.data?.[0]?.result as bigint | undefined;

  const agentMoving = useRef(false);
  const autoStarted = useRef(false);

  useEffect(() => {
    if (!hasUrlParams || autoStarted.current || game) return;
    if (initialOpponents.length === 0) return;
    autoStarted.current = true;
    try {
      const state = newMatch(3);
      setGame({ ...state, dice: rollDice() });
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    let origX: number, origY: number;
    if (panelPos) {
      origX = panelPos.x;
      origY = panelPos.y;
    } else {
      const rect = panelRef.current?.getBoundingClientRect();
      origX = rect?.left ?? 0;
      origY = rect?.top ?? 0;
    }
    dragState.current = { startX: e.clientX, startY: e.clientY, origX, origY };
    if (!panelPos) setPanelPos({ x: origX, y: origY });
  };

  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    setPanelPos({
      x: dragState.current.origX + (e.clientX - dragState.current.startX),
      y: dragState.current.origY + (e.clientY - dragState.current.startY),
    });
  };

  const onDragEnd = () => { dragState.current = null; };

  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = panelRef.current?.getBoundingClientRect();
    const origW = panelSize?.w ?? rect?.width ?? 320;
    const origH = panelSize?.h ?? rect?.height ?? 480;
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW, origH };
    if (!panelPos) {
      setPanelPos({ x: rect?.left ?? 0, y: rect?.top ?? 0 });
    }
  };

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return;
    const w = Math.max(280, resizeState.current.origW + (e.clientX - resizeState.current.startX));
    const h = Math.max(200, resizeState.current.origH + (e.clientY - resizeState.current.startY));
    setPanelSize({ w, h });
  };

  const onResizeEnd = () => { resizeState.current = null; };

  // Agent list comes straight from the AgentRegistry on the wallet's
  // current chain — same shape as the legacy `/agents` server endpoint
  // (`agent_id`, `weights_hash`, `match_count`, `tier`) so the rest of
  // this page is unchanged. Reading on-chain keeps the Pages build
  // self-contained: no FastAPI backend required.
  const { data: activeAgentCountRaw } = useReadContract({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentCount",
    chainId,
    query: { enabled: !!activeChain },
  });
  const agentCount =
    activeAgentCountRaw !== undefined ? Number(activeAgentCountRaw) : 0;

  const agentIndexCalls = Array.from({ length: agentCount }, (_, i) => ({
    address: agentRegistry,
    abi: AgentRegistryABI,
    functionName: "activeAgentAt" as const,
    args: [BigInt(i)] as [bigint],
    chainId,
  }));
  const { data: agentIndexResults } = useReadContracts({
    contracts: agentIndexCalls,
    query: { enabled: !!activeChain && agentCount > 0 },
  });
  const onChainAgentIds = (agentIndexResults ?? [])
    .map((r) => r?.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined)
    .map((v) => Number(v));

  // One multicall covers dataHashes + matchCount + tier for every agent.
  const agentDetailCalls = onChainAgentIds.flatMap((id) => {
    const args = [BigInt(id)] as [bigint];
    return [
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "dataHashes" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "matchCount" as const, args, chainId },
      { address: agentRegistry, abi: AgentRegistryABI, functionName: "tier" as const, args, chainId },
    ];
  });
  const { data: agentDetailResults } = useReadContracts({
    contracts: agentDetailCalls,
    query: { enabled: onChainAgentIds.length > 0 },
  });

  const agents: AgentRow[] = onChainAgentIds.map((agent_id, i) => {
    const base = i * 3;
    const hashes = agentDetailResults?.[base]?.result as
      | readonly [`0x${string}`, `0x${string}`]
      | undefined;
    const matchCountRaw = agentDetailResults?.[base + 1]?.result as
      | number
      | bigint
      | undefined;
    const tierRaw = agentDetailResults?.[base + 2]?.result as
      | number
      | undefined;
    return {
      agent_id,
      weights_hash: hashes?.[1] ?? "",
      match_count:
        typeof matchCountRaw === "bigint"
          ? Number(matchCountRaw)
          : matchCountRaw ?? 0,
      tier: tierRaw ?? 0,
    };
  });

  const startTrainingGame = () => {
    if (opponentIds.length === 0) return;
    setSetup(false);
    setLoading(true);
    try {
      const state = newMatch(3);
      setGame({ ...state, dice: rollDice() });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (fastForward || setup || !game || game.game_over) return;
    if (game.turn !== 1) return;
    if (!game.dice) return;

    const timer = setTimeout(async () => {
      if (agentMoving.current) return;
      agentMoving.current = true;
      try {
        const board: GameBoard = { points: game.board, bar: game.bar, off: game.off };
        const best = await getBestMove(board, 1, game.dice!);
        if (!best) {
          const skipped = skipTurn(game);
          setGame(skipped.game_over ? skipped : { ...skipped, dice: rollDice() });
          return;
        }
        const next = applyMoveToState(game, best);
        setGame(next.game_over ? next : { ...next, dice: rollDice() });
      } catch (e) {
        setError(String(e));
      } finally {
        agentMoving.current = false;
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [game, setup, fastForward]);

  useEffect(() => {
    if (!fastForward || !game || game.game_over) return;
    if (agentMoving.current) return;
    let cancelled = false;
    agentMoving.current = true;
    void (async () => {
      try {
        const final = await playMatchToEnd(game);
        if (!cancelled) {
          setGame(final);
          setFastForward(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setFastForward(false);
        }
      } finally {
        agentMoving.current = false;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fastForward]);

  const doFinalizeAndTriggerKeeper = async (g: typeof game) => {
    if (!g?.game_over) return;
    const agentId = opponentIds[0];
    if (!agentId) return;
    if (finalizing || keeperMatchId !== null) return;
    setFinalizing(true);
    setFinalizeError(null);
    window.localStorage.removeItem("keeperMatchId");
    const ZERO = "0x0000000000000000000000000000000000000000";
    try {
      const humanWins = g.winner === 0;
      const body = {
        winner_agent_id: humanWins ? 0 : agentId,
        winner_human_address: humanWins && address ? address : ZERO,
        loser_agent_id: humanWins ? agentId : 0,
        loser_human_address: !humanWins && address ? address : ZERO,
        match_length: g.match_length,
        position_id: g.position_id,
        gnubg_match_id: g.match_id,
        score: g.score,
      };
      const res = await fetch(`${SERVER}/finalize-direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text);
      }
      const data = (await res.json()) as { match_id: number };
      setKeeperMatchId(data.match_id);
      window.localStorage.setItem("keeperMatchId", String(data.match_id));
      setKeeperRunning(true);
      fetch(`${SERVER}/keeper-workflow/${data.match_id}/run?stake_wei=0`, { method: "POST" })
        .finally(() => setKeeperRunning(false));
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinalizing(false);
    }
  };

  useEffect(() => {
    if (game?.game_over && settleOnChain && opponentIds.length > 0) {
      void doFinalizeAndTriggerKeeper(game);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.game_over]);

  const doMoveWithNotation = async (notation: string) => {
    if (!game || !game.dice) return;
    setLoading(true);
    try {
      const next = applyMoveToState(game, notation);
      setGame(next.game_over ? next : { ...next, dice: rollDice() });
      setStagedMoves([]);
      setDisplayBoardState(null);
      setMoveInput("");
      setSelectedSource(null);
    } catch (e) {
      setError(String(e));
      setStagedMoves([]);
      setDisplayBoardState(null);
    } finally {
      setLoading(false);
    }
  };

  const doForfeit = () => {
    if (!game || game.game_over) return;
    if (!window.confirm("Resign this match? You'll be marked as the loser.")) return;
    try {
      setGame(resignMatch(game));
    } catch (e) {
      setError(String(e));
    }
  };

  const diceCount = game?.dice ? (game.dice[0] === game.dice[1] ? 4 : 2) : 0;

  const stageMove = (from: number | "bar", to: number | "off") => {
    if (!game || !game.dice) return;
    const fromStr = from === "bar" ? "bar" : String(from);
    const toStr = to === "off" ? "off" : String(to);
    const seg = `${fromStr}/${toStr}`;
    const newStaged = [...stagedMoves, seg];

    const curBoard = displayBoardState?.board ?? game.board;
    const curBar = displayBoardState?.bar ?? game.bar;
    const curOff = displayBoardState?.off ?? game.off;
    const newDisplay = applyMoveSegment(curBoard, curBar, curOff, from, to);

    setStagedMoves(newStaged);
    setDisplayBoardState(newDisplay);
    setSelectedSource(null);

    if (newStaged.length >= diceCount) {
      void doMoveWithNotation(newStaged.join(" "));
    }
  };

  const currentBoard = displayBoardState?.board ?? game?.board ?? [];
  const currentBar = (displayBoardState?.bar ?? game?.bar ?? [0, 0]) as [number, number];
  const currentOff = (displayBoardState?.off ?? game?.off ?? [0, 0]) as [number, number];
  const isHumanTurn = game?.turn === 0;

  const previewMove = (notation: string) => {
    if (!game) return;
    setMoveInput(notation);

    try {
      let b = [...game.board];
      let r: [number, number] = [...game.bar] as [number, number];
      let o: [number, number] = [...game.off] as [number, number];

      const segments = notation.split(/\s+/).filter(Boolean);
      for (const seg of segments) {
        const parts = seg.split("/");
        if (parts.length !== 2) continue;
        const from = parts[0] === "bar" ? "bar" : parseInt(parts[0]);
        const to = parts[1] === "off" ? "off" : parseInt(parts[1]);

        const next = applyMoveSegment(b, r, o, from as any, to as any);
        b = next.board;
        r = next.bar;
        o = next.off;
      }
      setDisplayBoardState({ board: b, bar: r, off: o });
      setStagedMoves(segments);
    } catch (e) {
      console.warn("Failed to preview move notation:", e);
    }
  };

  // ── Setup screen ──────────────────────────────────────────────────────────

  if (setup) {
    const onClickSetupStart = () => {
      if (opponentIds.length === 0) return;
      if (settleOnChain) {
        router.push(`/match?agentId=${opponentIds[0]}`);
      } else {
        startTrainingGame();
      }
    };

    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-8">
        <header className="flex flex-col gap-2">
          <h1
            style={{ color: "var(--cg-fg-1)", fontWeight: 500, fontSize: 24, fontFamily: "var(--cg-font-sans)" }}
          >
            {settleOnChain ? "On-chain game" : "Off-chain game"}
          </h1>
          <p style={{ color: "var(--cg-fg-2)", fontSize: 14 }}>
            {settleOnChain
              ? "Pick your opponent, then review the KeeperHub settlement terms before the match starts. Your rating is updated on-chain when the game ends."
              : "Configure a training match (no settlement). Play alongside an AI teammate against an opposing agent."}
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 style={eyebrow}>
            Choose your teammate{" "}
            <span style={{ textTransform: "none", fontWeight: 400, color: "var(--cg-fg-4)" }}>
              (optional — skip to play solo)
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => {
              const active = teammateIds.includes(a.agent_id);
              const isOpponent = opponentIds.includes(a.agent_id);
              return (
                <button
                  key={a.agent_id}
                  type="button"
                  disabled={isOpponent}
                  onClick={() => {
                    if (active) {
                      setTeammateIds((prev) => prev.filter((id) => id !== a.agent_id));
                    } else {
                      setTeammateIds((prev) => [...prev, a.agent_id]);
                    }
                  }}
                  style={{
                    borderRadius: "var(--cg-radius)",
                    border: `1px solid ${active ? "var(--cg-brass)" : "var(--cg-line-2)"}`,
                    background: active ? "rgba(201,155,92,0.12)" : "var(--cg-bg-2)",
                    color: active ? "var(--cg-brass-hi)" : "var(--cg-fg-2)",
                    fontFamily: "var(--cg-font-mono)",
                    fontSize: 12,
                    padding: "6px 12px",
                    cursor: "pointer",
                    transition: "border-color 120ms, background 120ms",
                  }}
                  className="disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Agent #{a.agent_id}
                  {isOpponent && (
                    <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>(Opp)</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 style={eyebrow}>Choose opponents</h2>
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => {
              const active = opponentIds.includes(a.agent_id);
              const isTeammate = teammateIds.includes(a.agent_id);
              return (
                <button
                  key={a.agent_id}
                  type="button"
                  disabled={isTeammate}
                  onClick={() => {
                    if (active)
                      setOpponentIds(opponentIds.filter((id) => id !== a.agent_id));
                    else setOpponentIds([...opponentIds, a.agent_id]);
                  }}
                  style={{
                    borderRadius: "var(--cg-radius)",
                    border: `1px solid ${active ? "var(--cg-fg-1)" : "var(--cg-line-2)"}`,
                    background: active ? "var(--cg-bg-3)" : "var(--cg-bg-2)",
                    color: active ? "var(--cg-fg-1)" : "var(--cg-fg-2)",
                    fontFamily: "var(--cg-font-mono)",
                    fontSize: 12,
                    padding: "6px 12px",
                    cursor: "pointer",
                    transition: "border-color 120ms, background 120ms",
                  }}
                  className="disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Agent #{a.agent_id}
                  {isTeammate && (
                    <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>(Team)</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <button
          onClick={onClickSetupStart}
          disabled={opponentIds.length === 0}
          style={{
            background: "var(--cg-brass)",
            color: "var(--cg-brass-ink)",
            borderRadius: "var(--cg-radius)",
            boxShadow: "var(--cg-shadow-1)",
            padding: "12px 24px",
            fontSize: 15,
            fontWeight: 600,
            fontFamily: "var(--cg-font-sans)",
            cursor: "pointer",
            border: "none",
            transition: "background 120ms",
          }}
          className="disabled:opacity-40"
        >
          {settleOnChain ? "Next: KeeperHub setup →" : "Start off-chain game"}
        </button>
      </main>
    );
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading && !game) {
    return (
      <div
        style={{ color: "var(--cg-fg-3)", fontFamily: "var(--cg-font-sans)" }}
        className="flex flex-1 items-center justify-center"
      >
        Loading board…
      </div>
    );
  }

  // ── Game screen ───────────────────────────────────────────────────────────

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 lg:flex-row">
      <div className="flex flex-1 flex-col gap-6">
        {/* Match header */}
        <header
          style={{ borderBottom: "1px solid var(--cg-line-2)", paddingBottom: 16 }}
          className="flex items-center justify-between"
        >
          <h1
            style={{
              fontFamily: "var(--cg-font-mono)",
              fontSize: 13,
              color: "var(--cg-fg-3)",
            }}
          >
            {(() => {
              const prefix = settleOnChain ? "Official game" : "Off-chain game";
              const oppLabel = primaryOpponentId
                ? `Agent ${primaryOpponentId}${opponentElo !== undefined ? ` (ELO ${opponentElo})` : ""}`
                : `Agents [${opponentIds.join(",")}]`;
              const matchup = teammateIds.length > 0
                ? `You + [${teammateIds.join(",")}] v. ${oppLabel}`
                : `You v. ${oppLabel}`;
              return `${prefix}: ${matchup}`;
            })()}
          </h1>
        </header>

        {game && (
          <div className="flex flex-col gap-6">
            <Board
              board={currentBoard}
              bar={currentBar}
              off={currentOff}
              turn={game.turn}
              opponentName={
                opponentIds.length === 1
                  ? `Agent #${opponentIds[0]}`
                  : `Agents [${opponentIds.join(",")}]`
              }
              onPointClick={isHumanTurn ? (pt) => {
                if (selectedSource === null) {
                  if (currentBar[0] > 0) return;
                  if (currentBoard[pt - 1] > 0) setSelectedSource(pt);
                } else if (selectedSource === pt) setSelectedSource(null);
                else stageMove(selectedSource === 25 ? "bar" : selectedSource, pt);
              } : undefined}
              onBarClick={isHumanTurn && currentBar[0] > 0 ? () => setSelectedSource(25) : undefined}
              onOffClick={isHumanTurn && selectedSource !== null ? () => stageMove(selectedSource === 25 ? "bar" : selectedSource, "off") : undefined}
              selectedPoint={selectedSource}
            />

            {game.dice && (
              <div className="flex items-center gap-3">
                <span style={{ color: "var(--cg-fg-3)", fontSize: 13 }}>Rolled:</span>
                <DiceRoll dice={game.dice} />
              </div>
            )}

            {stagedMoves.length > 0 && (
              <div className="flex items-center gap-3">
                <p style={{ color: "var(--cg-brass)", fontSize: 12 }}>
                  {stagedMoves.length}/{diceCount} moves staged
                </p>
                <button
                  onClick={() => {
                    setStagedMoves([]);
                    setDisplayBoardState(null);
                    setSelectedSource(null);
                  }}
                  style={{ color: "var(--cg-fg-3)", fontSize: 12, background: "none", border: "none", cursor: "pointer" }}
                  className="underline"
                >
                  Undo
                </button>
                {stagedMoves.length > 0 && (
                  <button
                    onClick={() => void doMoveWithNotation(stagedMoves.join(" "))}
                    style={{
                      background: "var(--cg-brass)",
                      color: "var(--cg-brass-ink)",
                      borderRadius: "var(--cg-radius-sm)",
                      padding: "4px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      cursor: "pointer",
                      boxShadow: "var(--cg-shadow-1)",
                    }}
                  >
                    Commit move
                  </button>
                )}
              </div>
            )}

            {error && (
              <p style={{ color: "var(--cg-danger)", fontSize: 14 }}>{error}</p>
            )}

            {(!isHumanTurn || fastForward) && !game.game_over && (
              <p
                style={{ color: "var(--cg-fg-3)", fontSize: 14 }}
                className="animate-pulse"
              >
                {fastForward ? "Fast forwarding…" : "Opponent team is thinking…"}
              </p>
            )}

            {!game.game_over && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFastForward(true)}
                  disabled={loading || fastForward}
                  style={{
                    border: "1px solid var(--cg-line-2)",
                    borderRadius: "var(--cg-radius-sm)",
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--cg-fg-2)",
                    background: "var(--cg-bg-2)",
                    cursor: "pointer",
                    transition: "background 120ms",
                  }}
                  className="disabled:opacity-50"
                >
                  {fastForward ? "Fast forwarding…" : "Fast forward"}
                </button>
                <button
                  type="button"
                  onClick={doForfeit}
                  disabled={loading || fastForward}
                  style={{
                    border: "1px solid var(--cg-danger)",
                    borderRadius: "var(--cg-radius-sm)",
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--cg-danger)",
                    background: "transparent",
                    cursor: "pointer",
                    transition: "background 120ms",
                    opacity: 0.85,
                  }}
                  className="disabled:opacity-50"
                >
                  Resign
                </button>
              </div>
            )}

            {game.game_over && (
              <div style={{ ...card, padding: 16 }}>
                <p
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: game.winner === 0 ? "var(--cg-brass-hi)" : "var(--cg-fg-2)",
                    fontFamily: "var(--cg-font-sans)",
                  }}
                >
                  {game.winner === 0
                    ? teammateIds.length > 0
                      ? "Your team wins."
                      : "You win."
                    : primaryOpponentId
                    ? `Agent ${primaryOpponentId} wins.`
                    : "Opponents win."}
                </p>

                {keeperMatchId !== null ? (
                  <div
                    style={{
                      marginTop: 12,
                      borderRadius: "var(--cg-radius-sm)",
                      background: "rgba(125,155,74,0.12)",
                      border: "1px solid rgba(125,155,74,0.30)",
                      padding: "8px 12px",
                    }}
                  >
                    <p style={{ fontSize: 14, fontWeight: 600, color: "var(--cg-success)" }}>
                      Match settled. Rating updated.
                    </p>
                    <Link
                      href="/keeper/no-match"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ marginTop: 4, display: "block", fontSize: 12, color: "var(--cg-brass)" }}
                    >
                      View KeeperHub audit trail ↗
                    </Link>
                    {keeperRunning && (
                      <p style={{ marginTop: 4, fontSize: 12, color: "var(--cg-fg-3)" }}>
                        Workflow running…
                      </p>
                    )}
                  </div>
                ) : finalizing ? (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 14, color: "var(--cg-fg-3)" }} className="animate-pulse">
                      Settling…
                    </p>
                    <Link
                      href="/keeper/no-match"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ marginTop: 4, display: "block", fontSize: 12, color: "var(--cg-brass)" }}
                    >
                      View KeeperHub audit trail ↗
                    </Link>
                  </div>
                ) : finalizeError ? (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 12, color: "var(--cg-danger)" }}>
                      Settlement failed: {finalizeError}
                    </p>
                    <button
                      type="button"
                      onClick={() => void doFinalizeAndTriggerKeeper(game)}
                      style={{
                        marginTop: 8,
                        background: "var(--cg-brass)",
                        color: "var(--cg-brass-ink)",
                        borderRadius: "var(--cg-radius-sm)",
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Advisor panel — floatable and resizable */}
      <div
        ref={panelRef}
        style={{
          ...(panelPos
            ? { position: "fixed", left: panelPos.x, top: panelPos.y, zIndex: 50, width: panelSize?.w ?? 320, height: panelSize?.h ?? 560 }
            : { width: panelSize?.w, height: panelSize?.h ?? 560 }),
          ...card,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          ...(panelPos ? { boxShadow: "var(--cg-shadow-2)" } : {}),
        }}
        className="w-full lg:w-80"
      >
        {/* Drag handle */}
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          style={{
            flexShrink: 0,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--cg-bg-3)",
            borderBottom: "1px solid var(--cg-line-1)",
            cursor: "grab",
            userSelect: "none",
          }}
          title="Drag to move panel"
        >
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              background: "var(--cg-line-3)",
            }}
          />
        </div>

        {/* Scrollable advisor area */}
        <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
          {game && (
            <AgentTeammatePanel
              positionId={game.position_id}
              matchId={game.match_id}
              dice={game.dice}
              board={game.board}
              bar={game.bar}
              off={game.off}
              turn={game.turn}
              opponentId={opponentIds[0]}
              disabled={!isHumanTurn || game.game_over}
              onMoveSelect={previewMove}
              noLLM={teammateIds.length === 0}
            />
          )}
        </div>

        {/* Manual move — pinned above resize handle */}
        {isHumanTurn && !game?.game_over && (
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              borderTop: "1px solid var(--cg-line-1)",
              background: "var(--cg-bg-2)",
              padding: 12,
            }}
          >
            <h3 style={eyebrow}>Manual move</h3>
            <div className="flex gap-2">
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                placeholder='e.g. "8/5 6/5"'
                style={{
                  flex: 1,
                  borderRadius: "var(--cg-radius-sm)",
                  border: "1px solid var(--cg-line-2)",
                  background: "var(--cg-bg-1)",
                  color: "var(--cg-fg-1)",
                  fontFamily: "var(--cg-font-mono)",
                  fontSize: 13,
                  padding: "6px 10px",
                  outline: "none",
                }}
              />
              <button
                onClick={() => doMoveWithNotation(moveInput)}
                disabled={!moveInput.trim() || loading}
                style={{
                  background: "var(--cg-brass)",
                  color: "var(--cg-brass-ink)",
                  borderRadius: "var(--cg-radius-sm)",
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                }}
                className="disabled:opacity-40"
              >
                Go
              </button>
            </div>
          </div>
        )}

        {/* Resize handle */}
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          style={{
            flexShrink: 0,
            height: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            background: "var(--cg-bg-3)",
            borderTop: "1px solid var(--cg-line-1)",
            paddingRight: 8,
            cursor: "nwse-resize",
            userSelect: "none",
          }}
          title="Drag to resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ color: "var(--cg-line-3)" }}>
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </main>
  );
}
