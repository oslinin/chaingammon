# Server shortlist

What the server still does, what moved to the browser, and what the keeper owns.

---

## Moved to browser

| Was | Now |
|---|---|
| AI move inference (ONNX via gnubg) | Browser runs ONNX; model fetched from 0G Storage, decrypted with wallet-derived AES key |
| ENS `setText` for ELO / last_match_id | Browser calls `PublicResolver.setText` directly from player wallet |
| `AgentVault.depositToEscrow` at match start | Browser calls `AgentVault.depositToEscrow`; NFT owner signs, no server key needed |
| `POST /subname/mint` (human subnames) | Browser calls `PlayerSubnameRegistrar.selfMintSubname` directly (`ProfileBadge.tsx`). Agent subnames minted atomically inside `AgentRegistry.mintAgent` — no server key needed for either. |

---

## Keeper owns

| Step | Status |
|---|---|
| Call `recordMatchAndSplit` on game end (staked) | Done — registered KeeperHub workflow (`7f9dqwtohidj6lc89tuht`) calls it directly via Para MPC wallet. Pending `setSettler()` on-chain to activate. |
| Verify escrow deposit, rules check, audit upload | Done — `keeper_workflow.py` 8-step workflow |

---

## Server keeps (load-bearing)

| Endpoint | Why it stays |
|---|---|
| `POST /keeper-workflow/{id}/run` | Webhook target for KeeperHub |
| `GET /keeper-workflow/{id}` | Frontend polls for workflow progress |
| `POST /upload-game-record` | Browser calls before `settle()` (`team-demo/page.tsx`) |
| `POST /finalize-direct-staked` | Browser calls with `keeper_settle=true` to hand off staked settlement to keeper |
| `POST /matches/{id}/forfeit-check` | Forfeit detection — referenced in `match-settle.yaml` spec; not used by registered workflow |
| `POST /training/*` | Training job management (server compute) |

---

## Could move to browser (not urgent)

| Endpoint | Notes |
|---|---|
| `POST /agents/{id}/recommend-teammate` | ONNX equity eval; same model now runs in browser |
| `POST /equity` | Raw equity eval; same |
| `GET /agents`, `/agents/{id}/profile` | Read-through; browser can hit chain + 0G directly |
| `GET /ens-records/{label}` | ENS read; browser can call resolver directly |
| `GET /game-records/{hash}` | 0G read-through; browser can fetch indexer directly |

---

## Settlement split by game type

| Game type | Who settles | How |
|---|---|---|
| Free (ELO-only) | Server | `/finalize-direct` → `recordMatch` |
| Staked (keeper path) | KeeperHub Para MPC wallet | Browser calls `/finalize-direct-staked?keeper_settle=true` → keeper reads `/replay` → calls `recordMatchAndSplit` directly |
| Staked (browser-direct) | Browser | `settle(params, …, escrowMatchId, winners, shares)` — fully permissionless |
| Human-vs-human (free) | Browser | `settle(params, …, bytes32(0), [], [])` — same function, agentId=0, empty payout |
| Embedded-wallet relay | Server (`/relay-settle`) | Server submits `settle()` tx; operator pays gas. Contract still verifies all sigs — server cannot forge a result. |

One `settle()` function handles all modes: `agentId != 0` → PvE, `agentId == 0` → HvH. Pass non-empty `winners` to trigger escrow payout; pass empty arrays for ELO-only. Auth hash uses `"Chaingammon:open"` (PvE) or `"Chaingammon:open-hvh"` (HvH). Result hash always binds `escrowMatchId + keccak256(abi.encode(winners, shares))`.

Free games have no pot to incentivise a keeper, so the server remains the settler. The keeper path for staked games removes the server from the settlement tx entirely.

---

## KV storage — server-side fallback

`put_kv` / `get_kv` in `og_storage_client.py` try the og-bridge Node script first. If it fails (testnet, before the 0G SDK ships a KV client), they fall back to a local JSON file (`KV_MOCK_PATH`, default `/tmp/chaingammon-kv-mock.json`). Style vectors and weights written via the fallback persist across server restarts and are readable via the same fallback path. No config change needed — the fallback activates automatically on script failure.

## Dead / to remove

| Endpoint | Why |
|---|---|
| `POST /settle` | Was server relay for keeper-signed settlement; keeper now calls chain directly |
| `POST /webhooks/match/{id}/end` | Designed for mid-flow KeeperHub webhook wait (unsupported by KeeperHub); registered workflow dropped the step. Server fires it internally — nothing consumes it. |
