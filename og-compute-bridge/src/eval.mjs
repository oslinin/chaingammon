#!/usr/bin/env node
// CLI: read an EvalRequest on stdin, dispatch a backgammon-net forward
// pass through 0G compute (or query pricing for one), print result on
// stdout. Mirrors src/chat.mjs's stdin/stdout JSON contract.
//
// Two actions:
//
//   evaluate — runs ONE forward pass `equity = net(features, extras)`
//     stdin:   {"action":"evaluate","features":[198 floats],"extras":[16 floats]}
//     stdout:  {"equity": float, "model": str, "providerAddress": str}
//     exits non-zero with `OG_EVAL_UNAVAILABLE` on stderr if no
//     backgammon-net provider is discoverable.
//
//   estimate — returns pricing for a hypothetical run of N inferences
//     stdin:   {"action":"estimate","count":N}
//     stdout:  {"per_inference_og":float,"total_og":float,
//               "providerAddress":str,"available":bool, "note"?:str}
//     ALWAYS exits 0; "available":false signals the frontend to
//     disable the 0G toggle.
//
// Required env (same wallet the storage bridge + chat bridge already use):
//   OG_STORAGE_RPC, OG_STORAGE_PRIVATE_KEY
// Optional env:
//   OG_COMPUTE_EVAL_PROVIDER   pin a specific provider address
//   BACKGAMMON_NET_MODEL       filter listService by model identifier
//                              (default "backgammon-net-v1")
//   OG_COMPUTE_PER_INFERENCE_OG  fallback pricing when getServiceMetadata
//                              doesn't expose per-inference rates (default 0.00001)
//   OG_COMPUTE_MIN_BALANCE / OG_COMPUTE_DEPOSIT  same as chat.mjs

import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";

// All console.log goes to stderr so stdout is reserved for the JSON
// payload (same pattern as chat.mjs / upload.mjs).
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

const PINNED_PROVIDER = process.env.OG_COMPUTE_EVAL_PROVIDER || null;
const MODEL_FILTER = (process.env.BACKGAMMON_NET_MODEL || "backgammon-net-v1").toLowerCase();
const PER_INFERENCE_FALLBACK_OG = parseFloat(
  process.env.OG_COMPUTE_PER_INFERENCE_OG || "0.00001"
);
const MIN_BALANCE_OG = parseFloat(process.env.OG_COMPUTE_MIN_BALANCE || "0.01");
const DEPOSIT_OG = parseFloat(process.env.OG_COMPUTE_DEPOSIT || "0.05");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Find the backgammon-net provider on the 0G serving network.
 * Returns the provider record or null if none is registered.
 *
 * Discovery order:
 *   1. OG_COMPUTE_EVAL_PROVIDER pin — bypasses listService entirely.
 *   2. broker.inference.listService() filtered by BACKGAMMON_NET_MODEL.
 *
 * No provider found is the common case today (the 0G inference network
 * advertises chat models only). The caller decides whether to fall
 * back to "unavailable" (estimate) or fail (evaluate).
 */
async function findProvider(broker) {
  if (PINNED_PROVIDER) {
    return { provider: PINNED_PROVIDER, model: MODEL_FILTER, pinned: true };
  }
  const services = await broker.inference.listService();
  const match = services.find((s) => {
    const m = (s.model ?? "").toLowerCase();
    const t = (s.serviceType ?? "").toLowerCase();
    return m.includes(MODEL_FILTER) || t.includes("backgammon") || t.includes("equity");
  });
  if (!match) return null;
  return { provider: match.provider, model: match.model, pinned: false };
}

/**
 * Top up the ledger + sub-account if needed. Mirrors chat.mjs's
 * funding block — same wallet, same sub-account semantics, same
 * neuron unit conversion (1 OG = 1e9 neuron).
 */
async function ensureFunded(broker, providerAddress) {
  try {
    const ledger = await broker.ledger.getLedger();
    console.log(`Ledger exists. balance=${ledger?.totalBalance ?? "?"}`);
  } catch (e) {
    console.log(`Ledger missing — creating with ${DEPOSIT_OG} OG.`);
    await broker.ledger.addLedger(DEPOSIT_OG);
  }
  try {
    const amountNeuron = BigInt(Math.floor(MIN_BALANCE_OG * 1e9));
    console.log(
      `Topping up sub-account with ${MIN_BALANCE_OG} OG (${amountNeuron} neuron).`
    );
    await broker.ledger.transferFund(providerAddress, "inference", amountNeuron);
  } catch (e) {
    // Already funded is OK; any other error we surface but try inference anyway.
    console.log(`Sub-account transferFund threw (continuing): ${e?.message ?? e}`);
  }
}

