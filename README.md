# Chaingammon

> **An open protocol for portable backgammon reputation.** Your wallet (or your AI agent) is your player profile. Your ENS subname is your portable identity. Your full match archive lives on 0G Storage, owned by you forever.

Built for ETHGlobal Open Agents. Uses **ENS** for portable player identity, **0G** for agent iNFTs and the match archive, and **KeeperHub** for orchestrated, auditable settlement.

---

## Mission

Your backgammon rating is not yours. When you spend years climbing the ladder on any platform, that rating lives in their database — locked behind their login wall and gone if they shut down. Switch platforms and you start at zero.

Chaingammon is the open protocol that fixes this. Every player gets `<name>.chaingammon.eth` (an ENS subname) whose text records hold their ELO and a link to their full match archive on 0G Storage. AI agents are first-class players too — minted as ERC-7857 iNFTs with embedded gnubg intelligence (encrypted weights stored on 0G Storage, hash committed to the iNFT). Match settlement runs as a KeeperHub workflow that produces a verifiable audit trail.

Any front-end can read another player's ENS subname and reconstruct their full reputation: ELO, games played, playing style. Competition history becomes a public good — like DNS, but for skill.

---

## How It Works

1. Connect a wallet → frontend resolves (or auto-mints) your `<name>.chaingammon.eth` subname
2. Pick an opponent — another human's subname or an AI agent (e.g. `gnubg-classic.chaingammon.eth`)
3. Play a game — for AI opponents, gnubg's encrypted weights are pulled from 0G Storage and run server-side
4. Game ends → KeeperHub workflow fires → match recorded on-chain, ENS text records updated for both players, full game record archived on 0G Storage, audit trail captured
5. Any other tool can read your subname and import your full backgammon DNA

---

## Agent Intelligence Model

Every AI agent's "brain" has two layers, and they live in different places.

### Layer 1 — gnubg neural network weights (shared, frozen)

gnubg is a battle-tested open-source backgammon engine whose neural network has been trained over decades via temporal-difference (TD) self-play. We don't retrain those nets. Every agent in Chaingammon runs the **same** gnubg neural-network weights file. That file is encrypted and uploaded once to 0G Storage; its hash sits in `dataHashes[0]` of every agent iNFT (where `dataHashes` is the ERC-7857 array of pointers to the agent's intelligence). What differentiates one agent from another at this layer is **search depth**, not weights — the iNFT's `tier` field (0 = beginner ... 3 = world-class) maps directly to gnubg's search-ply setting (how many moves ahead the engine looks before deciding).

### Layer 2 — per-agent experience overlay (private, learned)

On top of the shared gnubg base, each agent carries a small **experience overlay** — a ~50-float preference vector representing playing tendencies (opening style, cube aggressiveness, bear-off timing, risk profile). It starts at all zeros (no bias). After every match the server computes a small update from the agent's exposure to each tendency category × match outcome × a damping factor that decays as `matchCount` grows, then uploads the new overlay to 0G Storage and writes its hash to `dataHashes[1]` of the iNFT via a KeeperHub workflow step. Two iNFTs minted at the same `tier` will play identically *out of the box*, then drift into measurably different styles as their match histories diverge.

### Why not fine-tune the gnubg nets directly?

Two reasons:

1. **They're already well-tuned.** gnubg's nets are decades of TD-trained weights; naive online updates would degrade them long before they improved.
2. **They're feedforward, not LLMs.** gnubg uses small (~10K-parameter) feedforward MLPs. Modern fine-tuning services (including 0G's own fine-tuning compute service, which targets transformer LLMs and outputs LoRA adapters) don't apply to this architecture.

The overlay is the right primitive for "this agent learned": it's cheap to compute (no backprop, no gradient descent), bounded (each entry clipped to [-1, 1]), explainable (you can read off "this agent prefers slot openings"), and it gives every iNFT a unique, monotonically-growing piece of state that's cryptographically tied to the token through `dataHashes[1]`. That's what makes the iNFT meaningful as an asset rather than a label.

---

## Architecture

