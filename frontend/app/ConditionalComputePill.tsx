// ConditionalComputePill — renders ComputeBackendsPill only in advanced mode.
// Mounted in layout.tsx so it's available on every page, but stays hidden
// in elo and money modes to keep the UI uncluttered for casual users.
"use client";

import { useAppMode } from "./AppModeContext";
import { ComputeBackendsPill } from "./ComputeBackendsPill";

export function ConditionalComputePill() {
  const { mode } = useAppMode();
  if (mode !== "advanced") return null;
  return <ComputeBackendsPill />;
}
