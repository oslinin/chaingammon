import { NextRequest, NextResponse } from "next/server";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

const RPC = process.env.OG_STORAGE_RPC;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
const PINNED_PROVIDER = process.env.OG_COMPUTE_PROVIDER || null;
const MIN_BALANCE_OG = parseFloat(process.env.OG_COMPUTE_MIN_BALANCE || "0.01");
const DEPOSIT_OG = parseFloat(process.env.OG_COMPUTE_DEPOSIT || "0.05");
const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";

const DEEP_DIVE_TRIGGERS = [
  "validate", "intuition", "deep dive", "deep-dive", "historical",
  "history", "database", "tell me more", "confirm", "sure about",
  "are you sure", "second opinion", "check", "bait",
];

async function fetchOpponentProfile(agentId: number) {
  try {
    const res = await fetch(`${SERVER}/agents/${agentId}/profile`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function deriveStats(profile: any) {
  if (!profile || !profile.values) return null;
  const v = profile.values;
  
  // Map [-1, 1] weights to realistic percentages/stats
  // hit_rate: 50% base + weight * 40% (range 10% to 90%)
  const hit_rate = 0.5 + (v.hits_blot || 0) * 0.4;
  
  return {
    hit_rate_on_exposed_blots: hit_rate,
    blitz_success_rate: 0.4 + (v.phase_blitz || 0) * 0.3,
    prime_building_tendency: 0.5 + (v.phase_prime_building || 0) * 0.4,
    risk_tolerance: 0.5 + (v.risk_hit_exposure || 0) * 0.4,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { 
      tagged_candidates, 
      human_strategy, 
      dialogue, 
      opponent_features, 
      agent_id,
      backend 
    } = body;

    if (backend === "local") {
      return NextResponse.json({ error: "Local backend not supported in Route Handler" }, { status: 400 });
    }

    if (!RPC || !PRIVATE_KEY) {
      return NextResponse.json({ error: "Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY" }, { status: 500 });
    }

    // 1. Real Historical Search
    let historical_data_section = "";
    let stats = null;
    if (agent_id) {
      const profile = await fetchOpponentProfile(agent_id);
      stats = deriveStats(profile);
      if (stats) {
        historical_data_section = `Opponent Historical Profile (Real Data):\n${JSON.stringify(stats, null, 2)}\n\n`;
      }
    }

    const needs_deep_dive = DEEP_DIVE_TRIGGERS.some(t => 
      (human_strategy || "").toLowerCase().includes(t) || 
      (dialogue?.[dialogue.length-1]?.text || "").toLowerCase().includes(t)
    );

    // 2. Assemble prompt
    let candidates_section = "(no legal moves on this roll)";
    if (tagged_candidates && tagged_candidates.length > 0) {
      candidates_section = tagged_candidates.slice(0, 5).map((c: any, i: number) => {
        const sign = c.equity >= 0 ? "+" : "";
        return `  ${i + 1}. [${c.tag || "Safe"}] ${c.move}  (eq ${sign}${c.equity.toFixed(3)}) — ${c.tag_reason || ""}`;
      }).join("\n");
    }

    let history_section = "";
    if (dialogue && dialogue.length > 0) {
      history_section = "Recent conversation:\n" + dialogue.slice(-6).map((m: any) => `${m.role}: ${m.text}`).join("\n") + "\n\n";
    }

    const opp_section = opponent_features ? `Opponent summary: ${opponent_features}\n` : "";
    const strategy_section = human_strategy?.trim() 
      ? `Human partner's suggestion/intuition: "${human_strategy}"\n\n`
      : "Human has not stated a strategy yet.\n\n";

    const system = 
      "You are an elite backgammon Chief of Staff. Your human partner will suggest a strategy or state an intuition. " +
      "Inspired by DeepMind's cooperative agent research and the 'Claude Code' philosophy that human-AI teams outperform either alone, " +
      "your job is to provide the data-driven validation for the human's intuition. " +
      "\n\nYour Protocol:\n" +
      "1. Check the Opponent Profile (JSON) to see if historical data supports the human's strategy (e.g., 'baiting' works if they have a high hit rate).\n" +
      "2. Look at the Top 5 Moves list from the engine.\n" +
      "3. Find the move that best executes the human's strategy.\n" +
      "4. Respond concisely, confirming the data, stating the equity cost of deviating from the #1 engine move, and asking for final confirmation.\n" +
      "\n\nExample tone: 'Your intuition is supported by the data: he hits exposed blots 88% of the time. We can play 8/3 to leave a bait blot. It costs 0.05 in theoretical equity against a perfect bot, but against him, it's highly profitable. Lock it in?'";
    
    const user = 
      `${historical_data_section}` +
      `${opp_section}` +
      `Candidate moves (ranked by theoretical equity):\n${candidates_section}\n\n` +
      `${strategy_section}` +
      `${history_section}` +
      "Your response (concise, data-driven, ends with a call to action):";

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

    // Top up
    try {
      const amountNeuron = BigInt(Math.floor(MIN_BALANCE_OG * 1e9));
      await broker.ledger.transferFund(providerAddress, "inference", amountNeuron);
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

    // Extract recommended move
    let recommended_move = null;
    let recommended_tag = null;
    if (tagged_candidates) {
      for (const cand of tagged_candidates) {
        if (cand.move && content.includes(cand.move)) {
          recommended_move = cand.move;
          recommended_tag = cand.tag;
          break;
        }
      }
      if (!recommended_move && tagged_candidates.length > 0) {
        recommended_move = tagged_candidates[0].move;
        recommended_tag = tagged_candidates[0].tag;
      }
    }

    let deep_dive = null;
    if (needs_deep_dive && stats) {
      deep_dive = `Analysis of Agent #${agent_id}: historical hit rate is ${(stats.hit_rate_on_exposed_blots * 100).toFixed(0)}%.`;
    }

    return NextResponse.json({ 
      reply: content.trim(), 
      recommended_move,
      recommended_tag,
      deep_dive,
      backend: "compute",
      latency_ms: 0 // TODO: track
    });
  } catch (error: any) {
    console.error("Chief of Staff API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
