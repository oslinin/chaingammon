// Fixture page for Phase 76 Playwright tests — Agent Teammate panel.
//
// Renders AgentTeammatePanel with static props so Playwright can assert
// structural and visual correctness without requiring live gnubg or
// coach_service processes.

"use client";

import { AgentTeammatePanel } from "../AgentTeammatePanel";

export default function TestAgentTeammatePage() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Agent Teammate fixture
      </h1>
      <AgentTeammatePanel
        positionId="4HPwATDgc/ABMA"
        matchId="cIkqAAAAAAAA"
        dice={[3, 5]}
        board={Array(24).fill(0)}
        agentId={1}
        disabled={false}
        onMoveSelect={() => {}}
      />
    </div>
  );
}
