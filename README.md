# Chaingammon

> Permissionless backgammon with on-chain ELO. Your rating lives in your wallet, not in a company's database.

ETHGlobal Open Agents submission — 0G track (Best Autonomous Agents, Swarms & iNFT Innovations).

---

## Mission

Your backgammon rating is not yours. When you spend years climbing the ladder on any platform, that rating lives in their database — locked behind their login wall and gone if they shut down. Switch platforms and you start at zero.

Chaingammon puts ELO ratings on-chain. Every match result is recorded on a public blockchain — immutable, transparent, and owned by the players. Your wallet is your player profile. Your rating is a credential you carry, not a token you borrow.

Any front-end can read from and write to the same on-chain rating registry. Competition history becomes a public good, like DNS: an open protocol that no single entity controls.

---

## How It Works

1. Connect your wallet
2. Pick an AI agent (minted as an iNFT on 0G Chain, strategy stored on 0G Storage)
3. Play a game — the agent's moves are powered by [GNU Backgammon](https://www.gnu.org/software/gnubg/)
4. When the game ends, the result is submitted on-chain and both players' ELO updates instantly

---

## Architecture

```
Frontend (Next.js)  ──HTTPS──▶  Game Server (FastAPI)  ──subprocess──▶  gnubg
      │                                  │
      │ wagmi / viem                     │ web3.py
      ▼                                  ▼
0G Chain (testnet)              0G Storage
  AgentRegistry (iNFT)            agent metadata JSON
  MatchRegistry  (ELO)
  EloMath        (K=32, fixed-point)
```

- **0G Chain** (chainId 16602): stores all match results and ELO ratings
- **0G Storage**: stores agent metadata (name, engine, skill level)
- **gnubg**: world-class open-source backgammon engine, driven via its External Player socket protocol
- **Server**: trusted dice roller and game arbiter (commit-reveal dice is v2)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16.2, React 19, TypeScript, Tailwind CSS 4 |
| Wallet / chain | wagmi 3, viem 2, @tanstack/react-query 5 |
| Game server | Python 3.12, FastAPI, uvicorn, pydantic, web3.py |
| Backgammon engine | GNU Backgammon (gnubg) via External Player interface |
| Smart contracts | Solidity 0.8.24, Hardhat 2, evmVersion cancun |
| Blockchain | 0G Chain testnet (EVM-compatible, chainId 16602) |
| Decentralised storage | 0G Storage |
| Package management | uv (Python), pnpm workspace (Node) |

### Claude Skills Used

This project was built with [Claude Code](https://claude.ai/code).

| Skill | What it did |
|---|---|
| `/init` | Generated `CONTEXT.md` so future Claude sessions know the architecture, commands, and conventions without re-deriving them |
| `/fewer-permission-prompts` | Scanned session transcripts and added common read-only commands to the project allowlist |

---

## Running Locally

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv)
- Node 20+, [pnpm](https://pnpm.io)
- `gnubg` — `sudo apt install gnubg`

### Mental model

The contracts live on a chain. **They are not a process you run** — you deploy them once and they exist forever at fixed addresses. The two long-running processes are the **game server** (FastAPI + gnubg) and the **frontend** (Next.js).

You can run against either of two chains:

| Mode | Chain | When |
|---|---|---|
| **Testnet** | 0G testnet (chainId 16602) | Demo, recording, submission |
| **Local dev** | Hardhat localhost (chainId 31337) | Fast iteration; state resets each restart |

### One-time setup

```bash
git clone <repo> && cd chaingammon
pnpm install              # installs frontend + contracts (workspace)
cd server && uv sync && cd ..

cp server/.env.example server/.env
cp contracts/.env.example contracts/.env
cp frontend/.env.example frontend/.env.local
```

Add `DEPLOYER_PRIVATE_KEY=0x...` to `contracts/.env`. The deployer wallet needs testnet 0G tokens (faucet: https://build.0g.ai). The `.env` files are gitignored.

### Mode A — testnet (real demo)

Two terminals after a one-time deploy.

```bash
# one-time, when contracts change
pnpm contracts:test                        # 32 hardhat tests
pnpm contracts:deploy                      # writes contracts/deployments/0g-testnet.json
# then copy MatchRegistry + AgentRegistry addresses from that JSON into
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

# terminal 2: deploy to localhost (re-run after each chain restart)
cd contracts && pnpm exec hardhat run script/deploy.js --network localhost
# copy resulting addresses from contracts/deployments/localhost.json
# into server/.env and frontend/.env.local
cd ../server && uv run uvicorn app.main:app --reload

# terminal 3: frontend
pnpm frontend:dev
```

### Test commands

Run these in a **new, separate terminal** from the project root (not in the terminals running the dev servers).

```bash
pnpm test                  # all tests: server (pytest) + contracts (hardhat) + frontend (build)
pnpm contracts:test        # 32 hardhat tests (EloMath, MatchRegistry, AgentRegistry, scaffold)
pnpm server:test           # pytest scaffold tests
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

- **v1 (this submission):** Human vs gnubg agent, on-chain ELO, iNFT agents on 0G
- **v2:** Commit-reveal dice (trustless randomness), anti-cheat for human ratings
- **v3:** Agent-vs-agent matches, betting markets, ELO derivative tokens
- **v4:** Open agent marketplace — bring your own engine, stake your iNFT

---

## Submission Checklist

- [x] Public GitHub repo
- [x] Smart contracts written and tested (32 hardhat tests passing)
- [ ] Contracts deployed to 0G testnet with explorer links
- [ ] iNFT seed agent minted on 0G Chain
- [x] gnubg wrapper service (Phase 1)
- [ ] Frontend with wallet connect and game flow (Phase 3)
- [ ] Demo video < 3 min
- [ ] README with pitch, demo link, live URL
