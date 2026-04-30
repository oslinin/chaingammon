// Test fixture page — renders DiscoveryList with static mock entries so
// Playwright can verify grouping and Play-button logic without a blockchain.
//
// Mock entries:
//   alice    — kind=human,  elo=1500, no endpoint  → no Play button
//   gnubg-1  — kind=agent,  elo=1520, endpoint set  → Play button visible
//   gnubg-2  — kind=agent,  elo=1480, no endpoint   → no Play button
import { DiscoveryList } from "../DiscoveryList";

const MOCK_ENTRIES = [
  {
    node: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    label: "alice",
    kind: "human",
    elo: "1500",
    endpoint: "",
  },
  {
    node: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    label: "gnubg-1",
    kind: "agent",
    elo: "1520",
    endpoint: "http://localhost:8001",
  },
  {
    node: "0x0000000000000000000000000000000000000000000000000000000000000003" as `0x${string}`,
    label: "gnubg-2",
    kind: "agent",
    elo: "1480",
    endpoint: "",
  },
];

export default function TestDiscoveryPage() {
  return (
    <main className="p-8">
      <DiscoveryList staticEntries={MOCK_ENTRIES} />
    </main>
  );
}
