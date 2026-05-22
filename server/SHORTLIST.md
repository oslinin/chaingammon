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
| Trigger `settleWithSessionKeys` on game end | **Pending** — currently browser calls it; keeper workflow should do this instead (session key stored in game record on 0G) |
| Verify escrow deposit, rules check, audit upload | Done — `keeper_workflow.py` 8-step workflow |

---

## Server keeps (load-bearing)

| Endpoint | Why it stays |
|---|---|
| `POST /keeper-workflow/{id}/run` | Webhook target for KeeperHub |
| `GET /keeper-workflow/{id}` | Frontend polls for workflow progress |
| `POST /webhooks/match/{id}/end` | Game-end hook → triggers keeper workflow |
| `POST /matches/{id}/forfeit-check` | Forfeit detection |
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

| Game type | Who settles | Who pays gas |
|---|---|---|
| Free (ELO-only) | Server → `recordMatch` via `/finalize-direct` | Server wallet |
| Staked | Keeper → `settleWithSessionKeysAndSplit` | Keeper (funded by pot fee) |

Free games have no pot to incentivise a keeper, so the server remains the settler. Staked games route through the keeper for tab-close resilience.

## Dead / to remove

| Endpoint | Why |
|---|---|
| `POST /finalize-direct-staked` | Keeper handles staked settlement; this manual path is redundant |
| `POST /settle` | Was server relay for `settleWithSessionKeys`; keeper calls chain directly |
| `POST /upload-game-record` | Removed from scope; browser uploads via 0G SDK or server stays as relay (low priority) |
