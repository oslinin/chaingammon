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
| Package management | uv (Python), npm (Node) |

### Claude Skills Used

This project was built with [Claude Code](https://claude.ai/code) using the following skills:

| Skill | When used |
|---|---|
| `/init` | Generated `CLAUDE.md` so future Claude sessions understand the repo without re-deriving the architecture |
| `/fewer-permission-prompts` | Scanned session transcripts and added common commands to the project allowlist, reducing approval prompts during development |
| `/security-review` | (Phase 2) Security review of `EloMath.sol`, `AgentRegistry.sol`, and `MatchRegistry.sol` before testnet deploy |
| `/review` | (Phase 3+) PR reviews for the gnubg wrapper, wagmi integration, and contract interaction code |
| `/simplify` | (Phase 1) Cleaned up gnubg External Player protocol parsing code |

---

## Local Setup

### Prerequisites

- Python 3.12+, [uv](https://github.com/astral-sh/uv)
- Node 20+, npm
- `gnubg` — `sudo apt install gnubg`

### Server

```bash
cd server
cp .env.example .env   # fill in contract addresses after Phase 2 deploy
uv run uvicorn app.main:app --reload
```

### Contracts

```bash
cd contracts
cp .env.example .env   # add DEPLOYER_PRIVATE_KEY
npx hardhat compile
npx hardhat test
npx hardhat run script/deploy.js --network 0g-testnet
```

### Frontend

```bash
cd frontend
cp .env.example .env.local   # add contract addresses + API URL
npm run dev
```

---

## 0G Testnet

| | |
|---|---|
| RPC | `https://evmrpc-testnet.0g.ai` |
| Chain ID | `16602` |
| Explorer | https://chainscan-galileo.0g.ai |
| Faucet | https://build.0g.ai |

Contract addresses will be populated here after Phase 2 deployment.

---

## Roadmap

- **v1 (this submission):** Human vs gnubg agent, on-chain ELO, iNFT agents on 0G
- **v2:** Commit-reveal dice (trustless randomness), anti-cheat for human ratings
- **v3:** Agent-vs-agent matches, betting markets, ELO derivative tokens
- **v4:** Open agent marketplace — bring your own engine, stake your iNFT

---

## Submission Checklist

- [ ] Public GitHub repo
- [ ] README with pitch, demo link, live URL
- [ ] Demo video < 3 min
- [ ] Deployed contracts with explorer links
- [ ] Architecture diagram
- [ ] At least one working seed agent (gnubg)
- [ ] iNFT minted on 0G Chain
