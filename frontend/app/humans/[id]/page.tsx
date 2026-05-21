// /humans/[id] — server entry. Client UI lives in HumanClient.

// Next 16 forbids `"use client"` and `generateStaticParams` in the same file.

import { createPublicClient, http, parseAbiItem } from "viem";
import HumanClient from "./HumanClient";

import sepoliaDeployment from "../../../../contracts/deployments/sepolia.json";

const SUBNAME_MINTED_EVENT = parseAbiItem(
  "event SubnameMinted(string label, bytes32 indexed node, address indexed subnameOwner, uint256 inftId)",
);

const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ??
  "https://ethereum-sepolia.publicnode.com";
const MAX_BLOCK_RANGE = BigInt(49_000);

export async function generateStaticParams(): Promise<{ id: string }[]> {
  const registrar = sepoliaDeployment.contracts
    .PlayerSubnameRegistrar as `0x${string}` | null | undefined;

  if (!registrar) return [{ id: "placeholder" }];

  try {
    const client = createPublicClient({ transport: http(SEPOLIA_RPC) });
    const deployedBlock = BigInt(sepoliaDeployment.deployedBlock ?? 0);
    const tip = await client.getBlockNumber();

    const chunks: { fromBlock: bigint; toBlock: bigint }[] = [];
    let cur = deployedBlock;
    while (cur <= tip) {
      const end =
        cur + MAX_BLOCK_RANGE <= tip ? cur + MAX_BLOCK_RANGE : tip;
      chunks.push({ fromBlock: cur, toBlock: end });
      cur = end + 1n;
    }

    const allLogs = (
      await Promise.all(
        chunks.map((chunk) =>
          client.getLogs({ address: registrar, event: SUBNAME_MINTED_EVENT, ...chunk }),
        ),
      )
    ).flat();

    const ids = new Set<string>(["placeholder"]);
    for (const log of allLogs) {
      if (log.args?.inftId !== 0n) continue;
      const label = log.args?.label;
      const owner = log.args?.subnameOwner as string | undefined;
      if (label) ids.add(label);
      if (owner) ids.add(owner.toLowerCase());
    }

    return Array.from(ids).map((id) => ({ id }));
  } catch (err) {
    console.warn("[generateStaticParams/humans] RPC fetch failed, using placeholder:", err);
    return [{ id: "placeholder" }];
  }
}

export default function HumanInfoPage() {
  return <HumanClient />;
}
