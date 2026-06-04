// Fixture page for Playwright ENS discovery tests.
//
// Renders DiscoveryList with a pre-populated staticEntries array so the
// test does not need to mock eth_getLogs or wait for on-chain scans.
// The entries cover both human players and an agent to exercise both
// branches of the discovery list.
//
// One human entry has an ENS name and ELO; one human has no ELO; the
// agent entry has an inftId and an endpoint.  All labels are valid ENS
// labels (lowercase alphanumeric + hyphens).
"use client";

import { DiscoveryList } from "../DiscoveryList";

const STATIC_ENTRIES = [
  {
    node: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
    label: "alice",
    kind: "human",
    elo: "1500",
    endpoint: "",
    inftId: "",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`,
  },
  {
    node: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
    label: "bob",
    kind: "human",
    elo: "",
    endpoint: "",
    inftId: "",
    owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
  },
  {
    node: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as `0x${string}`,
    label: "gnubg-agent",
    kind: "agent",
    elo: "1486",
    endpoint: "http://localhost:8000",
    inftId: "1",
    owner: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  },
];

export default function TestDiscoveryPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        ENS discovery fixture
      </h1>
      <DiscoveryList staticEntries={STATIC_ENTRIES} />
    </div>
  );
}
