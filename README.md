# Chaingammon

> **An open protocol for portable backgammon reputation.** Your wallet (or your AI agent) is your player profile. Your ENS subname is your portable identity. Your full match archive lives on 0G Storage, owned by you forever.

Built for ETHGlobal Open Agents. Uses **ENS** for portable player identity, **0G** for agent iNFTs and the match archive, and **Gensyn AXL** (Agent eXchange Layer — a permissionless P2P mesh for agent-to-agent communication) for game relay, move evaluation, and the LLM coach that narrates each turn.

---

## TL;DR

A decentralized, verifiable ELO rating ledger for backgammon — for humans and for AI agents that live on-chain as 0G iNFTs and learn match by match.

- **Verifiable.** Every match settles to a MatchRegistry contract. Result, ELO delta, and a hash of the full game record (archived on 0G Storage) are all public and cryptographically tied together — anyone can audit any rating change end-to-end.
- **Portable.** Each player's rating lives in their wallet via an ENS subname (`<name>.chaingammon.eth`) whose text records hold current ELO, match count, and a link to the full archive. Switch frontends, switch clients — reputation comes with you.
- **Living, learning agents.** Each AI agent _is_ an ERC-7857 iNFT minted on 0G Chain — the token itself, not a label pointing at an off-chain model. The iNFT pins two hashes that point at 0G Storage: a shared gnubg neural-net base, and a per-agent **experience overlay** that the protocol rewrites after every match. The iNFT learns. Transfer the token, transfer the brain — with the verifiable match history attached.
- **Decentralised play layer.** There is no central game server. Instead, each player runs a pair of **Gensyn AXL** agent nodes locally — a gnubg node that evaluates moves and an LLM coach node that narrates each turn. The browser talks to those local nodes over AXL (Agent eXchange Layer), a permissionless P2P mesh. Current v1 supports human-vs-agent only; human-vs-human requires peer discovery on top of AXL, which is a roadmap item.

---

## Innovations

Two design choices that move the project past "demo" into a credible v1. They sit underneath the project's two pillars — *agentic power* (the AI is doing real coaching, not narrating telemetry) and *full decentralization* (no operator key in the trust path, anywhere).

### 1. Agentic power — the LLM is the coach, not a narrator

The LLM (Qwen 2.5 7B on **0G Compute**) does things gnubg's equity numbers can't:

- **Pre-move advice without spoilers.** "Two reasonable options here — defensive (hold the 5-point) or aggressive (hit and run); the race is close so it depends on your style." Coaches without giving away the answer.
- **Mistake explanation.** Translates "lost 0.05 equity" into the actual reason — over-aggressive blot, broken anchor, lost timing — not just the magnitude.
- **Post-game summary.** Reviews the three biggest equity drops and names the common theme.
- **Free-text Q&A.** The player can ask the coach anything mid-match ("why didn't I move 13/8?", "what's a prime?", "how do I beat a back-game?"). Stateful conversation kept browser-side.
- **Opponent-aware advice.** The coach reads the *opponent's* style — for humans, the style profile blob on 0G Storage; for AI agents, the experience overlay on the iNFT (`dataHashes[1]`). Advice is tailored to who's across the board, not just to the current position.
- **Personality-driven agent play.** Each agent's overlay maps (via the LLM) to a personality paragraph that re-ranks gnubg's top candidates. Two same-tier agents play measurably differently and trash-talk in character.

This is what makes the agent in *Open Agents* an actual agent. gnubg is a deterministic 2000s neural net; the LLM is the entity holding the plan, reading the opponent, and explaining the play. Inference runs on **0G Compute** (verifiable execution); the coach docs RAG context lives on **0G Storage**; the agent's personality is encoded in the iNFT on **0G Chain**; the player's identity is on **ENS**. Every protocol primitive participates.

### 2. Full decentralization — no operator anywhere in the path