```
                       ┌──────────────────────────┐
                       │    Frontend (Next.js)    │
                       │    matchmaking, profile, │
                       │    replay, audit trail   │
                       └────────────┬─────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
   │  Game Server  │       │  ENS resolver │       │  0G Storage   │
   │  (FastAPI)    │       │  text records │       │  (read game   │
   │  + gnubg      │       │  per player   │       │   records and │
   │               │       │               │       │   styles)     │
   └──────┬────────┘       └───────────────┘       └───────────────┘
          │ on game-end
          ▼
   ┌─────────────────────────────────────┐
   │  KeeperHub workflow                 │
   │   recordMatch + ENS texts +         │
   │   gameRecordHash + audit            │
   └────┬────────────────┬───────────────┘
        ▼                ▼
 ┌──────────────┐ ┌──────────────────────────────┐
 │   0G Chain   │ │       0G Storage             │
 │ AgentRegistry│ │  Log: per-match game records │
 │ MatchRegistry│ │  Log: per-match audit data   │
 │ EloMath      │ │  KV:  per-player styles      │
 │ ENS registrar│ │  Blob: encrypted gnubg nets  │
 └──────────────┘ └──────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Wallet / chain | wagmi 3, viem 2, @tanstack/react-query 5 |
| Game server | Python 3.12, FastAPI, uvicorn, pydantic, web3.py |
| Backgammon engine | GNU Backgammon (gnubg) via External Player interface |
| Smart contracts | Solidity 0.8.24, Hardhat 2, evmVersion cancun, OpenZeppelin v5 |
| Blockchain | 0G Chain testnet (EVM, chainId 16602) |
| Identity | ENS subnames + text records |
| Decentralized storage | 0G Storage (Log + KV + Blob) |
| Tx execution + audit | KeeperHub workflows |
| Package management | uv (Python), pnpm workspace (Node) |

### Where each protocol fits

| Protocol | Role | Where it lives |
|---|---|---|
| **ENS** | Portable player identity. `<name>.chaingammon.eth` subnames per player; text records (`elo`, `match_count`, `last_match_id`, `style_uri`, `archive_uri`) carry the reputation. | `contracts/src/PlayerSubnameRegistrar.sol`, `server/app/ens_client.py` |
| **0G Chain** | Hosts AgentRegistry, MatchRegistry, EloMath, and the subname registrar. | `contracts/src/`, `contracts/deployments/0g-testnet.json` |
| **0G Storage** | Per-match game record archive (Log); per-player style profile (KV); per-agent encrypted gnubg weights (Blob); audit trail mirror so it's publicly viewable. | `server/app/og_storage_client.py`, `server/app/game_record.py`, `server/app/style.py` |
| **KeeperHub** | Match settlement is a multi-step orchestration (recordMatch + ENS text record updates + agent overlay refresh). KeeperHub's workflow primitive handles retry, gas, and audit. | `server/app/keeperhub_client.py`, `docs/keeperhub-feedback.md` |

### Claude Skills Used

This project was built with [Claude Code](https://claude.ai/code).

| Skill | What it did |
|---|---|
| `/init` | Generated `CONTEXT.md` so future Claude sessions have the architecture, commands, and conventions without re-deriving them |
| `/fewer-permission-prompts` | Scanned session transcripts and added common read-only commands to the project allowlist |

---

## Running Locally

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv)
- Node 20+, [pnpm](https://pnpm.io)
- `gnubg` — `sudo apt install gnubg`
- KeeperHub CLI — `brew install keeperhub/tap/kh` (only needed Phase 16+)

### Mental model

Contracts live on a chain and are deployed once. Two long-running processes: **game server** (FastAPI + gnubg) and **frontend** (Next.js). KeeperHub workflows run on KeeperHub's infrastructure and are triggered by the server.

You can run against either chain:

| Mode | Chain | When |
|---|---|---|
| **Testnet** | 0G testnet (chainId 16602) | Demo, recording, submission |
| **Local dev** | Hardhat localhost (chainId 31337) | Fast iteration; state resets each restart |

### One-time setup

```bash
git clone <repo> && cd chaingammon
pnpm install                # installs frontend + contracts (workspace)
cd server && uv sync && cd ..

cp server/.env.example server/.env
cp contracts/.env.example contracts/.env
cp frontend/.env.example frontend/.env.local
```

Add `DEPLOYER_PRIVATE_KEY=0x...` to `contracts/.env`. Fund the wallet with testnet 0G tokens via https://build.0g.ai. The `.env` files are gitignored.

### Mode A — testnet (real demo)

Two terminals after a one-time deploy.

```bash
# one-time, when contracts change
pnpm contracts:test                        # all hardhat tests
pnpm contracts:deploy                      # writes contracts/deployments/0g-testnet.json
# copy MatchRegistry + AgentRegistry addresses from that JSON into
# server/.env and frontend/.env.local (NEXT_PUBLIC_*)

# terminal 1: game server
cd server && uv run uvicorn app.main:app --reload

# terminal 2: frontend
pnpm frontend:dev
```

### Mode B — local dev (fast iteration)

Three terminals.

```bash
# terminal 1: local chain
cd contracts && pnpm exec hardhat node

# terminal 2: deploy locally + run server
cd contracts && pnpm exec hardhat run script/deploy.js --network localhost
# copy resulting addresses from contracts/deployments/localhost.json
# into server/.env and frontend/.env.local
cd server && uv run uvicorn app.main:app --reload

# terminal 3: frontend
pnpm frontend:dev
```

### Test commands

```bash
pnpm test                  # all tests: server (pytest) + contracts (hardhat) + frontend (build)
pnpm contracts:test        # hardhat tests
pnpm server:test           # pytest scaffold + phase tests
pnpm frontend:test         # next build (production correctness check)
```

---

## 0G Testnet

| | |
|---|---|
| RPC | `https://evmrpc-testnet.0g.ai` |
| Chain ID | `16602` |
| Explorer | https://chainscan-galileo.0g.ai |
| Faucet | https://build.0g.ai |

After deploy, contract addresses live in `contracts/deployments/0g-testnet.json` and need to be copied into `server/.env` and `frontend/.env.local`.

---

## Roadmap

- **v1 (this submission):** Human-vs-human and human-vs-agent gameplay; on-chain ELO; ENS subnames as identity; agent iNFTs with encrypted gnubg weights; full match archive on 0G Storage; KeeperHub-driven settlement with audit trail
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

**KeeperHub:**
- [ ] Working KeeperHub workflow handling settlement
- [ ] `docs/keeperhub-feedback.md` with ≥5 specific actionable items
- [ ] Write-up: workflow architecture and what the audit trail captures

**Main track:**
- [ ] Open-protocol thesis written up — anyone can read another player's ENS profile and reconstruct their reputation