/**
 * Return per-inference cost in OG. Tries to read provider's published
 * pricing via getServiceMetadata; falls back to OG_COMPUTE_PER_INFERENCE_OG
 * env when the SDK's metadata doesn't expose per-call rates (the SDK
 * is geared toward token-priced LLMs).
 */
async function perInferenceOg(broker, providerAddress) {
  try {
    const meta = await broker.inference.getServiceMetadata(providerAddress);
    // Some providers publish input/output token pricing. Approximate
    // the per-inference cost as if the equity-net consumed ~256
    // pseudo-tokens of input and produced 1 token of output. Replace
    // with provider's real per_inference_price field when one exists.
    const inTok = meta?.inputPrice ?? meta?.input_price ?? null;
    const outTok = meta?.outputPrice ?? meta?.output_price ?? null;
    if (inTok != null && outTok != null) {
      // Prices are in neuron per token; 1 OG = 1e9 neuron.
      const costNeuron = BigInt(inTok) * 256n + BigInt(outTok);
      return Number(costNeuron) / 1e9;
    }
  } catch (e) {
    console.log(`getServiceMetadata pricing read failed: ${e?.message ?? e}`);
  }
  return PER_INFERENCE_FALLBACK_OG;
}

async function doEstimate(broker, count) {
  const provider = await findProvider(broker).catch((e) => {
    console.log(`listService threw: ${e?.message ?? e}`);
    return null;
  });
  if (!provider) {
    // Honest disclosure: we can compute placeholder pricing locally
    // so the frontend's estimate row isn't empty, but mark unavailable.
    _origLog(
      JSON.stringify({
        per_inference_og: PER_INFERENCE_FALLBACK_OG,
        total_og: PER_INFERENCE_FALLBACK_OG * count,
        providerAddress: "",
        available: false,
        note: "OG_EVAL_UNAVAILABLE: no backgammon-net provider registered",
      })
    );
    return;
  }
  const perOg = await perInferenceOg(broker, provider.provider);
  _origLog(
    JSON.stringify({
      per_inference_og: perOg,
      total_og: perOg * count,
      providerAddress: provider.provider,
      available: true,
    })
  );
}

async function doEvaluate(broker, features, extras) {
  const provider = await findProvider(broker);
  if (!provider) {
    fail("OG_EVAL_UNAVAILABLE: no backgammon-net provider registered");
  }
  await ensureFunded(broker, provider.provider);

  const { endpoint, model } = await broker.inference.getServiceMetadata(
    provider.provider
  );
  const headers = await broker.inference.getRequestHeaders(provider.provider);

  // Custom POST shape — backgammon-net providers expose /equity (not
  // OpenAI-compatible /chat/completions). The exact body convention
  // is provider-defined; the contract assumed here is `{features,
  // extras}` in JSON, response `{equity}`. Adjust if a real provider
  // settles on a different shape.
  const resp = await fetch(`${endpoint}/equity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ features, extras }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    fail(`Provider returned ${resp.status}: ${body.slice(0, 500)}`);
  }
  const json = await resp.json();
  const equity = typeof json?.equity === "number" ? json.equity : null;
  if (equity === null) {
    fail(`Provider response missing 'equity' field: ${JSON.stringify(json).slice(0, 300)}`);
  }
  _origLog(
    JSON.stringify({ equity, model, providerAddress: provider.provider })
  );
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
  const action = req?.action;
  if (action !== "evaluate" && action !== "estimate") {
    fail(`Unknown action: ${JSON.stringify(action)}. Expected "evaluate" or "estimate".`);
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const broker = await createZGComputeNetworkBroker(signer);

  if (action === "estimate") {
    const count = Number(req.count);
    if (!Number.isFinite(count) || count <= 0) {
      fail("estimate action requires positive integer 'count'");
    }
    await doEstimate(broker, count);
    return;
  }

  // evaluate
  const features = Array.isArray(req.features) ? req.features : null;
  const extras = Array.isArray(req.extras) ? req.extras : null;
  if (!features || !extras) {
    fail("evaluate action requires arrays 'features' and 'extras'");
  }
  await doEvaluate(broker, features, extras);
}

main().catch((e) => fail(`Unhandled error: ${e?.stack || e}`));