The pivot to **Gensyn AXL** removed the central game server: each player runs their own gnubg + coach nodes locally and the browser talks to them over a permissionless P2P mesh. Settlement is the last centralization point, and a naïve two-sig design has a known DoS — the loser refuses to sign. So the design uses a **session-key state channel with cooperative close**:

- At game start, the player's wallet authorizes an ephemeral in-browser session key — *one* MetaMask popup.
- Per-move signing during play uses the session key directly — **no MetaMask popups during play**.
- At game end, *one* MetaMask popup submits `MatchRegistry.settleWithSessionKeys(humanAuth, humanResult, agentId, ...)`. The contract verifies both the game-start authorization (the player's wallet sig) AND the final result (the session key's sig). A nonce per player blocks replay.
- The loser cannot DoS by going offline — they pre-signed the channel at game start, and the latest session-key-signed state is enough to finalize. Either side can submit unilaterally.

Combined, these two pivots remove every "trust the operator" assumption from the live flow:

| Layer | Pre-pivot | Post-pivot |
| --- | --- | --- |
| Game state | Server's RAM | Browser state machine |
| Move evaluation | Server's gnubg | Player's local gnubg over AXL |
| Coach inference | Hosted LLM (someone's API key) | Verifiable inference on 0G Compute |
| Dice rolling | Server PRNG | `crypto.getRandomValues` (player's machine; commit-reveal in v2) |
| Settlement | `onlyOwner recordMatch` (deployer key) | `settleWithSessionKeys` — pre-authorized state channel, anyone submits |
| Match archive | Centralised storage | 0G Storage (content-addressed, permanent) |
| Identity | Platform DB row | ENS subname (`<name>.chaingammon.eth`) |

The win isn't any single primitive — it's that all seven layers are sponsor-protocol-native, and none of them require trusting a Chaingammon operator key.

---

## Mission

Your backgammon rating is not yours. When you spend years climbing the ladder on any platform, that rating lives in their database — locked behind their login wall and gone if they shut down. Switch platforms and you start at zero.

Chaingammon is the open protocol that fixes this. Every player gets `<name>.chaingammon.eth` (an ENS subname) whose text records hold their ELO and a link to their full match archive on 0G Storage. AI agents are first-class players too — minted as ERC-7857 iNFTs with embedded gnubg intelligence (encrypted weights stored on 0G Storage, hash committed to the iNFT). Match settlement is trustless: both players sign the result off-chain; `MatchRegistry.recordMatch(sig1, sig2)` verifies two ECDSA signatures on-chain — no trusted intermediary needed.

Any front-end can read another player's ENS subname and reconstruct their full reputation: ELO, games played, playing style. Competition history becomes a public good — like DNS, but for skill.

---

## How It Works

1. Connect a wallet → frontend resolves (or auto-mints) your `<name>.chaingammon.eth` subname
2. Pick an opponent — another human's subname or an AI agent (e.g. `gnubg-classic.chaingammon.eth`)
3. Play a game — move requests go from the browser to your local gnubg AXL node (no central server); the LLM coach AXL node narrates each turn in plain English
4. Game ends → both players sign the result → `MatchRegistry.recordMatch(sig1, sig2)` verifies signatures on-chain → ENS text records updated, full game record archived on 0G Storage
5. Any other tool can read your subname and import your full backgammon DNA

---

## Agent Intelligence Model

Every AI agent's "brain" has two layers, and they live in different places.

### Layer 1 — gnubg neural network weights (shared, frozen)

gnubg is a battle-tested open-source backgammon engine whose neural network has been trained over decades via temporal-difference (TD) self-play. We don't retrain those nets. Every agent in Chaingammon runs the **same** gnubg neural-network weights file. That file is encrypted and uploaded once to 0G Storage; its hash sits in `dataHashes[0]` of every agent iNFT (where `dataHashes` is the ERC-7857 array of pointers to the agent's intelligence). What differentiates one agent from another at this layer is **search depth**, not weights — the iNFT's `tier` field (0 = beginner ... 3 = world-class) maps directly to gnubg's search-ply setting (how many moves ahead the engine looks before deciding).

### Layer 2 — per-agent experience overlay (private, learned)

On top of the shared gnubg base, each agent carries a small **experience overlay** — a ~50-float preference vector representing playing tendencies (opening style, cube aggressiveness, bear-off timing, risk profile). It starts at all zeros (no bias). After every match the server computes a small update from the agent's exposure to each tendency category × match outcome × a damping factor that decays as `matchCount` grows, then uploads the new overlay to 0G Storage and writes its hash to `dataHashes[1]` of the iNFT via a settlement transaction. Two iNFTs minted at the same `tier` will play identically _out of the box_, then drift into measurably different styles as their match histories diverge.

### Why not fine-tune the gnubg nets directly?

Two reasons:

1. **They're already well-tuned.** gnubg's nets are decades of TD-trained weights; naive online updates would degrade them long before they improved.
2. **They're feedforward, not LLMs.** gnubg uses small (~10K-parameter) feedforward MLPs. Modern fine-tuning services (including 0G's own fine-tuning compute service, which targets transformer LLMs and outputs LoRA adapters) don't apply to this architecture.

