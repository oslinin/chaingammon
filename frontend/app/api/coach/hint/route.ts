import { NextRequest, NextResponse } from "next/server";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

const RPC = process.env.OG_STORAGE_RPC;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
const PINNED_PROVIDER = process.env.OG_COMPUTE_PROVIDER || null;
// Target locked balance per (user, provider) sub-account. The 0G
// provider rejects inference with HTTP 400 "minimum reserve 1.000000
// 0G" when locked < 1.0; 1.1 keeps a small buffer. Top-up is gated by
// a getAccount check below so we don't transfer on every request.
const MIN_BALANCE_OG = parseFloat(process.env.OG_COMPUTE_MIN_BALANCE || "1.1");
// 0G Ledger contract reverts the first-time deposit below 0.1 with the
// custom error 0x54443ec4(sentWei, requiredWei). Default high enough.
const DEPOSIT_OG = parseFloat(process.env.OG_COMPUTE_DEPOSIT || "0.1");

// Mocking some of the Python logic since we don't have the full RAG/Profile context here yet
// In a real implementation, we would either fetch from 0G Storage here or pass it in.

async function fetchDocs(docsHash: string): Promise<string> {
  const _FALLBACK =
    "Backgammon strategy: build primes (especially the 5-point and bar " +
    "point), make anchors when behind in the race, hit blots when it " +
    "doesn't leave too much exposure, and bear off efficiently when " +
    "ahead. Avoid leaving direct shots after a hit.";
  
  if (!docsHash) return _FALLBACK;
  
  // For now return fallback. Fetching from 0G Storage would require the storage SDK.
  return _FALLBACK;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { dice, candidates, docs_hash, backend } = body;

    if (backend === "local") {
      return NextResponse.json({ error: "Local backend not supported in Route Handler" }, { status: 400 });
    }

    if (!RPC || !PRIVATE_KEY) {
      return NextResponse.json({ error: "Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY" }, { status: 500 });
    }

    // Assemble prompt
    const docsContext = await fetchDocs(docs_hash);
    
    // Placeholder profile summary
    const profileSummary = "This agent is fresh — no measurable playing style yet.";

    const top3 = candidates.slice(0, 3);
    const movesText = top3.map((c: any) => `${c.move} (equity ${c.equity > 0 ? "+" : ""}${c.equity.toFixed(3)})`).join("; ") || "no legal moves";

    const system = 
      "You are a backgammon coach watching a human play against an AI agent. " +
      "Speak directly to the human in 1–2 sentences. Reference the agent's " +
      "playing tendencies when relevant. Do not list options — explain " +
      "why the top move is good. Use plain English; no jargon beyond " +
      "standard backgammon terms.";
    
    const user = 
      `Reference strategy notes: ${docsContext}\n\n` +
      `Opponent agent profile: ${profileSummary}\n\n` +
      `The human rolled ${dice[0]} and ${dice[1]}.\n` +
      `gnubg ranked these moves (best first): ${movesText}.\n\n` +
      `In 1–2 sentences, tell the human why the best move is the right ` +
      `choice against this specific agent.`;

    const llmMessages = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];

    // 0G Compute Logic
    const provider = new ethers.JsonRpcProvider(RPC);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const broker = await createZGComputeNetworkBroker(signer);

    let providerAddress = PINNED_PROVIDER;
    if (!providerAddress) {
      const services = await broker.inference.listService();
      const chatService = services.find(
        (s) =>
          (s.serviceType ?? "").toLowerCase().includes("chat") ||
          (s.model ?? "").toLowerCase().includes("qwen") ||
          (s.model ?? "").toLowerCase().includes("instruct"),
      );
      if (!chatService) throw new Error("No chat-capable provider found");
      providerAddress = chatService.provider;
    }

    // Ledger checks
    try {
      await broker.ledger.getLedger();
    } catch (e) {
      await broker.ledger.addLedger(DEPOSIT_OG);
    }

    // Top up only when the per-provider sub-account is below the
    // target locked balance. getAccount[3] is locked-wei; transferFund
    // takes raw wei (not gwei) and is incremental.
    try {
      const acct = await broker.inference.getAccount(providerAddress);
      const locked = BigInt(acct[3] ?? 0);
      const target = ethers.parseEther(MIN_BALANCE_OG.toString());
      if (locked < target) {
        await broker.ledger.transferFund(providerAddress, "inference", target - locked);
      }
    } catch (e) {
      // ignore
    }

    const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
    const headers = await broker.inference.getRequestHeaders(providerAddress);

    const resp = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: llmMessages }),
    });

    if (!resp.ok) {
      throw new Error(`Provider returned ${resp.status}`);
    }

    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content ?? "";

    return NextResponse.json({ hint: content.trim(), backend: "compute" });
  } catch (error: any) {
    console.error("Coach API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
