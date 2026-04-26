# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chaingammon is a permissionless backgammon ecosystem for ETHGlobal Open Agents (0G track, deadline May 6 2026). The core primitive: a gnubg-powered AI agent minted as an iNFT on 0G Chain, playing humans and earning on-chain ELO. See `plan.md` for the full phased build plan — work through phases in order and ask the owner before deviating from scope.

## Architecture

```
Frontend (Next.js 16)  ──HTTPS/WSS──▶  Game Server (FastAPI)  ──subprocess──▶  gnubg
       │                                        │
       │ wagmi / viem                           │ web3.py
       ▼                                        ▼
0G Chain (testnet, chainId 16602)        0G Storage (agent metadata JSON)
  AgentRegistry.sol (iNFT / ERC-721)
  MatchRegistry.sol  (ELO updates)
  EloMath.sol        (K=32, init=1500, fixed-point)
```

Key data flows:

- Human clicks "roll" → frontend calls `POST /games/{id}/roll` → server rolls dice, returns state
- Human submits move → `POST /games/{id}/move` → server validates, passes to gnubg
- Agent turn → `POST /games/{id}/agent-move` → server asks gnubg via External Player socket protocol
- Game over → frontend calls `recordMatch` on `MatchRegistry` via wagmi → ELO updates on 0G Chain

The server is the trusted dice roller (commit-reveal is v2). Game state is in-memory; SQLite is a stretch goal.

## Sub-project Commands

Root-level workspace scripts (run from repo root):

```bash
pnpm contracts:compile   # compile contracts
pnpm contracts:test      # run Hardhat tests
pnpm contracts:deploy    # deploy to 0G testnet
pnpm frontend:dev        # Next.js dev server
pnpm frontend:build      # production build
pnpm frontend:test       # frontend build check
pnpm server:test         # run pytest suite
pnpm test                # run all tests (server + contracts + frontend)
```

Or run sub-project commands directly from within each directory:

### server/ (Python 3.12, uv)

```bash
# Run dev server
uv run uvicorn app.main:app --reload

# Run all tests
uv run pytest

# Run a single test file
uv run pytest tests/test_game.py

# Run a single test by name
uv run pytest tests/test_game.py::test_full_game -v

# Add a dependency
uv add <package>
```

### contracts/ (Hardhat 2, Solidity 0.8.24)

```bash
# Compile contracts (evmVersion: cancun, optimizer on)
pnpm exec hardhat compile

# Run tests
pnpm exec hardhat test

# Run a single test file
pnpm exec hardhat test test/EloMath.test.js

# Deploy to 0G testnet (requires DEPLOYER_PRIVATE_KEY + RPC_URL in .env)
pnpm exec hardhat run script/deploy.js --network 0g-testnet
```

### frontend/ (Next.js 16, wagmi v3, viem v2)

```bash
# Dev server
pnpm dev

# Production build
pnpm build

# Lint
pnpm lint
```

> **Important:** This Next.js version has breaking changes from prior versions. Read `node_modules/next/dist/docs/` before writing frontend code and heed deprecation notices (see `frontend/AGENTS.md`).

## Key Files

| File                              | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `plan.md`                         | Phased build plan — authoritative scope document            |
| `MISSION.md`                      | Product vision and principles                               |
| `server/app/gnubg_client.py`      | gnubg subprocess wrapper (External Player protocol)         |
| `server/app/game_state.py`        | Typed GameState model (24-point board, bar, off)            |
| `server/app/chain_client.py`      | web3.py wrapper for submitting match results                |
| `contracts/src/EloMath.sol`       | Fixed-point ELO formula — test extensively, bugs are costly |
| `contracts/src/MatchRegistry.sol` | Records matches, updates ELO for agents and humans          |
| `contracts/src/AgentRegistry.sol` | ERC-721 iNFT registry for AI agents                         |
| `frontend/app/wagmi.ts`           | wagmi config with 0G testnet custom chain                   |
| `frontend/app/contracts.ts`       | ABI + address constants for deployed contracts              |
| `frontend/app/providers.tsx`      | wagmi + react-query providers wrapping the app              |

## Environment Variables

Copy `.env.example` to `.env` in each sub-project before running locally. Never commit `.env` files. Deployed contract addresses go into both `contracts/deployments/0g-testnet.json` and `frontend/app/contracts.ts` after Phase 2.

## 0G Testnet

- RPC: `https://evmrpc-testnet.0g.ai`
- Chain ID: `16602`
- Explorer: `https://chainscan-galileo.0g.ai`
- Faucet: `https://build.0g.ai`

## gnubg External Player Protocol

gnubg is driven via its socket-based External Player interface. Install with `sudo apt install gnubg`. The spec lives at the GNU Backgammon manual (search "External Player Interface"). `gnubg_client.py` manages the subprocess; do not bypass it to call gnubg directly.

## Git Policy

Never commit or push without explicit instruction from the owner. When work is ready to commit, show a summary of changed files and a draft commit message, then wait for approval.

## Test-Driven Development

This project follows TDD. For every phase:

1. **Write tests first** that describe the phase's "done when" criteria before writing any implementation code. Tests **MUST** be placed in the correct subproject directory that corresponds to the code being tested:
   - Server/Python tests go in `server/tests/`
   - Smart Contract/Solidity tests go in `contracts/test/`
   - Frontend/Next.js tests go in `frontend/`
2. **Run tests** — they must fail (red) before you write the implementation.
3. **Implement** the minimum code to make tests pass (green).
4. **Update `log.md`** — append the phase, commit hash, and test results after each phase lands.
5. **Update `README.md`** — after any development of any phase, ensure the README is updated with the latest commands and instructions to run the code.

Test locations:

- `server/tests/test_phase{N}_*.py` — pytest, run with `uv run pytest tests/test_phase{N}_*.py -v`
- `contracts/test/*.test.js` — Hardhat/Mocha, run with `npx hardhat test test/*.test.js`
- `frontend/` — Add tests where appropriate using the frontend's testing framework.

The Phase 0 scaffold tests (`test_phase0_scaffold.py`, `scaffold.test.js`) serve as the baseline. Each later phase adds its own test file. Never delete or weaken existing tests.

## Out of Scope (do not implement without asking)

Betting/prediction markets, ELO derivative tokens, agent-vs-agent matches, VRF/commit-reveal dice, anti-cheat for human ratings, mainnet deployment.