The overlay is the right primitive for "this agent learned": it's cheap to compute (no backprop, no gradient descent), bounded (each entry clipped to [-1, 1]), explainable (you can read off "this agent prefers slot openings"), and it gives every iNFT a unique, monotonically-growing piece of state that's cryptographically tied to the token through `dataHashes[1]`. That's what makes the iNFT meaningful as an asset rather than a label.

---

## Match Archive on 0G Storage

Every completed match is preserved as a canonical, content-addressed archive on **0G Storage**. The on-chain `MatchRegistry` only stores match metadata (timestamp, participants, winner, length); the _full_ match — every move, every dice roll, the final position — lives off-chain on 0G Storage Log, and the on-chain record carries a cryptographic pointer to it.

### Why a separate archive layer?

ELO without games is just a number. The games themselves are the substance — they're how a player improves, how a coach teaches, how a community builds canon. Storing them once, immutably, owned by no platform, is the actual point of an open backgammon protocol. 0G Storage is built for exactly this: cheap, content-addressed, replicated, and decentralized.

### What gets stored

Each match produces a `GameRecord` envelope — JSON, sorted keys, UTF-8, deterministic so the bytes always hash the same way:

| Field                                 | What it carries                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `match_length`, `final_score`         | match-point target and final score                                                                        |
| `winner`, `loser`                     | each side's identity (a wallet address for humans, an ERC-7857 token id for agent iNFTs)                  |
| `final_position_id`, `final_match_id` | gnubg's native base64 strings — any tool with gnubg installed can reconstruct the end state bit-perfectly |
| `moves`                               | the full play sequence: `(turn, dice, move, position_id_after)` for every committed checker move          |
| `cube_actions`                        | doubling-cube events (offer / take / drop / beaver / raccoon)                                             |
| `started_at`, `ended_at`              | ISO-8601 UTC timestamps                                                                                   |
| `mat_format`                          | reserved for v2 — a literal `.mat` text export from gnubg's `export match` command                        |

Sized at ~2–10 KB compressed per match. A player with 1,000 lifetime matches has ~5–10 MB of game data.

### The on-chain ↔ off-chain link

When a match ends, the frontend runs three actions:

1. **Build** the `GameRecord` from the final state and the move history captured during play.
2. **Upload** the JSON bytes to 0G Storage. The indexer returns a 32-byte Merkle `rootHash` — a content-addressed identifier that names this exact archive.
3. **Record on-chain.** Both players sign `keccak256(winner, loser, winner, gameRecordHash)` off-chain; the frontend calls `MatchRegistry.recordMatch(sig1, sig2, ...)` which verifies both ECDSA signatures. The `MatchInfo` struct permanently links match metadata to the archive.

Anyone can later resolve a match by id, read `MatchInfo.gameRecordHash`, fetch the bytes from 0G Storage, and replay the game move-by-move. No login, no API key, no platform — the archive is content-addressed and replicated across 0G's network.

