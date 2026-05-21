// /humans/[id] — server entry. Client UI lives in HumanClient.

import HumanClient from "./HumanClient";

// Next 16 forbids `"use client"` and `generateStaticParams` in the same file.

export function generateStaticParams() {
  return [{ id: "0" }];
}

export default function HumanInfoPage() {
  return <HumanClient />;
}
