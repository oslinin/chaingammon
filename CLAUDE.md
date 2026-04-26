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

All commands run from within the sub-project directory unless noted.

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
npx hardhat compile

# Run tests
npx hardhat test

# Run a single test file
npx hardhat test test/EloMath.test.js

# Deploy to 0G testnet (requires DEPLOYER_PRIVATE_KEY + RPC_URL in .env)
npx hardhat run script/deploy.js --network 0g-testnet
```

### frontend/ (Next.js 16, wagmi v3, viem v2)

```bash
# Dev server
npm run dev

# Production build
npm run build

# Lint
npm run lint
```

> **Important:** This Next.js version has breaking changes from prior versions. Read `node_modules/next/dist/docs/` before writing frontend code and heed deprecation notices (see `frontend/AGENTS.md`).

## Key Files

| File | Purpose |
|---|---|
| `plan.md` | Phased build plan — authoritative scope document |
| `MISSION.md` | Product vision and principles |
| `server/app/gnubg_client.py` | gnubg subprocess wrapper (External Player protocol) |
| `server/app/game_state.py` | Typed GameState model (24-point board, bar, off) |
| `server/app/chain_client.py` | web3.py wrapper for submitting match results |
| `contracts/src/EloMath.sol` | Fixed-point ELO formula — test extensively, bugs are costly |
| `contracts/src/MatchRegistry.sol` | Records matches, updates ELO for agents and humans |
| `contracts/src/AgentRegistry.sol` | ERC-721 iNFT registry for AI agents |
| `frontend/app/wagmi.ts` | wagmi config with 0G testnet custom chain |
| `frontend/app/contracts.ts` | ABI + address constants for deployed contracts |
| `frontend/app/providers.tsx` | wagmi + react-query providers wrapping the app |

## Environment Variables

Copy `.env.example` to `.env` in each sub-project before running locally. Never commit `.env` files. Deployed contract addresses go into both `contracts/deployments/0g-testnet.json` and `frontend/app/contracts.ts` after Phase 2.

## 0G Testnet

- RPC: `https://evmrpc-testnet.0g.ai`
- Chain ID: `16602`
- Explorer: `https://chainscan-galileo.0g.ai`
- Faucet: `https://build.0g.ai`

## gnubg External Player Protocol

gnubg is driven via its socket-based External Player interface. Install with `sudo apt install gnubg`. The spec lives at the GNU Backgammon manual (search "External Player Interface"). `gnubg_client.py` manages the subprocess; do not bypass it to call gnubg directly.

## Out of Scope (do not implement without asking)

Betting/prediction markets, ELO derivative tokens, agent-vs-agent matches, VRF/commit-reveal dice, anti-cheat for human ratings, mainnet deployment.
