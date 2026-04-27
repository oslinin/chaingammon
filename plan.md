# Chaingammon — ETHGlobal Open Agents Submission Plan

> **Read this first if you are an AI coding agent working on this repo.**
> This is the build plan. Work through phases in order. Each phase introduces at most one new tool or sponsor and is independently testable. Stop and ask the human owner before deviating from scope.

---

## 1. Context

**Project:** Chaingammon — see `MISSION.md` for the full vision (open backgammon protocol with on-chain ELO and portable reputation).

**Hackathon:** ETHGlobal Open Agents (async).

- Live: April 24 – May 6, 2026
- Submit via the ETHGlobal hacker dashboard
- Confirm exact submission deadline on the event page before final commit

**Sponsors used and where they fit:**

- **ENS** — subnames + text records are the right primitive for portable player identity. Every player gets `<name>.chaingammon.eth`. Reputation moves with the name.
- **0G** — agent iNFTs (ERC-7857) live on 0G Chain; per-match game records, encrypted gnubg weights, and per-agent experience overlays live on 0G Storage. Both are needed for the agent-as-asset model.
- **KeeperHub** — match settlement is a multi-step orchestration (recordMatch + ENS text record updates + agent overlay update). KeeperHub's workflow primitive handles retry, gas, and audit cleanly.
- **Main track** — the open-protocol thesis stands on its own.

**Time budget:** ~36 hrs total over remaining ~10 days (Phases 0–2 already done). Evenings only, ~3.5 hrs/evening. Each phase is small (~1–3 hrs) so progress is steady and resume-able. If evenings are shorter, ship the cut-list (see Section 6).

**Builder profile:** Strong Python/Linux. Some Solidity (deployed templates). Comfortable with FastAPI, weak on React/wagmi.

---

## 2. Thesis

> Chaingammon is an **open protocol for portable backgammon reputation**. Every player — human or AI — has an ENS subname (`alice.chaingammon.eth`) whose text records hold their ELO and a link to their full match archive on 0G Storage. AI agents are minted as ERC-7857 iNFTs with **two data hashes**: a shared base-weights hash (gnubg's neural network, encrypted on 0G Storage) and a per-agent **experience overlay** that grows after each match. Agents come in tiers (beginner → world-class, mapped to gnubg's search settings) and accumulate a learned playing style on top. Match settlement runs as a KeeperHub workflow that records the result on-chain, updates ENS text records, refreshes the agent's experience hash, and produces a verifiable audit trail mirrored to 0G Storage. Any third-party tool can read a player's ENS name and reconstruct their full reputation: ELO, games played, playing style.

**The 3-minute demo video shows:**

1. Open web app, connect wallet → ENS subname auto-issued (`alice.chaingammon.eth`)
2. Pick `gnubg-advanced-1.chaingammon.eth` (an agent iNFT) — show its iNFT on 0G explorer: tier (advanced), base weights hash, experience overlay hash, match count
3. Play a quick game — agent's moves come from gnubg-tier-2 + the agent's learned overlay
4. Game ends → KeeperHub workflow fires → recordMatch on-chain → ENS text records updated → agent's experience overlay refreshed and new hash committed to iNFT → game archive uploaded to 0G Storage
5. Show the updated ENS profile (`alice.chaingammon.eth` → ELO 1547), the agent iNFT with bumped `experienceVersion`, the match replay rendered from 0G Storage, and the KeeperHub audit trail. A fresh advanced agent vs the same agent with 20 matches — overlays are different, play differs.

---

## 3. Architecture

```
                       ┌──────────────────────────┐
                       │    Frontend (Next.js)    │
                       │    - matchmaking         │
                       │    - profile (ENS)       │
                       │    - match replay        │
                       │    - audit trail         │
                       └────────────┬─────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
   ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
   │  Game Server  │       │  ENS resolver │       │  0G Storage   │
   │  (FastAPI)    │       │  text records │       │  (read game   │
   │  - gnubg      │       │  per player   │       │   records and │
   │  - dice       │       │               │       │   styles)     │
   │  - serializes │       └───────────────┘       └───────────────┘
   │     games     │
   └──────┬────────┘
          │ on game-end
          ▼
   ┌──────────────────────────────────────────────┐
   │  KeeperHub workflow                          │
   │   1. recordMatch (with gameRecordHash)       │
   │      on MatchRegistry                        │
   │   2. update ENS text records (both players)  │
   │   3. updateOverlayHash on AgentRegistry      │
   │      (if match involved an agent)            │
   │   4. emit audit JSON                         │
   └────┬───────────────────────┬─────────────────┘
        │                │
        ▼                ▼
 ┌──────────────┐ ┌────────────────────────────────────┐
 │   0G Chain   │ │       0G Storage                   │
 │ AgentRegistry│ │  Log (per match): game record      │
 │  + tier      │ │  Log (per match): audit data       │
 │  + dataHashes│ │  KV (per human): style profile     │
 │ MatchRegistry│ │  Blob (shared): encrypted gnubg    │
 │ EloMath      │ │    base weights (one for everyone) │
 │ ENS registrar│ │  Blob (per agent): experience      │
 │              │ │    overlay (grows with play)       │
 └──────────────┘ └────────────────────────────────────┘
```

