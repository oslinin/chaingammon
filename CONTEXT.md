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
pnpm contracts:compile             # compile contracts
pnpm contracts:test                # run Hardhat tests
pnpm contracts:deploy              # deploy to 0G testnet (writes deployments/0g-testnet.json)
pnpm contracts:verify              # verify deployed contracts on chainscan-galileo
pnpm contracts:deploy-and-verify   # both in one shot
pnpm frontend:dev                  # Next.js dev server
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
pnpm exec hardhat test test/phase2_EloMath.test.js

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
| `server/app/og_storage_client.py` | Python wrapper around the og-bridge Node CLI for 0G Storage put/get |
| `server/app/game_record.py` | GameRecord pydantic schema + serializer for 0G Storage uploads (Phase 7) |
| `server/app/chain_client.py` | web3.py client for MatchRegistry + AgentRegistry — recordMatch, setBaseWeightsHash, and read-only views; embedded minimal ABIs |
| `server/app/weights.py` | AES-256-GCM helper for encrypting gnubg's base weights file (Phase 8) |
| `server/scripts/upload_base_weights.py` | One-time script: encrypt **/usr/lib/gnubg/gnubg.wd**, upload to 0G Storage, pin the hash on AgentRegistry |
| `server/app/agent_overlay.py` | Per-agent experience overlay (Phase 9): `Overlay` dataclass, `classify_move`, `apply_overlay`, `update_overlay`. Uploaded to 0G Storage; hash committed to `dataHashes[1]` on the agent iNFT. |
| `og-bridge/src/upload.mjs` | Node CLI: bytes via stdin → 0G Storage upload → JSON {rootHash, txHash} on stdout |
| `og-bridge/src/download.mjs` | Node CLI: rootHash arg → bytes on stdout via 0G Storage |
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
| 4+ | contracts/ | `DEPLOYER_PRIVATE_KEY`, `RPC_URL`, optional `CHAINSCAN_API_KEY` (placeholder works on testnet) |
| 6+ | server/ | `OG_STORAGE_RPC`, `OG_STORAGE_INDEXER`, `OG_STORAGE_PRIVATE_KEY` (can mirror `DEPLOYER_PRIVATE_KEY` from contracts/.env locally) |
| 7+ | server/ | `RPC_URL`, `MATCH_REGISTRY_ADDRESS`, `DEPLOYER_PRIVATE_KEY` (mirrored from contracts/.env), optional `AGENT_REGISTRY_ADDRESS` |
| 8+ | server/ | `BASE_WEIGHTS_ENCRYPTION_KEY` — 32-byte hex, AES-256 key for the gnubg weights blob. Generate once with `uv run python scripts/upload_base_weights.py --print-fresh-key`. |
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

## Commit Messages

Define every project-specific term, contract field, function name, or acronym **the first time it appears** in a commit message. A reader who has only read MISSION.md and the Solidity source should be able to follow the commit message without context. If a name comes from a standard or external system (e.g. ERC-7857, gnubg, 0G Storage), give a one-clause definition the first time it shows up. Examples — what the term means, what units, who sets it, default value — pick the framing that disambiguates fastest.

**Markdown formatting in commit messages and other docs:**
- **File paths** — bold and **always relative to the repo root** (`**server/tests/test_phase6_og_storage.py**`, `**contracts/src/AgentRegistry.sol**`, `**og-bridge/src/upload.mjs**`). Never abbreviate to `tests/...` or `src/...` — the reader can't tell which sub-project is meant.
- **Code identifiers** (function names, struct fields, types, variables, events, addresses) — backticks (`` `mintAgent` ``, `` `dataHashes[1]` ``).
- Standards/external system names (ERC-7857, gnubg, 0G Storage) — plain text, no formatting.
- **No manual word-wrap inside paragraphs.** Paragraphs are single lines — markdown reflows them in any renderer. Hard line breaks at 72/80 chars look ragged on GitHub and force re-wrapping when content edits. Bullet items themselves can wrap naturally; just don't insert hard newlines mid-sentence.
- **Use nested sublists for hierarchy.** When a bullet has multiple sub-points (e.g. "the upload script does five things" or "the new method exposes these surfaces"), nest them as a real sublist instead of cramming the detail into one long bullet. Numbered sublists for ordered steps, bulleted sublists for parallel facts.

## Git Policy

The flow at the end of every phase is **always**:

1. Show the owner a summary of changed files and a draft commit message
2. Paste the commit message verbatim into `log.md` as the new phase entry (no hash, no separate summary — see the log.md header)
3. **Stop and wait.** Do not run `git commit` or `git push`.
4. Only when the owner explicitly says "commit" (or equivalent — "ship it", "go", etc.), run the commit and push.

Approval is **per-commit, not per-workflow**. A previously approved flow does not stand as approval for future commits. Pasting the message into `log.md` is part of the prep, not a green light to commit. When in doubt, stop and ask.

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
