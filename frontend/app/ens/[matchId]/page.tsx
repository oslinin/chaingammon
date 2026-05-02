// /ens/[matchId] — server entry. Client UI lives in EnsClient. Next 16
// forbids `"use client"` and `generateStaticParams` in the same file;
// `output: "export"` requires the dynamic segment to be statically
// materialized at build time, so the split is mandatory.

import EnsClient from "./EnsClient";

export function generateStaticParams() {
  return [{ matchId: "placeholder" }, { matchId: "no-match" }];
}

export default function EnsPage() {
  return <EnsClient />;
}
