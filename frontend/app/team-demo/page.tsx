// Phase K.5: team-mode advisor signal live demo.
//
// Creates a team game (team_a = [agent:1, agent:2] alternating, team_b
// = [agent:3]), repeatedly POSTs /games/{id}/agent-move so each turn
// produces AdvisorSignal[] per non-captain teammate, and renders the
// signals + captain decision per move.
//
// Why a separate page vs. integrating into /match: the match page
// drives moves through gnubg_service (port 8001), which doesn't share
// state with the main FastAPI's _move_history. /agent-move (the
// endpoint that emits advisor signals) lives on the main service and
// would conflict with gnubg_service if called in parallel during a
// live game. This standalone demo exercises the team flow end-to-end
// against /agent-move directly so the bounty story is visible without
// rewiring the match page.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const SERVER = process.env.NEXT_PUBLIC_COACH_URL ?? "http://localhost:8002";

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

export default function TeamDemoPage() {
  const [gameId, setGameId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createGame = useMutation({
    mutationFn: async () => {
      setError(null);
      const r = await fetch(`${SERVER}/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_length: 1,
          agent_id: 1,
          team_a: {
            members: [
              { kind: "agent", agent_id: 1 },
              { kind: "agent", agent_id: 2 },
            ],
            captain_rotation: "alternating",
          },
          team_b: {
            members: [{ kind: "agent", agent_id: 3 }],
            captain_rotation: "alternating",
          },
        }),
      });
      if (!r.ok) throw new Error(`/games → ${r.status}: ${await r.text()}`);
      return (await r.json()) as { game_id: string };
    },
    onSuccess: (d) => setGameId(d.game_id),
    onError: (e) => setError((e as Error).message),
  });

  const queryClient = useQueryClient();
  const playMove = useMutation({
    mutationFn: async () => {
      if (!gameId) throw new Error("create a game first");
      const r = await fetch(`${SERVER}/games/${gameId}/agent-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`agent-move → ${r.status}: ${await r.text()}`);
      return r.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["advisor-snapshot", gameId] }),
    onError: (e) => setError((e as Error).message),
  });

  const snapshot = useQuery({
    enabled: !!gameId,
    queryKey: ["advisor-snapshot", gameId],
    queryFn: async (): Promise<AdvisorSnapshot> => {
      const r = await fetch(`${SERVER}/games/${gameId}/last-advisor-signals`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          Team-mode advisor demo
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Click <em>Create team game</em> to spawn a 2v1 game (Team A:
          agents 1+2 alternating; Team B: agent 3). Click <em>Play next move</em>{" "}
          to advance one turn — each move's non-captain teammates publish an
          AdvisorSignal, archived to MoveEntry.advisor_signals and the on-chain
          commitment.
        </p>
      </header>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => createGame.mutate()}
          disabled={createGame.isPending}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {createGame.isPending ? "Creating…" : "Create team game"}
        </button>
        <button
          type="button"
          onClick={() => playMove.mutate()}
          disabled={!gameId || playMove.isPending}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
        >
          {playMove.isPending ? "Playing…" : "Play next move"}
        </button>
        {gameId && (
          <span className="self-center font-mono text-xs text-zinc-500">
            game_id: {gameId.slice(0, 8)}…
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {snapshot.data && (
        <SnapshotPanel snapshot={snapshot.data} />
      )}
    </main>
  );
}

function SnapshotPanel({ snapshot }: { snapshot: AdvisorSnapshot }) {
  if (!snapshot.team_mode) {
    return (
      <p className="text-sm text-zinc-500">
        Game is not in team mode — no advisor signals expected.
      </p>
    );
  }
  if (snapshot.signals.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No moves played yet. Click <em>Play next move</em> to see advisor
        signals.
      </p>
    );
  }
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Advisor signals — move {snapshot.move_idx + 1}
        </h2>
        {snapshot.captain_id && (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-mono text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            captain: {snapshot.captain_id}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {snapshot.signals.map((s, i) => (
          <li
            key={i}
            className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                {s.teammate_id}
              </span>
              <ConfidenceBar value={s.confidence} />
            </div>
            <p className="font-mono text-zinc-900 dark:text-zinc-100">
              proposes: {s.proposed_move}
            </p>
            {s.message && (
              <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                {s.message}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-zinc-500">
        {value.toFixed(2)}
      </span>
    </div>
  );
}
