#!/usr/bin/env node
// CLI: read a JSON ChatRequest on stdin, hit 0G Compute's chat-completion
// endpoint via @0glabs/0g-serving-broker, print {content, model, providerAddress}
// JSON on stdout.
//
// Usage:
//   echo '{"messages":[...], "system":"..."}' | node src/chat.mjs
//
// Required env:
//   OG_STORAGE_RPC          — same RPC the storage bridge uses (0G testnet/mainnet)
//   OG_STORAGE_PRIVATE_KEY  — wallet that pays for inference
//   (optional) OG_COMPUTE_PROVIDER  — pin a specific provider address; otherwise
//                                     the script picks the first available chatbot
//   (optional) OG_COMPUTE_MIN_BALANCE  — minimum sub-account balance in OG before
//                                        falling back to a top-up (default 0.1)
//   (optional) OG_COMPUTE_DEPOSIT       — amount to deposit on first run (default 0.5)
//
// Output (stdout, single JSON line on success):
//   {"content": string, "model": string, "providerAddress": string}
//
// Errors go to stderr; exit code is non-zero on any failure. The Python
// caller treats any non-zero exit as "coach unreachable" and falls back.

import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

// All console.log goes to stderr so stdout is reserved for the final JSON
// payload. This mirrors og-bridge/src/upload.mjs's pattern.
const _origLog = console.log;
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");

function fail(msg, code = 1) {
  process.stderr.write(`og-compute-bridge: ${msg}\n`);
  process.exit(code);
}

const RPC = process.env.OG_STORAGE_RPC;
const PRIVATE_KEY = process.env.OG_STORAGE_PRIVATE_KEY;
if (!RPC || !PRIVATE_KEY) {
  fail("Missing OG_STORAGE_RPC or OG_STORAGE_PRIVATE_KEY in env.");
}

const PINNED_PROVIDER = process.env.OG_COMPUTE_PROVIDER || null;
// Defaults sized for 0G testnet — testnet faucet drips ~0.1 OG, so we
// keep the per-call sub-account budget below that and ledger bootstrap
// reasonable. Override via env on mainnet (sub-account ≥ 1 OG, ledger
// ≥ 3 OG per the 0G docs).
const MIN_BALANCE_OG = parseFloat(process.env.OG_COMPUTE_MIN_BALANCE || "0.01");
const DEPOSIT_OG = parseFloat(process.env.OG_COMPUTE_DEPOSIT || "0.05");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Format a 0G amount (parseEther) for human-readable logs. */
function fmt(weiBigInt) {
  return ethers.formatEther(weiBigInt) + " OG";
}

async function main() {
  const stdinRaw = await readStdin();
  if (!stdinRaw.trim()) fail("No JSON on stdin.");

  let req;
  try {
    req = JSON.parse(stdinRaw);
  } catch (e) {
    fail(`Invalid JSON on stdin: ${e.message}`);
  }
  const messages = Array.isArray(req?.messages) ? req.messages : null;
  if (!messages || messages.length === 0) {
    fail("Request body must include a non-empty messages[] array.");
  }
  const system = typeof req?.system === "string" && req.system.length > 0 ? req.system : null;
  // Final messages array sent to the LLM. Prepend the system message if present
  // so callers can pass `{system, messages}` separately for clarity.
  const llmMessages = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  // Set up provider + signer + broker. The broker holds funds in a ledger
  // contract and routes inference requests to providers.
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const broker = await createZGComputeNetworkBroker(signer);

  // Pick a provider. The serving network exposes a discovery API; we use the
  // first chatbot service unless the caller pinned one via OG_COMPUTE_PROVIDER.
  let providerAddress = PINNED_PROVIDER;
  if (!providerAddress) {
    const services = await broker.inference.listService();
    const chat = services.find(
      (s) =>
        (s.serviceType ?? "").toLowerCase().includes("chat") ||
        (s.model ?? "").toLowerCase().includes("qwen") ||
        (s.model ?? "").toLowerCase().includes("instruct"),
    );
    if (!chat) fail("No chat-capable provider found on the serving network.");
    providerAddress = chat.provider;
    console.log(`Selected provider ${providerAddress} (model: ${chat.model || "?"}).`);
  }

  // SDK 1.0.0-beta.8 ledger API:
  //   addLedger(balance_in_OG, gasPrice?)  — first-time account creation
  //   getLedger()                          — throws "Account does not exist" if unset
  //   depositFund(amount_in_OG, gasPrice?) — top-up
  //   transferFund(provider, "inference", amount_in_neuron, gasPrice?) — sub-account top-up
  // 1 OG = 1e18 wei. The SDK uses OG-as-decimal for ledger and neuron (= 1e9
  // sub-units of OG, i.e. 1 OG = 1e9 neuron) for sub-account transfers.
  const NEURON_PER_OG = 10n ** 9n;
  let needSubAccountTopUp = true;
  try {
    const ledger = await broker.ledger.getLedger();
    console.log(`Ledger exists. balance=${ledger?.totalBalance ?? "?"} pending=${ledger?.pendingRefund ?? "?"}`);
  } catch (e) {
    console.log(`Ledger missing — creating with ${DEPOSIT_OG} OG: ${e?.message ?? e}`);
    await broker.ledger.addLedger(DEPOSIT_OG);
    console.log("Ledger created.");
  }
  if (needSubAccountTopUp) {
    try {
      const amountNeuron = BigInt(Math.floor(MIN_BALANCE_OG * 1e9));
      console.log(`Topping up provider sub-account with ${MIN_BALANCE_OG} OG (${amountNeuron} neuron).`);
      await broker.ledger.transferFund(providerAddress, "inference", amountNeuron);
    } catch (e) {
      // Already funded is OK; any other error we surface but try inference anyway.
      console.log(`Sub-account transferFund threw (continuing): ${e?.message ?? e}`);
    }
  }

  // Build the request: get the provider's endpoint + signed headers (the
  // headers contain a one-shot auth token for this exact request).
  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const headers = await broker.inference.getRequestHeaders(providerAddress);

  // OpenAI-compatible chat-completions call.
  const resp = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: llmMessages }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    fail(`Provider returned ${resp.status}: ${body.slice(0, 500)}`);
  }
  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  if (!content) fail(`Empty content in provider response: ${JSON.stringify(json).slice(0, 300)}`);

  _origLog(JSON.stringify({ content, model, providerAddress }));
}

main().catch((e) => fail(`Unhandled error: ${e?.stack || e}`));