---

## Gensyn AXL — the Play Layer

Pre-pivot, all game logic ran on a central FastAPI server: the browser sent moves to it, it ran gnubg, it rolled dice, it signed settlement transactions. That server was a single point of trust and failure.

Post-pivot, there is no central server. The browser talks to **local AXL agent nodes** over the Gensyn AXL (Agent eXchange Layer) — a permissionless, encrypted P2P mesh. Each player runs the nodes themselves; the mesh routes traffic between them without a coordinator.

### The two agent nodes

Each player's local stack exposes two services through AXL:

| Node                                       | Port | What it does                                                                                                                                               |
| ------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **gnubg agent** (`agent/gnubg_service.py`) | 8001 | Wraps the gnubg subprocess via its External Player interface. Accepts a `position_id` + dice and returns the best legal move and equity-ranked candidates. |
| **LLM coach** (`agent/coach_service.py`)   | 8002 | Narrates each turn in plain English. Uses flan-t5-base with gnubg strategy docs (uploaded to 0G Storage) as RAG context.                                   |

AXL (`agent/axl-config.json`) proxies the browser's HTTP requests to whichever service is registered under those names, and routes requests destined for the opponent's node over the encrypted Yggdrasil mesh.

### Why AXL and not a server?

A central server is a trust assumption: it can cheat on dice, misreport moves, or go down. AXL removes it from the critical path entirely. Both nodes run locally — the player can audit them. Settlement is still on-chain (two ECDSA signatures on `MatchRegistry`) so the result is verifiable even if one player disputes it.

### Current limitations

v1 supports **human-vs-agent** only. The agent's gnubg node evaluates the AI's moves; the human moves in the browser. Human-vs-human would require a peer discovery / matchmaking layer so two players' AXL nodes can find each other — this is a roadmap item (the transport already works; the discovery doesn't exist yet).

### Match flow — browser-driven game state

In the post-pivot architecture the browser holds the entire game state. There is no server-side game store. The browser keeps a single `MatchState` object and round-trips every move through `gnubg_service` for validation and state advancement.

**`MatchState` shape:**

```ts
interface MatchState {
  position_id: string;     // gnubg base64 board
  match_id: string;        // gnubg base64 turn / score / cube
  board: number[];         // 24 signed checker counts (decoded for rendering)
  bar: [number, number];
  off: [number, number];
  turn: 0 | 1;             // 0 = human, 1 = agent
  dice: [number, number] | null;
  score: [number, number];
  match_length: number;
  game_over: boolean;
  winner: 0 | 1 | null;
}
```

**`gnubg_service` endpoints** (port 8001, served via AXL):

| Endpoint     | Request                                      | Response                                                              |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------- |
| `POST /new`  | `{match_length}`                             | full `MatchState` for the starting position                           |
| `POST /apply`| `{position_id, match_id, dice, move}`        | full `MatchState` after applying the move, or `422` if move is illegal |
| `POST /resign` | `{position_id, match_id}`                  | full `MatchState` with `game_over=true` and current side as the loser  |
| `POST /move` | `{position_id, match_id, dice}`              | `{move, candidates}` — gnubg picks the best legal move (no state change) |
| `POST /evaluate` | `{position_id, match_id, dice}`          | `{candidates}` — ranked moves only, no pick (used by `coach_service`)  |

`/new`, `/apply`, and `/resign` all return the same `MatchState` shape so the browser has a single decoder. `/move` and `/evaluate` are unchanged from the original design and don't touch state.

**Browser flow** (per turn, human-vs-agent):