**Out of scope (roadmap items):**

- Commit-reveal dice / VRF (v2 — server-side dice with honesty note in v1)
- Betting / prediction markets
- ELO derivative tokens
- Anti-cheat for human ratings
- 0G Compute for verifiable inference (v3)
- ZK proofs for move provenance (v3)
- Gensyn (skipped — training surface too small)

---

## 4. Repo Layout

```
chaingammon/
├── MISSION.md
├── plan.md                       (this file)
├── log.md                        (pivot narrative + decision log)
├── README.md
├── CONTEXT.md
├── ARCHITECTURE.md
├── ROADMAP.md
├── server/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py
│   │   ├── gnubg_client.py
│   │   ├── game_state.py
│   │   ├── game_record.py        (NEW — serializer for 0G Storage)
│   │   ├── chain_client.py
│   │   ├── og_storage_client.py  (NEW — 0G Storage SDK wrapper)
│   │   ├── ens_client.py         (NEW — text record updates)
│   │   └── keeperhub_client.py   (NEW — workflow trigger + audit pull)
│   └── tests/
├── contracts/
│   ├── src/
│   │   ├── AgentRegistry.sol     (UPGRADED to ERC-7857)
│   │   ├── MatchRegistry.sol     (+ gameRecordHash field)
│   │   ├── EloMath.sol
│   │   └── PlayerSubnameRegistrar.sol  (NEW — ENS subname registrar)
│   ├── script/
│   ├── test/
│   └── hardhat.config.js
├── frontend/
│   ├── package.json
│   ├── app/
│   │   ├── page.tsx
│   │   ├── play/[agentId]/page.tsx
│   │   ├── profile/[ensName]/page.tsx       (NEW)
│   │   └── match/[matchId]/page.tsx         (NEW — replay + audit)
│   └── lib/
│       ├── wagmi.ts
│       └── contracts.ts
└── docs/
    ├── demo-script.md
    └── keeperhub-feedback.md     (NEW — required for KeeperHub bounty)
```

---

## 5. Build Phases

Each phase introduces **at most one** new tool or sponsor. Each phase is independently testable. TDD throughout — tests first, red, then green.

### Phase 0 — Scaffolding (1 hr) ✅ DONE

**Goal:** Repo skeleton, dev environments working.

Tasks:

- Create directory structure
- Init `server/` (Python 3.11+, FastAPI, pydantic, web3, httpx, pytest)
- Init `contracts/` with Hardhat
- Init `frontend/` with Next.js + TypeScript + wagmi + viem
- `.env.example` files in each sub-project
- `.gitignore` covering Python, Node, Hardhat artifacts, `.env`

**Done when:** All three start without errors (`uv run uvicorn`, `pnpm exec hardhat compile`, `pnpm dev`).

### Phase 1 — gnubg wrapper service (3 hrs) ✅ DONE

**Goal:** FastAPI service exposing backgammon engine via gnubg's External Player interface.

Tasks:

- Install gnubg (`sudo apt install gnubg`)
- `app/gnubg_client.py` — class managing gnubg subprocess. Methods: `new_match(length)`, `submit_move(board_state, dice, move)`, `get_agent_move(board_state, dice)`, `is_game_over()`, `winner()`
- `app/game_state.py` — typed GameState model (24-point board, bar, off notation matching gnubg)
- `app/main.py` — FastAPI endpoints:
  - `POST /games` — new game vs agent ID
  - `GET /games/{game_id}` — current state
  - `POST /games/{game_id}/roll` — server rolls dice
  - `POST /games/{game_id}/move` — human move
  - `POST /games/{game_id}/agent-move` — request agent response
  - `POST /games/{game_id}/resign` — concede
- In-memory game store (SQLite if time allows)
- Tests: one end-to-end happy path (2-point match to completion)

**Honesty note:** Server rolls dice, so server is trusted per match. Document clearly. Commit-reveal is v2.

**Done when:** pytest test plays full game, agent moves are legal.

### Phase 2 — Core contracts: EloMath, MatchRegistry, AgentRegistry as ERC-721 ✅ DONE

**Goal:** Local-only contracts with a clean test suite. No new tool introduced — Hardhat already in place.

Tasks:

