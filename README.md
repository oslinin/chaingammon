# Chaingammon

> **An open protocol for portable backgammon reputation.** Your wallet (or your AI agent) is your player profile. Your ENS subname is your portable identity. Your full match archive lives on 0G Storage, owned by you forever.

A decentralised, verifiable ELO ledger for backgammon — humans and agents share one identity layer.

- **Open identity.** ENS subnames written only by the protocol. Reserved text records (`elo`, `match_count`, `kind`, `inft_id`, `style_uri`, `archive_uri`) cannot be self-claimed; any third-party tool reads them without coordinating with us.
- **Verifiable settlement.** Every match settles to `MatchRegistry` on Sepolia. The on-chain record carries a 32-byte 0G Storage hash of the full archive (every move, every dice roll) so anyone can audit any rating change end-to-end.
- **Per-agent weights.** Each AI agent is an ERC-721 token with an ERC-7857-compatible `dataHashes` getter. `dataHashes[0]` is a shared base-weights hash (gnubg-init); per-agent trained weights are written to mutable 0G KV at `chaingammon/weights/agent/{agent_id}`. (See the [Agent intelligence](#agent-intelligence) section for the tradeoff. Full ERC-7857 transfer-with-reencryption-proof is roadmap.)
- **Optional stakes.** A match can be free (ELO-only) or staked (per-side ETH deposit, winner takes the pot). Agents stake via a server-managed session-key wallet the owner pre-funds; settlement is atomic — `MatchRegistry.recordMatchAndSplit` records the result and pays the winner in one transaction.
- **Browser-side gameplay.** Move evaluation runs in the browser via ONNX Runtime Web (small NN forward pass, ~10K parameters). Dice are local `crypto.getRandomValues` for v1 (human-vs-agent; the human is rolling for themselves). The coach LLM runs on 0G Compute (Qwen 2.5 7B) via Next.js API routes. A pure-Python coach + local-model fallback runs on the optional FastAPI service.

---

## How it works

1. Connect a wallet → frontend resolves (or auto-mints) `<name>.chaingammon.eth` on Sepolia.
2. Pick an opponent — another player's subname or an agent (e.g. `gnubg-classic.chaingammon.eth`).
3. Per-turn loop, browser-side:
   - Roll dice (`crypto.getRandomValues`).
   - The agent's value network scores legal successors via ONNX Runtime Web; argmax = chosen move.
   - The TypeScript rules engine (`frontend/lib/rules_engine.ts`) validates the move.
   - The move is appended to the in-progress `GameRecord`.
4. Game ends → wallet + session-key signatures verified by `MatchRegistry.settleWithSessionKeys` → ELO and ENS text records updated → frontend uploads the `GameRecord` JSON to 0G Storage and records the Merkle root with settlement.
5. The keeper-shaped audit workflow (`server/app/keeper_workflow.py`) re-walks every move through the Python rules engine and pins a workflow JSON to 0G Storage as the audit anchor.
6. Any third-party tool reads your ENS subname and reconstructs your full backgammon DNA — ELO, games played, archive URI, playing style.

---

## Architecture

```
                       ┌──────────────────────────┐
                       │    Frontend (Next.js)    │
                       │  matchmaking, profile,   │
                       │  replay, live game,      │
                       │  LLM coach panel         │
                       └────────────┬─────────────┘
                                    │ HTTP (browser, no central server)
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
 ┌────────────────┐       ┌──────────────────┐
 │  Browser-side  │       │  0G Compute      │
 │   value-net    │       │  coach LLM       │
 │   forward pass │       │  (Qwen 2.5 7B)   │
 │ (ONNX Runtime) │       │  via /api/coach  │
 └────────────────┘       └──────────────────┘
                                    │
                                    │ optional FastAPI service
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │  Training, agent wallets, keeper audit workflow,  │
        │  rules-engine re-walk, /agents, /games/*, /chat   │
        └───────────────┬───────────────────────────────────┘
                        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  Sepolia                          0G Storage                     │
 │  MatchEscrow                      Log:  per-match GameRecord     │
 │  MatchRegistry                    KV:   per-agent weights        │
 │  AgentRegistry                    KV:   per-agent style overlay  │
 │  PlayerSubnameRegistrar (ENS)     KV:   per-player style profile │
 └──────────────────────────────────────────────────────────────────┘
```

- **Browser** runs the agent value net (ONNX) and a TypeScript rules engine. The coach reaches 0G Compute via Next.js API routes (`/api/coach/hint`, `/api/coach/chat`) that talk to `@0glabs/0g-serving-broker` — no proxy process in the request path.
- **FastAPI service** is optional and runs locally. It hosts the trainer, agent-wallet keystore, the keeper-audit workflow, and `/chat` (with a Python coach client that falls back to a local model). The hosted Pages build does not include it; pages that depend on it (e.g. `/training`, agent wallets in `/match`) need it running on `localhost:8000`.
- **Rules engine** is duplicated as pure-TypeScript (`frontend/lib/rules_engine.ts`) and pure-Python (`agent/rules_engine.py`) implementations of the same logic. The Python version re-walks every move in the keeper audit workflow; the TypeScript version validates moves in the browser.
- **Sepolia** is the settlement chain; **0G Galileo Testnet** has the same contracts deployed too. Mainnet would be a chain swap; the design is identical.
- **Dice randomness** uses browser `crypto.getRandomValues` in live play. A verifiable-randomness path exists for the trainer (`agent/drand_dice.derive_dice` — `keccak256(drand_round_digest, turn_index) mod 36`) and as a `/games/{matchId}/dice` endpoint, but the live gameplay loop doesn't call it. Commit-reveal / VRF-backed dice for human-vs-human are roadmap (see `frontend/app/dice.ts`).

---

## Agent intelligence

Each agent is a small per-agent value network, initialised from gnubg's published feedforward weights (exported to `backgammon_net.onnx`). Same starting point across the protocol; what changes is what the owner trains on top.

**Where weights live.** Two pieces:

- **Shared base weights** — encrypted blob on 0G Storage, content-addressed; the Merkle root is pinned on-chain as `AgentRegistry.baseWeightsHash` (single global value, set once at deployment).
- **Per-agent trained weights** — written by the trainer to 0G KV at `chaingammon/weights/agent/{agent_id}`. KV writes overwrite in place with no per-run gas cost and no orphaned blobs. The tradeoff is that the KV is mutable and server-controlled (a single `OG_STORAGE_PRIVATE_KEY` has write access), and weights are not currently re-committed back to the on-chain `dataHashes[1]`. Buyers of an agent token therefore cannot today cryptographically verify the weights they receive — that's the gap full ERC-7857 with re-encryption-proof would close.

Inference at game time runs in the browser via ONNX Runtime Web. The optional FastAPI service exposes a 0G-Compute eval path (`og-compute-bridge/src/eval.mjs`) for offline-agent inference, but no backgammon-net provider is registered on the 0G serving network yet — that toggle is wired and waiting.

### Training

Two streams of training data feed a single replay buffer:

1. **Self-play.** Full matches against a frozen older checkpoint produce `(state, action, next_state, reward)` triples. The canonical TD-Gammon setup; how gnubg's own weights were originally trained.
2. **Refereed matches.** Every match settled on-chain archives a `GameRecord` to 0G Storage with a cryptographically attested outcome.

Updates are TD(λ) backprop with eligibility traces. After each move: `δ = r + γ V(s′) − V(s)`; weights step by `α · δ · e` where `e = γλ · e_prev + ∇V(s)` accumulates past gradients so a terminal reward propagates back to every position in the trajectory.

The career-mode head adds five contextual inputs — opponent style, teammate style, stake size (log1p-scaled), tournament position, team-match flag — projected into a 16-d vector so a single network handles solo and team modes without retraining. Style projects onto six axes (`opening_slot`, `phase_prime_building`, `runs_back_checker`, `phase_holding_game`, `bearoff_efficient`, `hits_blot`) drawn from the existing `agent_overlay.CATEGORIES` keys.

Gradient steps run locally for development. Production-grade TEE-attested training on 0G Compute (so a buyer could verify every weight update came from refereed match data) is roadmap and is the gap that re-introducing on-chain hash commits would help close.

Implementation: `agent/sample_trainer.py` (single-agent TD(λ) loop with TensorBoard event-file output), `agent/round_robin_trainer.py` (multi-agent), `agent/career_features.py` (slot layout + style-axes spec), `agent/agent_profile.py` (runtime resolver that content-sniffs the blob behind `dataHashes[1]` — JSON overlay vs torch checkpoint).

### Full-board encoding

`BackgammonNet` operates on the standard Tesauro 198-dim contact-net encoding via `agent/gnubg_encoder.py`. Self-play drives through real gnubg subprocesses (`agent/full_board_state.py`); checkpoints carry `feature_encoder: "gnubg_full"` so `POST /games/{id}/agent-move` with `use_per_agent_nn=true` scores real positions instead of the simplified pip-race fallback.

Producing a checkpoint (~30–60 min wall time):

```bash
cd agent
uv run python sample_trainer.py \
    --full-board --career-mode \
    --matches 100 \
    --save-checkpoint /tmp/agent7.pt \
    --upload-to-0g --no-encrypt \
    --logdir /tmp/agent7-tb
```

The trainer's `--upload-to-0g` path uploads to KV at `chaingammon/weights/agent/{id}`. After upload, `POST /games/{gameId}/agent-move` with `{"use_per_agent_nn": true}` loads the checkpoint and picks each move via NN argmax — ~500–1000 ms/move for 5–10 candidates (one gnubg subprocess per candidate). The gnubg+overlay fallback path remains the default.

### Sample trainer CLI

| Flag | Effect |
| --- | --- |
| `--matches N` | Self-play matches (default 100). |
| `--save-checkpoint <path>` | Write `state_dict` + metadata as a torch blob. |
| `--load-checkpoint <path>` | Resume from a prior checkpoint. |
| `--drand-digest <hex>` | Derive every turn's dice via `drand_dice.derive_dice(digest, turn_index)` instead of local PRNG. Fetch a round digest via `scripts/fetch_drand_round.py`. |
| `--upload-to-0g` | AES-256-GCM-encrypt the checkpoint, write the key to `<ckpt>.key`, upload sealed blob to 0G KV. |
| `--no-encrypt` | Upload raw `torch.save` bytes (no AES seal, no `.key` file). Demo-only — production should leave this off. |
| `--init-from-0g <key>` + `--init-key <path>` | Resume from a 0G Storage checkpoint. |
| `--career-mode` | Sample a fresh `CareerContext` per match. Requires `--extras-dim >= 16`. |
| `--full-board` | Use the gnubg 198-dim contact-net encoding (vs the simplified pip-race default). |
| `--logdir <path>` | TensorBoard event-file directory. Open with `tensorboard --logdir <path>` in another terminal. |

---

## Match archive on 0G Storage

Every completed match is preserved as a canonical, content-addressed archive on 0G Storage. The on-chain `MatchRegistry` stores metadata (timestamp, participants, winner, length); the full match — every move, every dice roll, the final position — lives off-chain on 0G Storage Log, and the on-chain record carries a cryptographic pointer to it.

Each match produces a `GameRecord` envelope — JSON, sorted keys, UTF-8, deterministic so the bytes always hash the same way:

| Field                                 | What it carries                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `match_length`, `final_score`         | match-point target and final score                                                               |
| `winner`, `loser`                     | each side's identity (a wallet address for humans, an ERC-721 token id for agents)               |
| `final_position_id`, `final_match_id` | gnubg's native base64 strings — any tool can reconstruct the end state                           |
| `moves`                               | the full play sequence: `(turn, dice, move, position_id_after)` per move                         |
| `cube_actions`                        | doubling-cube events (offer / take / drop / beaver / raccoon)                                    |
| `started_at`, `ended_at`              | ISO-8601 UTC timestamps                                                                          |

Sized at ~2–10 KB compressed per match. A player with 1,000 lifetime matches has ~5–10 MB of game data.

At game end the frontend builds the `GameRecord`, uploads the JSON to 0G Storage (the indexer returns a 32-byte Merkle `rootHash`), and calls `MatchRegistry.settleWithSessionKeys(...)` which permanently links the match metadata to the archive. Anyone can later resolve a match by id, fetch the bytes, and replay the game move-by-move — no login, no API key.

---

## ENS as protocol identity

Chaingammon uses ENS subnames as a verifiable, composable reputation primitive that any third-party tool reads without coordinating with us.

- **Verified, not claimed.** Five text record keys (`elo`, `match_count`, `last_match_id`, `kind`, `inft_id`) are reserved on-chain in `PlayerSubnameRegistrar`. Only the contract owner can write them; on-chain `setText` rejects subname-owner writes via a `bytes32 → bool` reserved-key map.
- **One identity layer for humans and agents.** Both register under `chaingammon.eth`. The `kind` text record (`"human"` or `"agent"`) discriminates. When an agent token is minted via `AgentRegistry.mintAgent`, the contract atomically mints the corresponding subname and sets `kind="agent"` + `inft_id=<tokenId>` in the same transaction.
- **Cross-protocol composability.** A betting market reads `text(namehash("alice.chaingammon.eth"), "elo")` to price a match. A tournament organiser walks `subnameCount()` + `subnameAt(i)` to enumerate ranked players. None of them touch our API.

Full schema: [docs/ENS_SCHEMA.md](docs/ENS_SCHEMA.md).

---

## Compute backends

Two compute operations can run locally or on **0G Compute**. State persists in `localStorage["chaingammon.computeBackends"]`; the compute pill in the frontend header flips it.

| Operation | Local | 0G Compute | Status |
| --- | --- | --- | --- |
| **Coaching** (Qwen 2.5 7B chat hints) | Python coach in the FastAPI service (`agent/coach_service.py`, flan-t5-base fallback) | `frontend/app/api/coach/*` → `@0glabs/0g-serving-broker` | 0G path is live on testnet. The local path requires the FastAPI service. |
| **Inference** (`BackgammonNet.forward → equity`) | `torch` call in the trainer; ONNX Runtime Web in the browser | `og-compute-bridge/src/eval.mjs` → `agent/og_compute_eval_client.evaluate()` | Plumbing is wired end-to-end. **No backgammon-net provider exists on the 0G serving network yet** — calls return `available: false` until one is registered. |

Training is local: `agent/round_robin_trainer.py` runs the control loop, optimiser steps, and weight saves locally. A `--use-0g-inference` flag exists to route per-move forward passes through the eval bridge once a backgammon-net provider is registered.

### Env vars

```
OG_STORAGE_RPC              0G testnet/mainnet RPC
OG_STORAGE_INDEXER          0G Storage indexer URL
OG_STORAGE_PRIVATE_KEY      funded wallet (pays for inference + storage)

OG_COMPUTE_PROVIDER          (coach)     pin a chat provider
OG_COMPUTE_EVAL_PROVIDER     (inference) pin a backgammon-net provider
BACKGAMMON_NET_MODEL         (inference) listService filter (default backgammon-net-v1)
OG_COMPUTE_PER_INFERENCE_OG  fallback per-inference price (default 0.00001)
OG_COMPUTE_MIN_BALANCE       sub-account min OG balance (default 0.01)
OG_COMPUTE_DEPOSIT           initial ledger deposit (default 0.05)
```

### Cost expectations

- **Coach** ≈ 0.0001 OG per chat completion.
- **Inference** ≈ 0.00001 OG per forward pass (placeholder until a real backgammon-net provider publishes live rates).

---

## Coach

The coach is a turn-by-turn conversation, not one-shot narration. Per turn the agent considers the human's history, the opponent's style, and the dialogue so far; corrections ("I prefer running games, stop suggesting primes") become per-session preferences that bias later turns within the same match. The signal is session-local UX adaptation; it expires when the session ends and does **not** feed agent training.

Two endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/coach/chat` | Turn-by-turn dialogue. Three message kinds: `open_turn` (initial take after dice roll), `human_reply` (response to the human's text), `move_committed` (acknowledgement). |
| `POST /api/coach/hint` | One-shot single-sentence narration for users who don't want a back-and-forth. |

The Next.js routes target 0G Compute. The FastAPI service exposes `/chat` and `/hint` mirrors with a local flan-t5-base fallback for development.

Design: [docs/coach-dialogue.md](docs/coach-dialogue.md).

### Team mode

A human and an agent (or any 2v2 mix) play as teammates against an opponent. Per turn the captain receives advisor signals from each teammate (`{teammate_id, proposed_move, confidence, optional_message}`); the captain decides; both contributions are logged into the match record. **MVP captain rule:** the captain ignores advisors at pick time — its own move is final, signals are archived not consumed. Vote fusion / confidence-weighted rank fusion is a follow-up; every signal is on the on-chain record, so a future endpoint that re-ranks captain picks against archived advisors lights up retroactively.

API surface:

- `POST /games` accepts optional `team_a` and `team_b` rosters (each `{members: PlayerRef[], captain_rotation: "alternating" | "fixed_first" | "per_turn_vote"}`).
- Each `/agent-move` computes the captain via `team_mode.captain_index`, scores every non-captain teammate via `teammate_advisor.score_advisor_move`, and returns `AdvisorSignal[]` + `captain_id` alongside the new `GameState`.
- Signals archive in `MoveEntry.advisor_signals` and propagate into the on-chain `GameRecord` commitment.
- `/team-demo` exercises the flow end-to-end.

Design: [docs/team-mode.md](docs/team-mode.md).

---

## Staked matches

A match can be free (ELO-only) or staked (per-side ETH deposit, winner takes the pot). The two paths share the same `MatchRegistry` write — only the escrow wiring differs.

**Contracts.** `MatchRegistry.recordMatch` and `recordMatchAndSplit` are gated by `onlyOwnerOrSettler` rather than `onlyOwner`, so a hosted orchestrator can submit settlements without holding the deployer key. Owner-only `setSettler(address)` grants and revokes that role; zero-address default keeps original behaviour. `MatchEscrow.settler` is `immutable` so its constructor pins it to the active `MatchRegistry` — a fresh `MatchRegistry` deploy requires a fresh `MatchEscrow` deploy too.

**Agent wallets.** Each agent gets a dedicated EOA whose private key is generated server-side, encrypted as a v3 JSON keystore at `server/data/agent_keys/<agentId>.json` (passphrase from `AGENT_KEYSTORE_PASSPHRASE`, 0600 file perms). The owner pre-funds by sending ETH to the wallet's address; `POST /agents/{id}/withdraw` drains. The server holds the key for the agent's lifetime; on-chain owner authorisation (EIP-712) is a follow-up.

**Flow.** Human deposit (`MatchEscrow.deposit` via wagmi) → `POST /agents/{id}/deposit` (server signs from agent wallet) → game → `POST /finalize-direct-staked` calls `recordMatchAndSplit` (atomic record + payout).

Endpoints (`server/app/main.py`):

| Endpoint | Body | Purpose |
| --- | --- | --- |
| `GET  /agents/{id}/wallet` | — | Address + balance. |
| `POST /agents/{id}/wallet` | — | Idempotent create. |
| `POST /agents/{id}/deposit` | `{match_id, stake_wei}` | Server signs `MatchEscrow.deposit`. |
| `POST /agents/{id}/withdraw` | `{to, amount_wei?}` | Drain to `to` (omit `amount_wei` → drain everything minus 21k gas). |
| `POST /finalize-direct-staked` | `DirectFinalizeRequest + {escrow_match_id, stake_wei}` | Atomic settle + payout. |

**Operator note:** set `AGENT_KEYSTORE_PASSPHRASE=<something>` in `server/.env` before starting the server, otherwise `AgentWalletManager.from_env()` raises and the wallet endpoints 503.

Frontend: `frontend/app/match/page.tsx` + `AgentWalletPanel.tsx` — agent address (click-to-copy), live balance, "Fund X ETH", "Withdraw all". A `depositStatus` state machine drives the Start button across both deposits.

---

## Keeper audit workflow

`server/app/keeper_workflow.py` is a local Python orchestrator that exercises a KeeperHub-shaped audit flow over a finalised matchId. The actual third-party KeeperHub integration is roadmap; the workflow is shaped so the eventual external runner can drop in.

Eight sequential steps:

| # | Step ID | What it does |
| - | --- | --- |
| 1 | `escrow_deposit` | Reads MatchInfo from MatchRegistry; fails if the match isn't on-chain. |
| 2 | `vrf_rolls` | Probes the drand mainnet HTTP endpoint to confirm the VRF source the trainer uses is reachable. |
| 3 | `og_storage_fetch` | Pulls the GameRecord blob from 0G Storage by the rootHash in MatchInfo. |
| 4 | `rules_check` | Walks every recorded move through the pure-Python rules engine (`agent/rules_engine.py`). A single illegal move halts the workflow. |
| 5 | `settlement_signed` | Confirms MatchInfo presence (session-key flow pre-authorises; the relay tx itself is the proof). |
| 6 | `relay_tx` | Surfaces `gameRecordHash` as the canonical audit anchor. |
| 7 | `ens_update` | Cross-checks `elo` + `last_match_id` text records on each labelled subname; skips cleanly for unnamed / agent-vs-agent matches. |
| 8 | `audit_append` | Serialises the entire workflow run to JSON, uploads to 0G Storage, surfaces the rootHash as the audit-trail anchor. |

Trigger via `POST /keeper-workflow/{matchId}/run`. The workflow runs on a background thread; `GET /keeper-workflow/{matchId}` polls return live mid-run progress, persisted to `/tmp/chaingammon-keeper-workflows/<matchId>.json` so navigating away during a long-running step doesn't lose state. A step failure marks itself "failed" with the exception message in `error`, the workflow status flips to "failed", and remaining steps stay "pending".

Workflow spec: [docs/keeperhub-workflow.md](docs/keeperhub-workflow.md). Integration feedback: [docs/keeperhub-feedback.md](docs/keeperhub-feedback.md).

---

## Running locally

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv)
- Node 20+, [pnpm](https://pnpm.io)
- `gnubg` (for local debugging only) — `sudo apt install gnubg` (Ubuntu/Debian) or `brew install gnubg` (macOS)

### One-time setup

```bash
git clone <repo> && cd chaingammon
pnpm install                    # frontend + contracts (workspace)
cd agent && uv sync && cd ..    # agent Python deps
cp contracts/.env.example contracts/.env       # add DEPLOYER_PRIVATE_KEY + Sepolia RPC_URL
cp frontend/.env.example frontend/.env.local
```

Fund the deployer wallet with Sepolia ETH from any public faucet.

### Bootstrap and run

```bash
# 1. deploy + verify settlement contracts on Sepolia (one shot)
./scripts/bootstrap-network.sh

# 2. (optional) start the FastAPI backend for training, agent wallets,
#    the keeper audit workflow, and the local coach fallback
cd server && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

# 3. start the frontend
pnpm frontend:dev                # Next.js on :3000
```

Or use VS Code Tasks (`.vscode/tasks.json`) — `Tasks: Run Task` → `Localhost: launch all` chains hardhat node → deploy contracts → FastAPI server → Next.js frontend in their own terminal tabs.

### Local dev with Hardhat

```bash
cd contracts && pnpm exec hardhat node            # local chain (chainId 31337)
cd contracts && pnpm exec hardhat run script/deploy.js --network localhost
# addresses are written to contracts/deployments/localhost.json and read by the frontend automatically
```

Switch chains in your wallet; the frontend re-targets the new chain's contracts automatically (see `frontend/app/chains.ts`).

### Tests

```bash
pnpm test                  # all tests: agent (pytest) + contracts (hardhat) + frontend (build)
pnpm contracts:test
pnpm agent:test
pnpm frontend:test
```

---

## Frontend routes

| Route | Page | Backend dependency |
| --- | --- | --- |
| `/` | Agent discovery + matchmaking | On-chain reads via wagmi; AgentCard polls `/agents/{id}/profile` from the FastAPI service (degrades gracefully when absent) |
| `/team-demo` | Off-chain game vs agent (no stake) | Browser-only — ONNX Runtime Web |
| `/team-demo?settle=1&opponents=N` | On-chain game vs agent (ELO + optional stake) | Browser + `MatchRegistry`; settle path uses session keys |
| `/match?agentId=N` | Pre-game card; forwards to `/team-demo?opponents=N&settle=1` | `AgentRegistry` + `MatchEscrow`; agent-wallet panel needs the FastAPI service |
| `/profile/[ensName]` | Player profile (ENS text records) | `PlayerSubnameRegistrar.text()` |
| `/log/[matchId]` | Match replay + audit trail | 0G Storage |
| `/training` | Round-robin trainer control panel | FastAPI service (`/training/*`); TensorBoard event files written to a temp logdir, view with `tensorboard --logdir <path>` |
| `/keeper/[matchId]` | Audit-workflow status page | FastAPI service (`/keeper-workflow/*`) |

---

## Deployed contracts

**Sepolia:**

- [MatchRegistry](https://sepolia.etherscan.io/address/0x507d78149AE2092a5438825B1BA3F12737FAeC0C)
- [MatchEscrow](https://sepolia.etherscan.io/address/0x1206A93a9B76652382BC1F5164a8383a9F2A2e16)
- [AgentRegistry](https://sepolia.etherscan.io/address/0xE23B83cE16B292e420cd8820ac9d303A45333D17)
- [PlayerSubnameRegistrar](https://sepolia.etherscan.io/address/0x48285B8C9B04C6a3D61bBA067a4DE4399A5a4aEb)

**0G Galileo Testnet:**

- [MatchRegistry](https://chainscan-galileo.0g.ai/address/0x60E52e2d9Ea7b4A851Dd63365222c7d102A11eaE)
- [AgentRegistry](https://chainscan-galileo.0g.ai/address/0xCb0a562fa9079184922754717BB3035C0F7A983E)
- [PlayerSubnameRegistrar](https://chainscan-galileo.0g.ai/address/0xf260aE6b2958623fC4e865433201050DC2Ed1ccC)

Full deployment records (constructor args, deployer, block heights): `contracts/deployments/*.json`.

---

## Roadmap

- **Now:** human-vs-agent gameplay; on-chain ELO; ENS subnames; agent tokens with shared on-chain base-weights hash; per-agent weights in 0G KV; 0G Storage match archive; optional stakes with atomic settle-and-pay; local keeper audit workflow.
- **Next:** verifiable dice (commit-reveal or drand-derived) wired into live gameplay; full ERC-7857 transfer-with-reencryption-proof so per-agent weights are cryptographically bound to the token; backgammon-net provider on the 0G serving network so inference can run on 0G Compute; TEE-attested training on 0G Compute; integration with the actual KeeperHub orchestrator (the current workflow is a local Python implementation of the shape).
- **Later:** all-agent autonomous tournaments; team / chouette mode with career-head fusion; per-agent cube doubling; ZK proofs of agent inference (zkML); betting markets; mainnet on Base/Optimism.

See [ROADMAP.md](ROADMAP.md) for the full version. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).