```
on mount
  ├─ POST /new {match_length}                 → full state
  ├─ if turn === 0: roll dice client-side     (state.dice = [d1, d2])
  └─ if turn === 1: trigger agent loop

human turn (turn === 0, dice set)
  ├─ render board + dice + move input
  ├─ user submits move string ("8/5 6/5")
  ├─ POST /apply {position_id, match_id, dice, move}
  │    ├─ on 422: surface the error, leave state unchanged
  │    └─ on 200: replace state
  └─ if not game_over and new turn === 1: trigger agent loop

agent turn (turn === 1)
  ├─ roll dice client-side                    (state.dice = [d1, d2])
  ├─ POST /move {position_id, match_id, dice} → best move string
  ├─ POST /apply {position_id, match_id, dice, move: best}
  ├─ replace state
  └─ if not game_over and new turn === 0: roll dice for human, hand control back

forfeit
  └─ POST /resign → game_over response
```

Dice are rolled client-side using `crypto.getRandomValues`. For v1 (human-vs-agent) the human is rolling for themselves; trust is local. Human-vs-human commit-reveal is a roadmap item.

**Why this shape?** gnubg already encodes every backgammon rule (move legality, dice consumption, hits, bear-off, game-over) inside `submit_move`. Re-implementing those rules in TypeScript would either duplicate years of work or quietly diverge from the engine the agent uses. Putting `/apply` on the agent node keeps gnubg authoritative on rules while letting the browser own state.

**Out of scope at this layer:** coach narration (delivered by `coach_service`), two-signature on-chain settlement (driven by the wallet from the post-game banner), cube doubling, and human-vs-human peer discovery.

---

## Architecture

```
                       ┌──────────────────────────┐
                       │    Frontend (Next.js)    │
                       │  matchmaking, profile,   │
                       │  replay, live game,      │
                       │  LLM coach panel         │
                       └────────────┬─────────────┘
                                    │ localhost:9002
                                    ▼
                       ┌──────────────────────────┐
                       │   AXL node (local)       │
                       │  Gensyn Agent eXchange   │
                       │  Layer — P2P encrypted   │
                       │  mesh on Yggdrasil       │
                       └────────┬─────────────────┘
                                │ AXL mesh
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
   ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐
   │  gnubg agent    │  │ coach agent  │  │  opponent    │
   │  (agent/)       │  │  (agent/)    │  │  AXL node    │
   │  FastAPI+gnubg  │  │  flan-t5-    │  │  (H vs H)    │
   │  POST /move     │  │  base LLM    │  │              │
   └────────┬────────┘  └──────────────┘  └──────────────┘
            │ browser signs result
            ▼
   ┌──────────────────────────────────────────────┐
   │  MatchRegistry.recordMatch(sig1, sig2)       │
   │  + PlayerSubnameRegistrar.setTextBatch x2    │
   └────┬──────────────────┬──────────────────────┘
        ▼                  ▼
 ┌──────────────┐  ┌──────────────────────────────┐
 │   0G Chain   │  │       0G Storage             │
 │ AgentRegistry│  │  Log: per-match game records │
 │ MatchRegistry│  │  Blob: encrypted gnubg nets  │
 │ EloMath      │  │  Blob: gnubg strategy docs   │
 │ ENS registrar│  │        (coach RAG context)   │
 └──────────────┘  └──────────────────────────────┘
```

---

## Tech Stack

| Layer                 | Technology                                                     |
| --------------------- | -------------------------------------------------------------- |
| Frontend              | Next.js 16, React 19, TypeScript, Tailwind CSS 4               |
| Wallet / chain        | wagmi 3, viem 2, @tanstack/react-query 5                       |
| AXL agent nodes       | Python 3.12, FastAPI, uvicorn, flan-t5-base (coach LLM)        |
| P2P relay             | Gensyn AXL (Agent eXchange Layer) — Yggdrasil mesh             |
| Backgammon engine     | GNU Backgammon (gnubg) via External Player interface           |
| Smart contracts       | Solidity 0.8.24, Hardhat 2, evmVersion cancun, OpenZeppelin v5 |
| Blockchain            | 0G Chain testnet (EVM, chainId 16602)                          |
| Identity              | ENS subnames + text records                                    |
| Decentralized storage | 0G Storage (Log + KV + Blob)                                   |
| Package management    | uv (Python), pnpm workspace (Node)                             |

### Where each protocol fits

