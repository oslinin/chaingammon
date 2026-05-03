// Fixture page for Phase 76 Playwright tests — Chief of Staff panel.
//
// Renders ChiefOfStaffPanel with static props so Playwright can assert
// structural and visual correctness without requiring live gnubg or
// coach_service processes.

"use client";

import { ChiefOfStaffPanel } from "../ChiefOfStaffPanel";

export default function TestChiefOfStaffPage() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Chief of Staff fixture
      </h1>
      <ChiefOfStaffPanel
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
