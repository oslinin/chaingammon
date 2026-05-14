// Phase K.5: team-mode advisor signal live demo.
//
// Enhanced version: teammate + opponent selection, interactive board,
// and LLM coaching window (0G Compute). No on-chain settlement.
"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { Board } from "../Board";
import { AgentTeammatePanel } from "../ChiefOfStaffPanel";
import { DiceRoll } from "../DiceRoll";
import { rollDice } from "../dice";
import { useComputeBackends } from "../ComputeBackendsContext";
import {
  type MatchState,
  newMatch,
  applyMoveToState,
  getBestMove,
  skipTurn,
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

// ── Component ─────────────────────────────────────────────────────────────

export default function TeamDemoPage() {
  const [setup, setSetup] = useState(true);
  const [teammateIds, setTeammateIds] = useState<number[]>([]);
  const [opponentIds, setOpponentIds] = useState<number[]>([]);

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

  const agentMoving = useRef(false);

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

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: async (): Promise<AgentRow[]> => {
      const r = await fetch(`${SERVER}/agents`);
      if (!r.ok) throw new Error(`/agents → ${r.status}`);
      return r.json();
    },
  });

  const startTrainingGame = () => {
    if (teammateIds.length === 0 || opponentIds.length === 0) return;
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
    if (setup || !game || game.game_over || agentMoving.current) return;
    if (game.turn !== 1) return;
    if (!game.dice) return;

    agentMoving.current = true;
    const step = async () => {
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
    };
    const timer = setTimeout(step, 800);
    return () => clearTimeout(timer);
  }, [game, setup]);

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

  if (setup) {
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Team training game
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Configure a training match (no settlement). Play alongside an AI
            teammate against an opposing team of agents.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Choose your Teammate
          </h2>
          <div className="flex flex-wrap gap-2">
            {agentsQuery.data?.map((a) => {
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
                  className={`rounded-md border px-3 py-1.5 text-xs font-mono disabled:opacity-30 disabled:cursor-not-allowed ${
                    active
                      ? "border-indigo-600 bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
                      : "border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  }`}
                >
                  Agent #{a.agent_id}
                  {isOpponent && <span className="ml-1 text-[10px] opacity-60">(Opp)</span>}
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Choose Opponents
          </h2>
          <div className="flex flex-wrap gap-2">
            {agentsQuery.data?.map((a) => {
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
                  className={`rounded-md border px-3 py-1.5 text-xs font-mono disabled:opacity-30 disabled:cursor-not-allowed ${
                    active
                      ? "border-red-600 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100"
                      : "border-zinc-300 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  }`}
                >
                  Agent #{a.agent_id}
                  {isTeammate && <span className="ml-1 text-[10px] opacity-60">(Team)</span>}
                </button>
              );
            })}
          </div>
        </section>

        <button
          onClick={startTrainingGame}
          disabled={teammateIds.length === 0 || opponentIds.length === 0}
          className="rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow hover:bg-indigo-500 disabled:opacity-40"
        >
          Start Training Game
        </button>
      </main>
    );
  }

  if (loading && !game) {
    return <div className="flex flex-1 items-center justify-center">Loading board…</div>;
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 lg:flex-row">
      <div className="flex flex-1 flex-col gap-6">
        <header className="flex items-center justify-between border-b border-zinc-200 pb-4 dark:border-zinc-800">
          <h1 className="font-mono text-sm text-zinc-500">
            Training: You + [{teammateIds.join(",")}] vs. [{opponentIds.join(",")}]
          </h1>
          <button 
            onClick={() => setSetup(true)}
            className="text-xs text-indigo-600 underline"
          >
            Reset
          </button>
        </header>

        {game && (
          <div className="flex flex-col gap-6">
            <Board
              board={currentBoard}
              bar={currentBar}
              off={currentOff}
              turn={game.turn}
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
                <span className="text-sm text-zinc-500">Rolled:</span>
                <DiceRoll dice={game.dice} />
              </div>
            )}

            {stagedMoves.length > 0 && (
              <div className="flex items-center gap-3">
                <p className="text-xs text-indigo-600">
                  {stagedMoves.length}/{diceCount} moves staged
                </p>
                <button
                  onClick={() => {
                    setStagedMoves([]);
                    setDisplayBoardState(null);
                    setSelectedSource(null);
                  }}
                  className="text-xs text-zinc-500 underline"
                >
                  Undo
                </button>
                {stagedMoves.length > 0 && (
                  <button
                    onClick={() => void doMoveWithNotation(stagedMoves.join(" "))}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                  >
                    Commit Move
                  </button>
                )}
              </div>
            )}

            {!isHumanTurn && !game.game_over && (
              <p className="text-sm text-zinc-500 animate-pulse">Opponent team is thinking…</p>
            )}

            {game.game_over && (
              <div className="rounded-lg bg-indigo-50 p-4 dark:bg-indigo-900/20">
                <p className="text-lg font-bold text-indigo-700 dark:text-indigo-300">
                  Game Over! {game.winner === 0 ? "Your team wins!" : "Opponent team wins."}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div
        ref={panelRef}
        style={panelPos
          ? { position: "fixed", left: panelPos.x, top: panelPos.y, zIndex: 50, width: panelSize?.w ?? 320, height: panelSize?.h ?? 560 }
          : { width: panelSize?.w, height: panelSize?.h ?? 560 }}
        className={`w-full lg:w-80 flex flex-col${panelPos ? " shadow-2xl rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" : ""}`}
      >
        {/* Drag handle — grab to float and reposition */}
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          className="flex h-6 shrink-0 cursor-grab items-center justify-center rounded-t-xl bg-zinc-100 select-none active:cursor-grabbing dark:bg-zinc-800"
          title="Drag to move panel"
        >
          <div className="h-1 w-10 rounded-full bg-zinc-400 dark:bg-zinc-500" />
        </div>

        {/* Scrollable chat area */}
        <div className="flex flex-1 overflow-y-auto min-h-0">
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
            />
          )}
        </div>

        {/* Manual Move — pinned above the resize handle */}
        {isHumanTurn && !game?.game_over && (
          <div className="shrink-0 flex flex-col gap-2 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Manual Move</h3>
            <div className="flex gap-2">
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                placeholder='e.g. "8/5 6/5"'
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                onClick={() => doMoveWithNotation(moveInput)}
                disabled={!moveInput.trim() || loading}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"
              >
                Go
              </button>
            </div>
          </div>
        )}

        {/* Resize handle — drag in any direction to resize width and/or height */}
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          className="flex h-4 shrink-0 cursor-nwse-resize items-center justify-end rounded-b-xl bg-zinc-100 px-2 select-none hover:bg-zinc-200 active:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          title="Drag to resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-400 dark:text-zinc-500">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      </div>
    </main>
  );
}