| Protocol       | Role                                                                                                                                                                           | Where it lives                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **ENS**        | Portable player identity. `<name>.chaingammon.eth` subnames per player; text records (`elo`, `match_count`, `last_match_id`, `style_uri`, `archive_uri`) carry the reputation. | `contracts/src/PlayerSubnameRegistrar.sol`                |
| **0G Chain**   | Hosts AgentRegistry, MatchRegistry, EloMath, and the subname registrar.                                                                                                        | `contracts/src/`, `contracts/deployments/0g-testnet.json` |
| **0G Storage** | Per-match game record archive (Log); per-player style profile (KV); per-agent encrypted gnubg weights (Blob); gnubg strategy docs blob (coach RAG context).                    | `agent/coach_service.py`, `scripts/upload_gnubg_docs.py`  |
| **Gensyn AXL** | P2P encrypted mesh (Yggdrasil) that routes browser requests to the local gnubg and coach agent services without a central server.                                              | `agent/axl-config.json`, `agent/start.sh`                 |

### Claude Skills Used

This project was built with [Claude Code](https://claude.ai/code).

| Skill                       | What it did                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/init`                     | Generated `CONTEXT.md` so future Claude sessions have the architecture, commands, and conventions without re-deriving them |
| `/fewer-permission-prompts` | Scanned session transcripts and added common read-only commands to the project allowlist                                   |

---

## Running Locally

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv) or plain `pip`
- Node 20+, [pnpm](https://pnpm.io)
- `gnubg` — `sudo apt install gnubg` (Ubuntu/Debian) or `brew install gnubg` (macOS)
- Gensyn AXL binary — `axl` must be in PATH (see Gensyn docs for install)

### Mental model

Contracts live on a chain and are deployed once. Two long-running local processes: **AXL agent node** (gnubg + coach FastAPI services + AXL relay) and **frontend** (Next.js). Settlement is trustless — both player wallets sign the result in-browser; no backend server needed.

You can run against either chain:

| Mode          | Chain                             | When                                      |
| ------------- | --------------------------------- | ----------------------------------------- |
| **Testnet**   | 0G testnet (chainId 16602)        | Demo, recording, submission               |
| **Local dev** | Hardhat localhost (chainId 31337) | Fast iteration; state resets each restart |

### One-time setup

```bash
git clone <repo> && cd chaingammon
pnpm install                    # installs frontend + contracts (workspace)
cd agent && uv sync && cd ..    # installs agent Python deps via uv (pyproject.toml)
cd server && uv sync && cd ..   # installs server Python deps via uv

cp contracts/.env.example contracts/.env
cp frontend/.env.example frontend/.env.local
```

Add `DEPLOYER_PRIVATE_KEY=0x...` to `contracts/.env`. Fund the wallet with testnet 0G tokens via https://build.0g.ai. The `.env` files are gitignored.

**One-time: upload gnubg strategy docs to 0G Storage** (needed for the coach agent's RAG context):

```bash
cd server && uv run python ../scripts/upload_gnubg_docs.py
# prints: GNUBG_DOCS_HASH=0x<hash>
# add GNUBG_DOCS_HASH to agent/.env and frontend/.env.local
```

### Mode A — testnet (real demo)

#### Fresh-network bootstrap (one shot)

For a clean repo + funded wallet, the canonical setup is one command:

```bash
./scripts/bootstrap-network.sh
```

It runs:

1. `pnpm contracts:test` — fail fast if any contract test is red.
2. `pnpm contracts:deploy` — deploy MatchRegistry + AgentRegistry to 0G testnet, mint seed agent #1, write addresses to **contracts/deployments/0g-testnet.json**.
3. `pnpm contracts:verify` — verify both contracts on chainscan-galileo.

When the script finishes it prints the new addresses; copy them into **frontend/.env.local**.

#### Then run agent node + frontend

Two terminals.

```bash
# terminal 1: AXL agent node (gnubg + coach + AXL relay)
cd agent && ./start.sh

# terminal 2: frontend
pnpm frontend:dev
```

The AXL node generates a public key on first run. Copy it to the `gnubg_axl_pubkey` ENS text record on `chaingammon.eth` so the frontend can discover the node without a server.

#### Sub-flows

- **Just redeploy contracts:** `pnpm contracts:deploy`
- **Just verify after a deploy:** `pnpm contracts:verify`
- **Run agent tests:** `cd agent && uv run pytest tests/ -v`

### Mode B — local dev (fast iteration)

Four terminals.

```bash
# terminal 1: local chain
cd contracts && pnpm exec hardhat node

# terminal 2: deploy locally
cd contracts
pnpm exec hardhat run script/deploy.js --network localhost
# copy resulting addresses from contracts/deployments/localhost.json into frontend/.env.local

# terminal 3: AXL agent node
cd agent
./start.sh

# terminal 4: frontend
pnpm frontend:dev
```

Upload gnubg strategy docs to 0G Storage (one-time — sets the coach RAG context blob):

```bash
cd server && uv run python ../scripts/upload_gnubg_docs.py
```

Run from `server/` because the script imports `app.og_storage_client` from the server's `uv`-managed venv. Copy the printed `GNUBG_DOCS_HASH` into `agent/.env` and `frontend/.env.local`.

---

### Test commands

```bash
pnpm test                  # all tests: agent (pytest) + contracts (hardhat) + frontend (build)
pnpm contracts:test        # hardhat tests
pnpm agent:test            # pytest — gnubg + coach service tests
pnpm frontend:test         # next build (production correctness check)
cd agent && uv run pytest tests/ -v      # same as agent:test, run directly
```

---

## 0G Testnet

|          |                                 |
| -------- | ------------------------------- |
| RPC      | `https://evmrpc-testnet.0g.ai`  |
| Chain ID | `16602`                         |
| Explorer | https://chainscan-galileo.0g.ai |
| Faucet   | https://build.0g.ai             |

After deploy, contract addresses live in `contracts/deployments/0g-testnet.json` and need to be copied into `server/.env` and `frontend/.env.local`.

---

## Roadmap

For the full version: see [ROADMAP.md](ROADMAP.md). Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md).

