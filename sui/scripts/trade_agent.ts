// trade_agent.ts — Task 8: the star-agent moment. Seller places+lists an
// Agent in a Kiosk, buyer purchases it, and the on-chain ownership flip
// (agent::claim_ownership, called in the buyer's purchase PTB) is what
// actually changes the outcome of the Task 7 seal_approve policy check —
// this script re-runs that decrypt probe on BOTH sides afterward and
// prints the result loudly: buyer decrypts OK, seller now denied. That
// assertion is the whole ERC-7857 "transferable iNFT" story Sui's Kiosk +
// Seal combination deletes the need for a centralized re-encryption
// service to enforce.
//
// Run: node --experimental-strip-types sui/scripts/trade_agent.ts <agent-object-id> <price-mist>
//
// Env: same as mint_agent.ts/fetch_weights.ts (SUI_RPC_URL, SUI_NETWORK,
// SUI_PACKAGE_ID, SEAL_KEY_SERVER_OBJECT_IDS, WALRUS_AGGREGATOR_URL) plus:
//   SELLER_PRIVATE_KEY - bech32 secret key of the Agent's CURRENT owner
//   BUYER_PRIVATE_KEY  - bech32 secret key of the buying address
//
// UNVERIFIED end-to-end — same caveat as the rest of Task 7/8's scripts
// (blocked egress to Seal/Walrus from this sandbox). The on-chain Kiosk
// mechanics (place_and_list / purchase / confirm_request / claim_ownership)
// are written against the framework's documented `sui::kiosk` +
// `sui::transfer_policy` signatures but have never been run against a
// real network.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { requireEnv, fetchWeightsBlobRef, downloadFromWalrus, decryptAsSigner } from "./seal_agent_lib.ts";

const NETWORK = (process.env.SUI_NETWORK === "localnet" ? "localnet" : "testnet") as
  | "localnet"
  | "testnet";
const RPC_URL = process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK);
const PACKAGE_ID = requireEnv("SUI_PACKAGE_ID");
const SELLER_PRIVATE_KEY = requireEnv("SELLER_PRIVATE_KEY");
const BUYER_PRIVATE_KEY = requireEnv("BUYER_PRIVATE_KEY");
const WALRUS_AGGREGATOR_URL = process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space";

// Framework-level Kiosk/TransferPolicy live at the reserved `0x2` address
// on every network — not part of chaingammon's own published package.
const SUI_FRAMEWORK = "0x2";

