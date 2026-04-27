# CONTEXT.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chaingammon is an **open protocol for portable backgammon reputation**. Every player — human or AI agent — has an ENS subname (`<name>.chaingammon.eth`) whose text records hold their ELO and links to their full match archive on 0G Storage. AI agents are ERC-7857 iNFTs with their gnubg weights encrypted on 0G Storage and hash-committed to the iNFT. Match settlement runs as a KeeperHub workflow that produces a verifiable audit trail. See `plan.md` for the incremental phased build plan and `log.md` for the per-phase summary log. Work through phases in order; ask the owner before deviating.

**Hackathon:** ETHGlobal Open Agents (April 24 – May 6, 2026).

**Where each protocol fits:**

- **ENS** — subnames + text records are the right primitive for portable player identity
- **0G** — agent iNFTs (Chain) and the canonical match archive + encrypted weights (Storage)
- **KeeperHub** — match settlement is a multi-step orchestration; workflows handle retry, gas, audit
- **Main track** — the open-protocol thesis stands on its own

**Important rules** (after any phase development):

1. The `README.md` should be updated with the commands to run the latest code, including deployments and tests.
2. The `log.md` file should be updated by **pasting the commit message verbatim** as the phase entry, *before* committing — so the log.md update lands in the same commit as the code. No separate summary, no hash (git history has the hash). Don't edit log.md after committing. Architectural rationale, phase definitions, and detailed designs belong in `plan.md` and this file, not in `log.md`.
3. All code files (new and updated) must be documented inline with appropriate docstrings, comments, and explanations.

## Architecture

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
   │  - dice (v1)  │       │               │       │   styles)     │
   │  - serializes │       └───────────────┘       └───────────────┘
   │     games     │
   └──────┬────────┘
          │ on game-end
          ▼
   ┌─────────────────────────────────────┐
   │  KeeperHub workflow                 │
   │   1. recordMatch on MatchRegistry   │
   │   2. update ENS text records        │
   │   3. commit gameRecordHash on-chain │
   │   4. emit audit JSON                │
   └────┬────────────────┬───────────────┘
        │                │
        ▼                ▼
 ┌──────────────┐ ┌──────────────────────────────┐
 │   0G Chain   │ │       0G Storage             │
 │ AgentRegistry│ │  Log (per match): game record│
 │ MatchRegistry│ │  Log (per match): audit data │
 │ EloMath      │ │  KV (per player): style      │
 │ ENS subname  │ │  Blob (per agent): encrypted │
 │   registrar  │ │    gnubg weights             │
 └──────────────┘ └──────────────────────────────┘
```

**Key data flows:**

- Player connects wallet → frontend resolves their `<name>.chaingammon.eth` (issues new subname if missing)
- Player picks an agent → frontend reads agent iNFT data hashes → server fetches encrypted gnubg weights from 0G Storage, decrypts, runs inference
- Each turn → server (or future VRF) rolls dice → records moves
- Game over → server serializes full game record to 0G Storage Log → triggers KeeperHub workflow with the resulting hash
- Workflow runs: `recordMatch` (with `gameRecordHash` field) → ENS text record updates (`elo`, `last_match_id`, `style_uri`, `archive_uri`) → audit JSON emitted
- Server pulls audit data, appends to the match's 0G Storage record
- Frontend match-details page reads game record + audit from 0G Storage and renders both

The server is the trusted dice roller in v1 (commit-reveal is v2 roadmap). Game state is in-memory.

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
uv run pytest tests/test_phase{N}_*.py -v

# Run a single test by name
uv run pytest tests/test_phase{N}_*.py::test_specific -v

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
pnpm dev          # dev server
pnpm build        # production build
pnpm lint         # eslint
```

> **Important:** This Next.js version has breaking changes from prior versions. Read `node_modules/next/dist/docs/` before writing frontend code and heed deprecation notices (see `frontend/AGENTS.md`).

### KeeperHub CLI (`kh`)

```bash
brew install keeperhub/tap/kh    # install
kh auth login                    # browser OAuth (or set KH_API_KEY)
kh execute contract-call ...     # one-shot tx submission
kh run status <run-id> --json    # workflow run status
kh run logs <run-id> --json      # workflow logs
kh billing usage                 # check free-tier limits
```

## Key Files