- `EloMath.sol` library — K=32, INITIAL=1500, lookup-table expected score, integer math, floor at 0
- `MatchRegistry.sol` — owner-only `recordMatch`; default 1500 ELO; `MatchRecorded` and `EloUpdated` events
- `AgentRegistry.sol` — OpenZeppelin ERC-721, `mintAgent`, `agentMetadata`, `agentElo` proxy
- Unit tests for all three
- Deploy script exists (`script/deploy.js`) and exits without error against an in-process Hardhat node — but no persistent agent is minted at this stage. Persistent minting is Phase 4 (testnet).

**Done when:** All hardhat tests green (32 passing). Deploy script compiles and exits without error.

---

### Phase 3 — Add `gameRecordHash` field to MatchRegistry (1 hr)

**New tool:** none (extends Phase 2's MatchRegistry).

**Goal:** Match struct gains `bytes32 gameRecordHash` field; `recordMatch` accepts and stores it; new event `GameRecordStored(matchId, hash)`. Field can be `bytes32(0)` (unset) for backward compatibility.

Tasks:

- TDD: write a test asserting `recordMatch(...)` accepts a hash arg and stores it
- Update `MatchRegistry.sol`
- Update existing test calls to pass `bytes32(0)` where the hash isn't known yet
- Re-run all hardhat tests

**Done when:** All tests green, struct includes `gameRecordHash`.

### Phase 4 — Deploy contracts to 0G testnet (1 hr)

**New tool/sponsor:** **0G Chain testnet.**

**Goal:** Existing contracts live on 0G testnet. Real RPC, real signer, real gas.

Tasks:

- Generate or pick a deployer wallet, fund via faucet (https://build.0g.ai)
- Set `DEPLOYER_PRIVATE_KEY` in `contracts/.env`
- `pnpm contracts:deploy` against `0g-testnet`
- Save addresses to `contracts/deployments/0g-testnet.json` and `frontend/app/contracts.ts`
- Verify on https://chainscan-galileo.0g.ai
- Mint a seed agent (`gnubg-classic-v1`) from the deploy script

**Note:** Phase 5 redeploys a new AgentRegistry with ERC-7857 + tier, so this v1 agent will be superseded. That's intentional — Phase 4 is a smoke test that the deploy pipeline works end-to-end on testnet before we add iNFT complexity. Cost: gas on testnet (free).

**Done when:** AgentRegistry + MatchRegistry both visible on 0G explorer; seed agent mint tx confirmed.

### Phase 5 — Upgrade AgentRegistry to ERC-7857 (2 hrs)

**New tool/sponsor:** **ERC-7857 (iNFT standard).**

**Goal:** AgentRegistry conforms to ERC-7857 so the agent's intelligence (base weights + learned experience overlay) can be cryptographically tied to the iNFT.

**iNFT data model:**

```
Agent iNFT carries:
  - tier (uint8)              — 0=beginner, 1=intermediate, 2=advanced, 3=world-class. Set at mint, immutable. Maps to gnubg search-ply settings.
  - dataHashes[0]              — base gnubg weights hash. Same hash for all agents. Verifies "this agent uses real gnubg base weights."
  - dataHashes[1]              — experience overlay hash. Unique per agent. Updates after each match (via Phase 9).
  - matchCount (uint32)        — increments per match
  - experienceVersion (uint32) — increments when overlay is updated
```

The point of two data hashes: one provides shared verifiability (base is real gnubg), the other provides unique embedded intelligence per agent (overlay grows with experience).

Tasks:

- Find ERC-7857 reference impl. If clean, use it. If reference is unstable, write a minimal compliant subset that supports an array of data hashes per token.
- TDD: write tests for
  - `dataHashes(agentId) -> bytes32[2]` (returns [base, overlay])
  - `tier(agentId) -> uint8`
  - `updateOverlayHash(agentId, newHash)` — owner-only (server) for v1
  - `experienceVersion(agentId) -> uint32`
- Update `AgentRegistry.sol` to extend ERC-7857; `mintAgent` now takes a `tier` argument
- Redeploy to 0G testnet
- **Fallback (if ERC-7857 isn't ready):** stay on ERC-721 with custom `dataHashes` mapping; document in submission that the protocol shape is 7857-compatible.

**Done when:** A re-minted seed agent has tier set, both data hashes populated, ERC-7857 (or fallback) interface returns expected values; all hardhat tests green.

### Phase 6 — 0G Storage SDK setup (1 hr)

**New tool/sponsor:** **0G Storage.**

**Goal:** A `og_storage_client.py` module that can `put_blob(bytes) -> hash` and `get_blob(hash) -> bytes` against 0G Storage testnet. Hello-world only.

Tasks:

- Read 0G Storage docs (https://docs.0g.ai), pick the right SDK (Python or HTTP gateway)
- Create `server/app/og_storage_client.py`
- TDD: integration test — upload a known blob, read it back, assert equality
- Configure `OG_STORAGE_*` env vars in `server/.env.example`

**Done when:** Round-trip blob through 0G Storage works in CI/locally.

### Phase 7 — Game records on 0G Storage Log (per match) (2 hrs)

**New tool/sponsor:** none (uses Phase 6's 0G Storage SDK).

**Goal:** Each completed match's full game record (gnubg `.mat` format wrapped in JSON) is uploaded to 0G Storage. The blob hash is the value passed to `recordMatch`'s `gameRecordHash` field.

Tasks:

- `server/app/game_record.py` — define the JSON envelope. Fields: matchId, players, dice sequence, move sequence, cube actions, final position, timestamps, gnubg .mat embed.
- On game-end in `server/app/main.py`, serialize → upload to 0G Storage → call `recordMatch` with the hash
- TDD: end-to-end test — play a 1-point match, assert game record uploaded, hash matches what's on-chain

**Done when:** A completed match has a 0G Storage entry whose hash is committed in MatchRegistry.

### Phase 8 — Base gnubg weights on 0G Storage (shared, encrypted) (2 hrs)

**New tool/sponsor:** none (continues 0G Storage).

**Goal:** Upload gnubg's default weights file to 0G Storage **once** as a shared base. All agents reference the same blob via `dataHashes[0]`. Per-agent differentiation comes from tier (Phase 5) and experience overlay (Phase 9), not different base weights — gnubg's "skill levels" are settings, not separate weight files.

Tasks:

- Encrypt `gnubg_ts0.weights` (or equivalent default file) with AES-GCM. v1 key management: a server-held key is fine; per-owner encryption is v2.
- Upload to 0G Storage once → record the resulting hash as `BASE_WEIGHTS_HASH` constant
- Update deploy script: when minting any agent, populate `dataHashes[0]` with `BASE_WEIGHTS_HASH`
- Document the runtime/intelligence split in `CONTEXT.md`: gnubg = inference runtime, weights = learned intelligence, both required to run an agent
- TDD: mint two agents at different tiers, fetch their `dataHashes[0]`, assert they match `BASE_WEIGHTS_HASH`; decrypt the blob and verify it matches the source file

**Done when:** Both seed agents (e.g. one beginner, one advanced) hash-commit to the same base weights blob on 0G Storage; the blob is decryptable and verifies.

### Phase 9 — Agent experience overlay (light learning loop) (2 hrs)

**New tool/sponsor:** none (continues 0G Storage).

**Goal:** Each agent has a small per-agent **experience overlay** that biases gnubg's move recommendations and grows with play. Overlay is stored on 0G Storage; its hash lives at `dataHashes[1]` of the iNFT and updates after each match. This is the "embedded intelligence that learns" story.

#### What the agent is learning (and what it's NOT)

**It IS learning** which categories of behavior correlate with its own wins vs losses across its match history. After many matches it has a personalized lean — for example, "I tend to win when I play slot openings and double aggressively, so I prefer those." Two iNFTs minted at the same tier but played differently will drift into measurably different playing styles. The drift is the iNFT's unique embedded intelligence.

**It is NOT learning:**

- Position evaluation — gnubg still does that. The neural net stays frozen.
- Move legality, dice math, bear-off mechanics — gnubg handles those.
- New strategies outside the predefined categories. The category list is hand-coded.
- Opponent modeling. The agent doesn't track who it's playing against.
- Anything that requires backprop or a real RL loop.

This is a tendency tracker, not a learner in the deep-RL sense. After 50 matches the iNFT plays measurably differently than it did fresh — that's what makes the iNFT meaningful as an asset rather than a label.

#### The overlay vector

A ~50-float vector. Initial value: all zeros (no bias). Categories include:

- **Opening style:** slot, split, builder, anchor (4 entries)
- **Cube aggressiveness:** offer threshold, take threshold (2)
- **Bear-off timing:** safe (avoid leaves) vs efficient (max pip-off) (2)
- **Risk profile:** hit-exposure tolerance, blot-leaving tolerance (2)
- **Game phase tendencies:** prime-building, race-conversion, back-game commitment (~6)
- ... plus reserve slots for v2 categories

Each entry `v[c]` is in [-1, 1]. `v[c] = 0` means no bias. Positive means "lean toward this category." Negative means "lean against."

#### Inference flow (per turn)

1. Server starts gnubg with the agent's `tier` setting (`set player gnubg ply N`)
2. gnubg generates ranked candidate moves with equity scores
3. For each candidate, server computes `biased_score = gnubg_equity + sum(v[c] * classifier_c(move) for c in CATEGORIES)`
4. Server picks `argmax(biased_score)` and submits to gnubg
5. The bias is small enough that gnubg's equity dominates obvious-best moves but tilts close calls

`classifier_c(move)` returns a value in [0, 1] indicating how strongly the move falls in category `c`. These are hand-coded heuristics in v1 (e.g., `is_slot_opening(move)`, `is_aggressive_cube(decision)`), based on board features gnubg already reports.

#### Update rule (after each match)

```python
LEARNING_RATE = 0.05
DAMPING_N = 20

def update_overlay(v, agent_moves, won, match_count):
    # Step 1: compute exposure per category — how much the agent leaned into each
    exposure = {c: 0.0 for c in CATEGORIES}
    for move in agent_moves:
        for c in CATEGORIES:
            exposure[c] += classifier_c(move)
    total = sum(exposure.values()) + 1e-9
    exposure = {c: x / total for c, x in exposure.items()}

    # Step 2: outcome signal (-1 lose, +1 win; optionally scale for gammons)
    outcome = +1 if won else -1

    # Step 3: damped reinforcement
    # alpha is high early (matches move overlay a lot) and decays as match_count grows
    alpha = DAMPING_N / (DAMPING_N + match_count)
    new_v = {}
    for c in CATEGORIES:
        proposed_delta = LEARNING_RATE * outcome * exposure[c]
        v_proposed = v[c] + proposed_delta
        new_v[c] = (1 - alpha) * v[c] + alpha * v_proposed
        new_v[c] = max(-1.0, min(1.0, new_v[c]))  # clip
    return new_v
```

**Worked example.** Fresh advanced agent. `v = [0, 0, ...]`, `match_count = 0`. Plays a match, wins. During play: 60% slots, 30% splits, aggressive cube, efficient bear-off.

After the match, with `outcome = +1` and `match_count = 0`:
- `alpha = 20 / (20 + 0) = 1.0`
- `v[slot] += 0.05 * 1 * 0.30 = +0.015`
- `v[split] += 0.05 * 1 * 0.15 = +0.0075`
- `v[cube_aggressive] += 0.05 * 1 * 0.20 = +0.010`
- ... etc

Tiny but real biases pointing at what won.

After 50 matches with similar style, `v[slot] ≈ 0.35`, `alpha ≈ 0.286`. A new win adds only `~0.004` to `v[slot]` — stable, not runaway. Single losses nudge down by similar amounts. The overlay converges on the agent's actual winning style.

**Why this update rule:**

- **Outcome-driven** — wins reinforce; losses discourage
- **Exposure-weighted** — only updates categories the agent actually used in this match (no spurious updates)
- **Damped** — early matches matter more (warm-start); later, individual matches matter less (stability)
- **Bounded** — clip prevents runaway in either direction
- **No backprop, no RL infrastructure** — pure dict math, runs in milliseconds

#### Tasks

- `server/app/agent_overlay.py`
  - `CATEGORIES` — the canonical list
  - `classifier_c(move)` — hand-coded heuristics, one per category, return [0, 1]
  - `apply_overlay(gnubg_candidates, v) -> ranked_moves` — bias step from inference flow
  - `update_overlay(v, agent_moves, won, match_count) -> v_new` — exact pseudocode above
  - Serialize/deserialize as JSON for 0G Storage (~2KB blob)
- Hook into `server/app/main.py` game-end flow:
  1. Read current overlay from 0G Storage (via `dataHashes[1]`)
  2. Run `update_overlay`
  3. Upload new overlay blob to 0G Storage → get new hash
  4. Pass new hash to KeeperHub workflow trigger payload (server-side wiring in Phase 18)
  5. Workflow step (defined in Phase 17) calls `updateOverlayHash(agentId, newHash)` on `AgentRegistry`
- Separate **per-human style profile** stays on 0G Storage KV — descriptive stats only (% openings, avg cube acceptance, win rate vs each tier), no learning loop, just for display on the human's profile page
- TDD:
  - Unit: feed a synthetic match (3 slots, agent won) → assert `v[slot]` increased by expected amount
  - Unit: feed 50 synthetic matches, assert `v` converges and stays bounded
  - Integration: play 5 matches against a beginner agent → assert overlay blob hash changed each time → assert iNFT's `dataHashes[1]` matches latest blob → assert `experienceVersion` incremented per match
  - Integration: same agent at match 0 vs match 30 picks measurably different moves on at least one identical test position

**Done when:** An agent with 5+ matches has a non-zero overlay distinct from a fresh agent; iNFT's experience hash updates per match; overlay measurably affects move selection in tests.

### Phase 10 — ENS subname registrar contract (2 hrs)

**New tool/sponsor:** **ENS.**

**Goal:** Deploy a `PlayerSubnameRegistrar.sol` that issues `<name>.chaingammon.eth` subnames. Choose either NameWrapper-style on Sepolia or a Durin/L2 subname registrar on Base/Linea — pick whichever has the cleanest reference impl.

Tasks:

- Acquire `chaingammon.eth` on the chosen network (testnet)
- Deploy a registrar that:
  - Restricts subname creation to the server (owner) for v1
  - Lets the server set/update text records on the subname
- TDD: deploy, mint `alice.chaingammon.eth` to a test wallet, read the resolver

**Done when:** A subname is mintable and resolvable on-chain.

### Phase 11 — ENS text records updates from server (1.5 hrs)

**New tool/sponsor:** none (continues ENS).

**Goal:** After every match, server pushes updated text records on each player's ENS subname.

Text record schema (per player):

| Key | Value |
|---|---|
| `elo` | current ELO as decimal string |
| `match_count` | total matches played |
| `last_match_id` | most recent match's id |
| `style_uri` | `0g://<style-blob-hash>` |
| `archive_uri` | `0g://<player-archive-log-id>` |

Tasks:

- `server/app/ens_client.py` — `set_text(name, key, value)` via web3.py
- Hook into game-end flow after recordMatch
- TDD: end-to-end — play match, assert ENS text records reflect new ELO

**Done when:** A player's `elo` text record on `alice.chaingammon.eth` matches their on-chain ELO.

### Phase 12 — Frontend wallet connect + 0G testnet config (1.5 hrs)

**New tool/sponsor:** wagmi + viem (already scaffolded; first real use).

**Goal:** Connect button works; user can connect MetaMask/WalletConnect to 0G testnet (custom chain via `defineChain`).

Tasks:

- `frontend/app/wagmi.ts` — define 0G testnet
- `frontend/app/providers.tsx` — wagmi + react-query provider
- Connect button in header; show connected address shortened
- TDD: visual smoke test — connect, see address

**Done when:** Wallet connects to 0G testnet; address displays.

### Phase 13 — Frontend agents list + ELO display (1.5 hrs)

**New tool/sponsor:** none (frontend continued).

**Goal:** Landing page reads AgentRegistry and MatchRegistry on-chain, shows each agent's ID, name, and ELO. "Play" button per agent.

Tasks:

- Use wagmi `useReadContract` to query agentCount, then map agentIds → metadata + ELO
- Tailwind cards (form > fashion)

**Done when:** Page lists at least the seed agent with live ELO.

### Phase 14 — Frontend match flow (start, roll, move, end) (3 hrs)

**New tool/sponsor:** none (frontend continued).

**Goal:** A user can play a complete game against an agent. Frontend calls server endpoints; server handles gnubg.

Tasks:

- Search npm for a backgammon board component (e.g., react-backgammon, bgboard); if no good fit, simple SVG board
- Wire the move/roll/end flow to server endpoints
- Match-end UI: show result, "settle on-chain" button (placeholder; real wiring happens in Phase 17)

**Done when:** Frontend can play a full match, server returns winner.

### Phase 15 — Frontend ENS name resolution + display (1.5 hrs)

**New tool/sponsor:** none (continues ENS, frontend side).

**Goal:** When a wallet connects, frontend resolves the wallet's chaingammon.eth subname (if any) and displays the name + ELO from text records. Agent cards show their ENS name too.

Tasks:

- Add ENS resolver call to wagmi config
- Header shows `alice.chaingammon.eth (1547)` instead of `0xABC...`
- Agent cards show `gnubg-classic.chaingammon.eth`

**Done when:** Connected user sees their ENS name in the header.

### Phase 16 — KeeperHub direct execute spike (1 hr)

**New tool/sponsor:** **KeeperHub.**

**Goal:** Smoke-test KeeperHub's basic primitive — execute one `recordMatch` call via `kh execute contract-call` instead of direct web3.py.

Tasks:

- Sign up at https://app.keeperhub.com, create API key
- Install `kh` CLI (`brew install keeperhub/tap/kh`)
- Run a one-off `recordMatch` via `kh execute contract-call --chain 16602 --contract <MatchRegistry> --method recordMatch --args [...]`
- Inspect the response shape (`kh execute status <id> --json`)
- Document fields observed in `docs/keeperhub-feedback.md` as you go

**Done when:** A match has been recorded via KeeperHub; we know what the audit JSON looks like.

### Phase 17 — KeeperHub workflow definition (2 hrs)

**New tool/sponsor:** none (continues KeeperHub — workflow surface).

**Goal:** Build a "Chaingammon Match Settlement" workflow in KeeperHub's web UI that, given a match payload, runs:

1. `recordMatch` on `MatchRegistry` (passing `gameRecordHash` so it lands in the match struct)
2. Update ENS text records for both players: `setText(name, "elo", ...)`, `setText(name, "match_count", ...)`, `setText(name, "last_match_id", ...)`. If `archive_uri` or `style_uri` changed, update those too.
3. If the match involved an agent: `updateOverlayHash(agentId, newOverlayHash)` on `AgentRegistry` (the agent's experience update from Phase 9)
4. Emit final audit JSON

This is the natural home for match settlement: it's a multi-step orchestration touching three contracts, and a workflow primitive with retry, gas optimization, and audit trail is the right tool for it.

Tasks:

- Build the workflow visually
- Test with a manual trigger from the KeeperHub UI
- Note the trigger URL / id

**Done when:** Workflow runs end-to-end from a manual trigger.

### Phase 18 — Server triggers KeeperHub workflow on game-end (1.5 hrs)

**New tool/sponsor:** none (continues KeeperHub).

**Goal:** Replace the server's direct `recordMatch` web3 call with a POST to the KeeperHub workflow trigger.

Tasks:

- `server/app/keeperhub_client.py` — `trigger_workflow(payload)` and `wait_for_completion(run_id)`
- Wire into game-end handler
- TDD: end-to-end — play match, assert workflow ran, on-chain match recorded, ENS text records updated

**Done when:** Game-end → KeeperHub workflow → all four steps land successfully.

### Phase 19 — KeeperHub audit pulled, mirrored to 0G Storage (1.5 hrs)

**New tool/sponsor:** none (continues KeeperHub + 0G).

**Goal:** After workflow completes, server pulls audit data via `kh run status` / `kh run logs`, appends it to the match's 0G Storage record. This makes KeeperHub's audit publicly viewable through our app even though KeeperHub's UI is auth-walled.

Tasks:

- `keeperhub_client.py` — `pull_audit(run_id) -> AuditJSON`
- Update `game_record.py` envelope to include `keeperhub_audit` field
- Re-upload the updated game record blob (or use Log append if 0G supports it)
- TDD: assert audit JSON appears alongside game record on 0G Storage

**Done when:** Each match's 0G Storage record contains the KeeperHub audit JSON.

### Phase 20 — Frontend match replay page (2 hrs)

**New tool/sponsor:** none (frontend continued).

**Goal:** `/match/[matchId]` page reads the game record from 0G Storage and renders a move-by-move replay.

Tasks:

- Resolve matchId → gameRecordHash on-chain → fetch blob from 0G Storage
- Step through positions on click; show dice + moves + cube actions
- Optional: gnubg-style position diagrams

**Done when:** Click a match → see the game replayed.

### Phase 21 — Frontend audit trail display (1 hr)

**New tool/sponsor:** none (frontend continued).

**Goal:** Match details page shows the KeeperHub audit summary: timestamp, retries, gas, status.

Tasks:

- Read the `keeperhub_audit` field from the 0G Storage match record
- Render in a clean panel

**Done when:** Audit panel renders for a real match.

### Phase 22 — KeeperHub feedback document (1 hr)

**New tool/sponsor:** none (writing only — required for KeeperHub bounty).

**Goal:** `docs/keeperhub-feedback.md` with 5–10 specific, actionable observations gathered during Phases 16–19.

Each item:

- One UX or docs friction point, **specific** (path, command, response)
- Or a feature request with a use case
- No vague praise

**Done when:** Doc has ≥5 specific items.

### Phase 23 — Architecture docs + ROADMAP.md (1 hr)

**New tool/sponsor:** none (writing only).

**Goal:** `ARCHITECTURE.md` (component descriptions, data flows, integration points). `ROADMAP.md` (commit-reveal dice, betting, derivatives, agent-vs-agent, anti-cheat, ZK move proofs, 0G Compute).

**Done when:** Both files exist; README links to them.

### Phase 24 — Deploy frontend + backend, demo recording (2 hrs)

**New tool/sponsor:** none (Vercel/fly.io — generic deployment).

**Goal:** Frontend live on Vercel, backend live on fly.io / render. Record demo video < 3 min.

Tasks:

- Vercel deploy
- Backend deploy (or Oracle ARM box if ready)
- Verify all flows work in production
- Follow `docs/demo-script.md`; record with OBS / Loom

**Done when:** Live URL works; video uploaded.

### Phase 25 — ETHGlobal submission (1 hr)

**New tool/sponsor:** none (submission flow).

**Goal:** Submitted to all 4 tracks with the required artifacts each.

Tasks:

- Submit to ENS, 0G, KeeperHub, main track
- Each: project name, deployed addresses, GitHub link, demo video, live URL, contact info, write-up of how their SDK was used, link to minted iNFT (for 0G), link to ENS subname (for ENS), link to KeeperHub feedback doc (for KeeperHub bounty)
- Tag: `git tag submission-v1`

**Done when:** All submissions accepted on dashboard.

---

## 6. Daily Cadence

~36 hrs / 10 days = ~3.5 hrs/evening. (Phase counts and hour estimates above. Hours are upper bound; many phases will go faster.)

| Day | Phases | Hrs |
| --- | --- | --- |
| 1 | Phase 3 + 4 (gameRecordHash field + first 0G testnet deploy) | 2 |
| 2 | Phase 5 + 6 (ERC-7857 + 0G Storage hello world) | 3 |
| 3 | Phase 7 (game records on 0G Storage Log) | 2 |
| 4 | Phase 8 + 9 (shared base weights + agent experience overlay) | 4 |
| 5 | Phase 10 + 11 (ENS subnames + text records) | 3.5 |
| 6 | Phase 12 + 13 + 15 (frontend wagmi + agents + ENS display) | 4.5 |
| 7 | Phase 14 + 16 (frontend match flow + KeeperHub spike) | 4 |
| 8 | Phase 17 + 18 + 19 (KeeperHub workflow + audit) | 5 |
| 9 | Phase 20 + 21 + 22 (replay + audit display + feedback doc) | 4 |
| 10 | Phase 23 + 24 + 25 (docs + deploy + submit) | 4 |

**If behind by Day 7 (cut order, easiest first):**

- First cut: Phase 21 audit display → audit JSON still lands in 0G Storage, just not rendered in UI
- Second cut: Phase 5 ERC-7857 → fall back to ERC-721 with custom `dataHashes` mapping (still satisfies the iNFT shape, just not the standard interface)
- Third cut: Phase 17 multi-step workflow → fall back to Phase 16 direct execute for `recordMatch` only; do ENS text records and overlay updates as separate direct calls (loses the "depth of integration" angle for KeeperHub)
- **Do not cut Phase 9** — without the experience overlay, the iNFT is just a label, not a learned asset. This is the heart of the agent-as-asset model.
- **Do not cut Phase 8** — without base weights on 0G, the iNFT has nothing real to commit to.
- **Do not cut Phase 10–11** — without ENS subnames + text records, players don't have portable identity. That's the protocol.

---

## 7. Resources

**ENS:**

- Track: https://ethglobal.com/events/openagents/prizes/ens
- Docs: https://docs.ens.domains
- Subname approaches: NameWrapper, Durin (L2 subnames)
- Relevant repos: https://github.com/ensdomains

**0G:**

- Track: https://ethglobal.com/events/openagents/prizes/0g
- Builder hub: https://build.0g.ai
- Docs: https://docs.0g.ai
- Storage: https://docs.0g.ai/concepts/storage
- Testnet RPC: `https://evmrpc-testnet.0g.ai`, chain ID `16602`
- Explorer: https://chainscan-galileo.0g.ai

**KeeperHub:**

- Track: https://ethglobal.com/events/openagents/prizes/keeperhub
- CLI repo: https://github.com/KeeperHub/cli (public docs in `docs/`)
- Platform: https://app.keeperhub.com
- Docs: https://docs.keeperhub.com (root 403s, subpaths via repo)
- MCP: `https://app.keeperhub.com/mcp`

**gnubg:**

- Project: https://savannah.gnu.org/projects/gnubg
- External interface: https://www.gnu.org/software/gnubg/manual/html_node/A-technical-description-of-the-External-Player-Interface.html
- Install: `sudo apt install gnubg`

**ERC-7857 (iNFT):**

- Find latest reference impl. Fall back to ERC-721 if not ready.

---

## 8. Submission Checklist

**All tracks:**

- [x] Public GitHub repo
- [ ] README with pitch, demo link, live URL, addresses
- [ ] Demo video < 3 min
- [ ] Architecture diagram
- [ ] Team name + contact (Telegram + X)

**ENS-specific:**

- [ ] Deployed subname registrar address
- [ ] At least one `<name>.chaingammon.eth` minted with text records
- [ ] Write-up: how ENS is used (text record schema, resolver flow)

**0G-specific:**

- [ ] Contracts deployed on 0G testnet (links to chainscan-galileo)
- [ ] At least one agent iNFT with hash-committed encrypted weights on 0G Storage
- [ ] Match game records visible on 0G Storage
- [ ] Write-up: which 0G features used (Chain, Storage, optionally Compute)

**KeeperHub-specific:**

- [ ] Working KeeperHub workflow handling settlement
- [ ] `docs/keeperhub-feedback.md` with ≥5 specific actionable items
- [ ] Write-up: how the workflow integrates and what the audit trail captures

**Main track:**

- [ ] Open-protocol thesis written up
- [ ] Anyone can read another player's ENS profile and reconstruct their reputation

---

## 9. Anti-Goals

- No features beyond this plan without asking
- Max 30 min per tooling issue — flag and workaround
- No over-engineering frontend (default Tailwind is correct)
- No betting, derivatives, VRF, ZK in this submission
- No skipping EloMath.sol tests
- No secrets committed (use .env.example)
- No mainnet, testnets only
- No Gensyn (training surface too small)
- No commits/pushes without owner approval
- TDD only — no implementation without a failing test first
