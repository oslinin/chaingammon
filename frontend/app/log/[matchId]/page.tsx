// /log/[matchId] — server entry. Client UI lives in LogClient. Next 16
// forbids `"use client"` and `generateStaticParams` in the same file;
// `output: "export"` requires the dynamic segment to be statically
// materialized at build time, so the split is mandatory.

import LogClient from "./LogClient";

export function generateStaticParams() {
  return [{ matchId: "placeholder" }, { matchId: "no-match" }];
}

export default function LogPage() {
  return <LogClient />;
}
