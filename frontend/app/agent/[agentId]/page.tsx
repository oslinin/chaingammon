// /agent/[agentId] — server entry. Client UI lives in AgentClient. Next 16
// forbids `"use client"` and `generateStaticParams` in the same file;
// `output: "export"` requires the dynamic segment to be statically
// materialized at build time, so the split is mandatory.

import AgentClient from "./AgentClient";

export function generateStaticParams() {
  return Array.from({ length: 10 }, (_, i) => ({ agentId: String(i + 1) }));
}

export default function AgentInfoPage() {
  return <AgentClient />;
}
