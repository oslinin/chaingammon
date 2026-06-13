// blink.cash signer endpoint (ETHGlobal NYC 2026, Stream 3, PR 3.1).
//
// The @swype-org/deposit SDK (frontend/app/UsdcBalanceDisplay.tsx) POSTs a
// SignerRequest here. We build the canonical payload, sign it with the
// merchant's ECDSA P-256 key, and return a SignerResponse. blink's hosted
// flow verifies the signature against the merchant's registered public key
// before crediting the deposit to the user's wallet in USDC.
//
// Secrets are server-only: MERCHANT_ID and MERCHANT_PRIVATE_KEY (PEM). The
// private key must NEVER be exposed via a NEXT_PUBLIC_* var or sent to the
// client. When unset the route returns 501 so the rest of the app still
// builds and runs (the deposit button surfaces a clear error).

import { NextRequest, NextResponse } from "next/server";
import { createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";

// Needs the Node runtime for node:crypto + PEM keys; never cache responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;

// Web flows must send callbackScheme === null. If a native app is added,
// allowlist its URL scheme(s) here and accept them too.
function isAllowedCallbackScheme(scheme: unknown): boolean {
  return scheme === null || scheme === undefined;
}

export async function POST(req: NextRequest) {
  if (!MERCHANT_ID || !MERCHANT_PRIVATE_KEY) {
    return NextResponse.json(
      { error: "blink.cash not configured: set MERCHANT_ID and MERCHANT_PRIVATE_KEY" },
      { status: 501 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { amount, chainId, address, token, callbackScheme, url, version } = body;

  // Validate the SignerRequest. amount may be null — the user then enters the
  // amount inside the hosted flow.
  if (amount !== null && (typeof amount !== "number" || !(amount > 0))) {
    return NextResponse.json({ error: "amount must be a positive number or null" }, { status: 400 });
  }
  if (typeof chainId !== "number") {
    return NextResponse.json({ error: "chainId must be a number" }, { status: 400 });
  }
  if (typeof address !== "string" || !address) {
    return NextResponse.json({ error: "address is required" }, { status: 400 });
  }
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  if (!isAllowedCallbackScheme(callbackScheme)) {
    return NextResponse.json({ error: "callbackScheme not allowed" }, { status: 400 });
  }

  const idempotencyKey = randomUUID();
  const signatureTimestamp = new Date().toISOString();

  // Canonical payload — field ORDER matters because we sign its serialization.
  const payload = {
    merchantId: MERCHANT_ID,
    amount: (amount as number | null) ?? null,
    chainId,
    address,
    token,
    callbackScheme: (callbackScheme as string | null) ?? null,
    url: (url as string | null) ?? null,
    version: (version as string) ?? "v1",
    idempotencyKey,
    signatureTimestamp,
  };

  // Base64url-encode the JSON string, then sign the ENCODING (not raw JSON).
  const payloadB64url = Buffer.from(JSON.stringify(payload)).toString("base64url");

  let signatureB64url: string;
  try {
    // PEM stored in env keeps literal "\n" — restore real newlines.
    const key = createPrivateKey({ key: MERCHANT_PRIVATE_KEY.replace(/\\n/g, "\n") });
    // ECDSA P-256 + SHA-256, raw r||s (IEEE P1363 / JOSE ES256) signature.
    const sig = cryptoSign("sha256", Buffer.from(payloadB64url), { key, dsaEncoding: "ieee-p1363" });
    signatureB64url = sig.toString("base64url");
  } catch {
    return NextResponse.json({ error: "signing failed" }, { status: 500 });
  }

  return NextResponse.json(
    {
      merchantId: MERCHANT_ID,
      payload: payloadB64url,
      signature: signatureB64url,
      preview: {
        amount: (amount as number | null) ?? 0,
        chainId,
        address,
        token,
        idempotencyKey,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
