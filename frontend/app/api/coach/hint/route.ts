import { NextResponse } from "next/server";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

const RPC = process.env.OG_STORAGE_RPC || "";
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY || "";

export async function POST(req: Request) {
    if (!RPC || !PRIVATE_KEY) {
        return NextResponse.json({ error: "Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY" }, { status: 500 });
    }

    try {
        const body = await req.json();
        const { position_id, dice, candidates } = body;

        const system = `You are a backgammon coach. Analyze this position (position_id: ${position_id}) with dice ${dice}.
The top candidates are:
${candidates.slice(0, 3).map((c: any) => `- ${c.move} (equity: ${c.equity.toFixed(3)})`).join('\n')}
Provide a one-sentence tip on why the top move is good.`;

        const provider = new ethers.JsonRpcProvider(RPC);
        const signer = new ethers.Wallet(PRIVATE_KEY, provider);
        const broker = await createZGComputeNetworkBroker(signer);

        const services = await broker.inference.listService();
        const chat = services.find(
          (s: any) =>
            (s.serviceType ?? "").toLowerCase().includes("chat") ||
            (s.model ?? "").toLowerCase().includes("qwen") ||
            (s.model ?? "").toLowerCase().includes("instruct")
        );
        if (!chat) throw new Error("No chat-capable provider found on the serving network.");

        const providerAddress = chat.provider;
        const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
        const headers = await broker.inference.getRequestHeaders(providerAddress);

        const resp = await fetch(`${endpoint}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({
                model,
                messages: [{ role: "system", content: system }, { role: "user", content: "What is your advice?" }]
            }),
        });

        if (!resp.ok) {
            throw new Error(`Provider error: ${resp.status}`);
        }

        const json = await resp.json();
        const content = json?.choices?.[0]?.message?.content ?? "";

        return NextResponse.json({ hint: content, backend: "compute" });
    } catch (e: any) {
        console.error("Coach Hint Error:", e);
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