async function main() {
  const [agentObjectId, priceArg] = process.argv.slice(2);
  if (!agentObjectId || !priceArg) {
    throw new Error("usage: trade_agent.ts <agent-object-id> <price-mist>");
  }
  const price = BigInt(priceArg);

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });
  const seller = Ed25519Keypair.fromSecretKey(SELLER_PRIVATE_KEY);
  const buyer = Ed25519Keypair.fromSecretKey(BUYER_PRIVATE_KEY);
  const sellerAddress = seller.getPublicKey().toSuiAddress();
  const buyerAddress = buyer.getPublicKey().toSuiAddress();

  // ── 1. Seller: create a Kiosk (agent.move's `init` already shared the
  // no-rules TransferPolicy<Agent> at publish time — Task 2's Kiosk
  // prerequisite). ──────────────────────────────────────────────────────
  console.log(`[trade_agent] seller ${sellerAddress} creating a Kiosk…`);
  const kioskTx = new Transaction();
  kioskTx.setSender(sellerAddress);
  kioskTx.moveCall({ target: `${SUI_FRAMEWORK}::kiosk::default` });
  const kioskResult = await client.signAndExecuteTransaction({
    transaction: kioskTx,
    signer: seller,
    options: { showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: kioskResult.digest });
  const kioskId = objectIdFromChanges(kioskResult, `${SUI_FRAMEWORK}::kiosk::Kiosk`, "created");
  const kioskCapId = objectIdFromChanges(kioskResult, `${SUI_FRAMEWORK}::kiosk::KioskOwnerCap`, "created");
  console.log(`[trade_agent] kiosk=${kioskId} kioskOwnerCap=${kioskCapId}`);

  // ── 2. Seller: place the Agent in the Kiosk and list it for `price`. ────
  console.log(`[trade_agent] listing Agent ${agentObjectId} for ${price} MIST…`);
  const listTx = new Transaction();
  listTx.setSender(sellerAddress);
  listTx.moveCall({
    target: `${SUI_FRAMEWORK}::kiosk::place_and_list`,
    typeArguments: [`${PACKAGE_ID}::agent::Agent`],
    arguments: [listTx.object(kioskId), listTx.object(kioskCapId), listTx.object(agentObjectId), listTx.pure.u64(price)],
  });
  const listResult = await client.signAndExecuteTransaction({ transaction: listTx, signer: seller });
  await client.waitForTransaction({ digest: listResult.digest });
  console.log(`[trade_agent] listed. tx=${listResult.digest}`);

  // ── 3. Buyer: purchase, confirm the (no-rules) TransferPolicy request,
  // claim ownership, and take the Agent home — all in one PTB. ────────────
  console.log(`[trade_agent] buyer ${buyerAddress} purchasing…`);
  const policyId = requireEnv("SUI_AGENT_TRANSFER_POLICY_ID");
  const buyTx = new Transaction();
  buyTx.setSender(buyerAddress);
  const [payment] = buyTx.splitCoins(buyTx.gas, [buyTx.pure.u64(price)]);
  const [purchasedAgent, transferRequest] = buyTx.moveCall({
    target: `${SUI_FRAMEWORK}::kiosk::purchase`,
    typeArguments: [`${PACKAGE_ID}::agent::Agent`],
    arguments: [buyTx.object(kioskId), buyTx.pure.id(agentObjectId), payment],
  });
  // No-rules policy (Task 2's init) — confirm_request always succeeds
  // here; a policy with rules would need each rule's own resolving call
  // before this, which chaingammon's v1 TransferPolicy<Agent> has none of.
  buyTx.moveCall({
    target: `${SUI_FRAMEWORK}::transfer_policy::confirm_request`,
    typeArguments: [`${PACKAGE_ID}::agent::Agent`],
    arguments: [buyTx.object(policyId), transferRequest],
  });
  buyTx.moveCall({
    target: `${PACKAGE_ID}::agent::claim_ownership`,
    arguments: [purchasedAgent],
  });
  buyTx.transferObjects([purchasedAgent], buyerAddress);
  const buyResult = await client.signAndExecuteTransaction({ transaction: buyTx, signer: buyer });
  await client.waitForTransaction({ digest: buyResult.digest });
  console.log(`[trade_agent] purchased + ownership claimed. tx=${buyResult.digest}`);

  // ── 4. The whole point: re-run the Task 7 decrypt probe on both sides. ──
  console.log(`\n[trade_agent] ── post-trade decrypt probe ──`);
  const blobRef = await fetchWeightsBlobRef(client, agentObjectId);
  const ciphertext = await downloadFromWalrus(blobRef.blobId, WALRUS_AGGREGATOR_URL);

  let buyerOk = false;
  try {
    await decryptAsSigner(client, PACKAGE_ID, agentObjectId, ciphertext, buyer);
    buyerOk = true;
    console.log(`[trade_agent] BUYER (${buyerAddress}) decrypt: OK`);
  } catch (e) {
    console.log(`[trade_agent] BUYER (${buyerAddress}) decrypt: FAILED (unexpected!) — ${e instanceof Error ? e.message : String(e)}`);
  }

  let sellerDenied = false;
  try {
    await decryptAsSigner(client, PACKAGE_ID, agentObjectId, ciphertext, seller);
    console.log(`[trade_agent] SELLER (${sellerAddress}) decrypt: OK (unexpected! ownership sync bug)`);
  } catch (e) {
    sellerDenied = true;
    console.log(`[trade_agent] SELLER (${sellerAddress}) decrypt: DENIED (correct) — ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`\n[trade_agent] ${buyerOk && sellerDenied ? "PASS" : "FAIL"}: buyer decrypts OK, seller now denied — ` +
    `the whole ERC-7857 "transferable iNFT" story, enforced by an on-chain policy instead of a centralized re-encryption service.`);
  if (!(buyerOk && sellerDenied)) process.exitCode = 1;
}

function objectIdFromChanges(
  result: Awaited<ReturnType<SuiJsonRpcClient["signAndExecuteTransaction"]>>,
  objectType: string,
  changeType: "created",
): string {
  const found = (result.objectChanges ?? []).find(
    (c) => c.type === changeType && "objectType" in c && c.objectType === objectType,
  ) as { objectId: string } | undefined;
  if (!found) throw new Error(`no ${changeType} object of type ${objectType} in objectChanges — digest ${result.digest}`);
  return found.objectId;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
