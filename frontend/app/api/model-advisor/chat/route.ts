import { NextRequest, NextResponse } from "next/server";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

const RPC = process.env.OG_STORAGE_RPC;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
const PINNED_PROVIDER = process.env.OG_COMPUTE_PROVIDER || null;
const MIN_BALANCE_OG = parseFloat(process.env.OG_COMPUTE_MIN_BALANCE || "1.1");
const DEPOSIT_OG = parseFloat(process.env.OG_COMPUTE_DEPOSIT || "0.1");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      prompt,
      dialogue,
      backend
    } = body;

    if (backend === "local") {
      return NextResponse.json({ error: "Local backend not supported in Route Handler" }, { status: 400 });
    }

    if (!RPC || !PRIVATE_KEY) {
      return NextResponse.json({ error: "Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY" }, { status: 500 });
    }

    let history_section = "";
    if (dialogue && dialogue.length > 0) {
      history_section = "Recent conversation:\n" + dialogue.slice(-6).map((m: any) => `${m.role}: ${m.text}`).join("\n") + "\n\n";
    }

    const system =
      "You are an elite PyTorch AI Model Advisor. Your human partner wants to create a new Backgammon Agent. " +
      "They may ask about different model architectures, tradeoffs, or ask for PyTorch code. " +
      "Your job is to answer their questions about model tradeoffs and optionally provide PyTorch code. " +
      "\n\nIf you provide code, ensure it implements the expected contract: " +
      "`__init__(in_dim: int = 198, hidden: int = 80, extras_dim: int = 16, *, core_seed: int = 0xBACC, extras_seed: int | None = None)` " +
      "and `forward(x: torch.Tensor, extras: torch.Tensor) -> torch.Tensor`. " +
      "Return the code in a single markdown code block with `python`. " +
      "Keep answers concise.";

    const user =
      `${history_section}` +
      `User request: "${prompt}"\n\n` +
      "Your response:";

    const llmMessages = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];

    let broker;
    try {
      console.log("MA: Initializing 0G broker...");
      const provider = new ethers.JsonRpcProvider(RPC);
      const signer = new ethers.Wallet(PRIVATE_KEY, provider);
      broker = await createZGComputeNetworkBroker(signer);
    } catch (e: any) {
      throw new Error(`0G Broker Init failed: ${e.message}`);
    }

    let providerAddress = PINNED_PROVIDER;
    if (!providerAddress) {
      try {
        console.log("MA: Listing services...");
        const services = await broker.inference.listService();
        const chatService = services.find(
          (s) =>
            (s.serviceType ?? "").toLowerCase().includes("chat") ||
            (s.model ?? "").toLowerCase().includes("qwen") ||
            (s.model ?? "").toLowerCase().includes("instruct"),
        );
        if (!chatService) throw new Error("No chat-capable provider found on 0G network");
        providerAddress = chatService.provider;
      } catch (e: any) {
        throw new Error(`0G Service Discovery failed: ${e.message}`);
      }
    }

    try {
      await broker.ledger.getLedger();
    } catch (e) {
      try {
        await broker.ledger.addLedger(DEPOSIT_OG);
      } catch (inner: any) {
        throw new Error(`0G Ledger Deposit failed: ${inner.message}`);
      }
    }

    try {
      const acct = await broker.inference.getAccount(providerAddress);
      const locked = BigInt(acct[3] ?? 0);
      const target = ethers.parseEther(MIN_BALANCE_OG.toString());
      if (locked < target) {
        const topUp = target - locked;
        await broker.ledger.transferFund(providerAddress, "inference", topUp);
      }
    } catch (e) {
      console.warn("MA: Top-up step failed:", e);
    }

    let metadata;
    try {
      metadata = await broker.inference.getServiceMetadata(providerAddress);
    } catch (e: any) {
      throw new Error(`0G Metadata Fetch failed: ${e.message}`);
    }

    const { endpoint, model } = metadata;
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

    // Extract python code if any
    let code = null;
    const codeMatch = content.match(/```python\n([\s\S]*?)```/);
    if (codeMatch) {
      code = codeMatch[1].trim();
    }

    return NextResponse.json({
      reply: content.trim(),
      code,
      backend: "compute",
      latency_ms: 0
    });
  } catch (error: any) {
    console.error("Model Advisor API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