| File | Purpose |
| --- | --- |
| `plan.md` | Incremental phased build plan — authoritative scope |
| `log.md` | Strategic decision log + per-phase progress |
| `MISSION.md` | Product vision and principles |
| `server/app/gnubg_client.py` | gnubg subprocess wrapper (External Player protocol) |
| `server/app/game_state.py` | Typed GameState model |
| `server/app/game_record.py` | Match game-record serializer (uploaded to 0G Storage) |
| `server/app/chain_client.py` | web3.py wrapper for on-chain reads |
| `server/app/og_storage_client.py` | 0G Storage SDK wrapper (blob, log, KV) |
| `server/app/ens_client.py` | ENS subname text record updater |
| `server/app/keeperhub_client.py` | KeeperHub workflow trigger + audit pull |
| `contracts/src/EloMath.sol` | Fixed-point ELO formula — test extensively |
| `contracts/src/MatchRegistry.sol` | Records matches with `gameRecordHash`, updates ELO |
| `contracts/src/AgentRegistry.sol` | ERC-7857 iNFT registry (or ERC-721 fallback) |
| `contracts/src/PlayerSubnameRegistrar.sol` | ENS subname issuance + text record control |
| `frontend/app/wagmi.ts` | wagmi config with 0G testnet custom chain |
| `frontend/app/contracts.ts` | ABI + address constants for deployed contracts |
| `frontend/app/providers.tsx` | wagmi + react-query providers |
| `frontend/app/profile/[ensName]/page.tsx` | Player profile page (reads ENS text records) |
| `frontend/app/match/[matchId]/page.tsx` | Match replay + audit trail |
| `docs/keeperhub-feedback.md` | Required for KeeperHub bounty |

## Environment Variables

Copy `.env.example` to `.env` in each sub-project before running. Never commit `.env`. After Phase 4 deploy, contract addresses go into `contracts/deployments/0g-testnet.json` and `frontend/app/contracts.ts`.

Required envs by phase:

| Phase | Sub-project | Variables |
| --- | --- | --- |
| 4+ | contracts/ | `DEPLOYER_PRIVATE_KEY`, `RPC_URL` |
| 6+ | server/ | `OG_STORAGE_RPC`, `OG_STORAGE_INDEXER`, `OG_STORAGE_PRIVATE_KEY` |
| 11+ | server/ | `ENS_REGISTRAR_ADDRESS`, `ENS_PARENT_NAME=chaingammon.eth` |
| 16+ | server/ | `KH_API_KEY` (or use `kh auth login`), `KEEPERHUB_WORKFLOW_ID` |
| 12+ | frontend/ | `NEXT_PUBLIC_*` for contract addresses, RPC, API URL |

## 0G Testnet

- RPC: `https://evmrpc-testnet.0g.ai`
- Chain ID: `16602`
- Explorer: `https://chainscan-galileo.0g.ai`
- Faucet: `https://build.0g.ai`

## Sponsor Notes

**ENS:** Subnames issued under `chaingammon.eth`. Schema for text records: `elo`, `match_count`, `last_match_id`, `style_uri` (`0g://...`), `archive_uri` (`0g://...`). Frontend resolves subnames to display human-readable names everywhere addresses would otherwise appear.

**0G Storage usage:**
- Log per match → game record (gnubg `.mat` wrapped in JSON envelope)
- Log per match → KeeperHub audit JSON
- KV per player → style profile (% openings, cube tendency, bear-off speed)
- Blob per agent → encrypted gnubg weights, hash committed to iNFT

**KeeperHub:** Settlement workflow (`recordMatch` → ENS text records → on-chain hash commit → audit). Server triggers via HTTP POST. Audit pulled via `kh run status --json` and mirrored to 0G Storage so it's publicly viewable through our app.

## gnubg External Player Protocol

gnubg is driven via its socket-based External Player interface. Install with `sudo apt install gnubg`. `gnubg_client.py` manages the subprocess; do not bypass it.

## Git Policy

Never commit or push without explicit instruction from the owner. When work is ready to commit, show a summary of changed files and a draft commit message, then wait for approval.

## Test-Driven Development

This project follows TDD strictly. For every phase:

1. **Write tests first** describing the phase's "done when" criteria. Tests **MUST** live in the correct sub-project:
   - Server/Python tests in `server/tests/`
   - Solidity tests in `contracts/test/`
   - Frontend tests in `frontend/`
2. **Run tests** — they must fail (red) before implementation.
3. **Implement** the minimum code to make tests pass (green).
4. **Update `log.md`** — append the phase entry with changes, decisions, test results.
5. **Update `README.md`** — keep commands and instructions current.

**Naming:** `server/tests/test_phase{N}_*.py`, `contracts/test/*.test.js`. Each phase adds its own test file. Never delete or weaken existing tests.

## Out of Scope (do not implement without asking)

Commit-reveal dice / VRF, betting/prediction markets, ELO derivative tokens, anti-cheat for human ratings, ZK move proofs, 0G Compute, mainnet deployment, Gensyn integration.