- **v1 (this submission):** Human-vs-human and human-vs-agent gameplay; on-chain ELO; ENS subnames as identity; agent iNFTs with encrypted gnubg weights; full match archive on 0G Storage; two-signature trustless settlement via Gensyn AXL
- **v2:** Commit-reveal dice (trustless randomness); per-player anti-cheat heuristics; agent style overlay that learns from each match; subnames moved to L2 ENS for cheap onboarding
- **v3:** Agent-vs-agent autonomous tournaments; ZK proofs of agent inference (zkML); 0G Compute for verifiable inference; betting markets; ELO derivative tokens
- **v4:** Open agent marketplace — bring your own engine, stake your iNFT

---

## Submission Checklist

**All tracks:**

- [x] Public GitHub repo
- [ ] README with pitch, demo link, live URL, deployed addresses
- [ ] Demo video < 3 min
- [ ] Architecture diagram
- [ ] Team name + contact (Telegram + X)

**ENS:**

- [ ] Subname registrar deployed (address + explorer link)
- [ ] At least one `<name>.chaingammon.eth` minted with text records
- [ ] Write-up: text record schema and resolver flow

**0G:**

- [ ] Contracts deployed on 0G testnet (chainscan-galileo links)
- [ ] At least one agent iNFT with hash-committed encrypted gnubg weights on 0G Storage
- [ ] Match game records visible on 0G Storage
- [ ] Write-up: which 0G features used (Chain, Storage)

**Gensyn AXL:**

- [ ] AXL agent node running gnubg + coach services
- [ ] Two-signature settlement: both wallets sign result off-chain, `MatchRegistry.recordMatch(sig1, sig2)` verifies on-chain
- [ ] Write-up: AXL mesh architecture and trustless settlement flow

**Main track:**

- [ ] Open-protocol thesis written up — anyone can read another player's ENS profile and reconstruct their reputation
