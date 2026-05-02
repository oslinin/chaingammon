// Phase 37: /keeper/[matchId] — server entry. The actual UI lives in
// KeeperWorkflowClient (a client component) so this file can declare
// generateStaticParams. Next 16 forbids `"use client"` and
// `generateStaticParams` in the same file; with `output: "export"` the
// dynamic segment must be statically materialized at build time, so the
// split is mandatory rather than optional.

import KeeperWorkflowClient from "./KeeperWorkflowClient";

const NO_MATCH_SENTINEL = "no-match";

export function generateStaticParams() {
  return [{ matchId: "placeholder" }, { matchId: NO_MATCH_SENTINEL }];
}

export default function KeeperPage() {
  return <KeeperWorkflowClient />;
}
