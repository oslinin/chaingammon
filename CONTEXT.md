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
pnpm agent:test          # run pytest suite (gnubg + coach service tests)
pnpm test                # run all tests (agent + contracts + frontend)
```

Or run sub-project commands directly from within each directory:

### agent/ (Python 3.12, uv)

```bash
# Start gnubg agent node (port 8001)
uv run uvicorn gnubg_service:app --port 8001

# Start coach agent node (port 8002)
uv run uvicorn coach_service:app --port 8002

# Start both via AXL (recommended)
bash start.sh

# Run all tests
uv run pytest

# Run a single test file
uv run pytest tests/test_gnubg_service.py -v

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
pnpm dev          # dev server (next dev --webpack)
pnpm build        # production build (next build --webpack)
pnpm lint         # eslint
pnpm test:e2e     # Playwright suite — required before any frontend commit
```

> **Important:** This Next.js version has breaking changes from prior versions. Read `node_modules/next/dist/docs/` before writing frontend code and heed deprecation notices (see `frontend/AGENTS.md`).

See `## Frontend Policies` below for the three rules every frontend change must follow (chain registry, Playwright, no Turbopack).

### AXL (Gensyn Agent eXchange Layer)

```bash
axl start --config agent/axl-config.json   # start the local AXL node
axl peers                                   # list connected peers
axl status                                  # node health + registered services
```

## Key Files

| File | Purpose |
| --- | --- |
| `plan.md` | Incremental phased build plan — authoritative scope |
| `log.md` | Strategic decision log + per-phase progress |
| `MISSION.md` | Product vision and principles |
| `agent/gnubg_service.py` | AXL agent node: gnubg move evaluation via External Player interface |
| `agent/coach_service.py` | AXL agent node: flan-t5-base LLM coaching hints with 0G Storage RAG context |
| `agent/axl-config.json` | AXL node config: service registrations for gnubg (8001) and coach (8002) |
| `agent/start.sh` | Start script: launches AXL node + both agent services |
| `scripts/upload_gnubg_docs.py` | One-time script: upload gnubg strategy docs to 0G Storage for coach RAG |
| `contracts/src/PlayerSubnameRegistrar.sol` | ENS-shaped subname registrar. Issues `<label>.chaingammon.eth` subnames with text records (`elo`, `match_count`, `last_match_id`, `style_uri`, `archive_uri`). |
| `contracts/src/EloMath.sol` | Fixed-point ELO formula — test extensively |
| `contracts/src/MatchRegistry.sol` | Records matches with `gameRecordHash`, updates ELO |
| `contracts/src/AgentRegistry.sol` | ERC-7857 iNFT registry (or ERC-721 fallback) |
| `contracts/src/PlayerSubnameRegistrar.sol` | ENS subname issuance + text record control |
| `frontend/app/wagmi.ts` | wagmi config (Phase 12): `defineChain` for 0G Galileo testnet (chainId 16602) + `createConfig` with `injected` connector. |
| `frontend/app/contracts.ts` | ABI + address constants for deployed contracts |
| `frontend/app/providers.tsx` | Client Component wrapping `WagmiProvider` + `QueryClientProvider` (Phase 12). |
| `frontend/app/ConnectButton.tsx` | Client Component (Phase 12): three-state connect button (no wallet / connect / connected with chain-switch nudge). |
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
| 11+ | server/ | `PLAYER_SUBNAME_REGISTRAR_ADDRESS` (parent node is loaded from the contract; default at deploy time is namehash of `chaingammon.eth`, override with `ENS_PARENT_NODE` for the deploy script). |
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

### Structure

Every phase commit message follows this anatomy — keep each section brief but complete enough to read without opening the code:

```
Phase N: <one-line title — what changed, not how>

<Opening paragraph: the goal and why it matters. One to three sentences.
Define any sponsor, protocol, or project term that appears here for the
first time. No bullet points — prose only.>

<Component heading> (<file path>, new|updated):
- <public surface, method, or behaviour — one bullet per item>
  - <sub-detail, edge case, or constraint where needed>
  - <another sub-detail>
- <next item>

<Repeat one block per major new file or component.>

<Deployed contract address block — include only when a contract was
deployed in this phase:>
<ContractName> deployed to <network>:
<0xADDRESS>

Tests (<sub-project>/tests/):
- <test_phaseN_topic.py> (new, N tests):
  - <what the first group of tests covers>
  - <what the second group covers>
  - <skip condition, if any>
- <test_phaseN_live.py> (new, N tests):
  - <what the live test does end-to-end>
  - <skip condition>

<N> <sub-project> tests pass (<prior count> prior + <new count> new).
```

**Rules:**
- **Header** — `Phase N: title`. Max 120 chars. The `chaingammon-commit-format` Claude skill enforces this.
- **Brief** — the goal is a scannable record, not a tutorial. If a detail is obvious from the code, omit it; if it explains a non-obvious decision (why non-fatal, why deferred, why a specific address), keep it.
- **New functionality first, tests last.** Sections appear in the order: goal paragraph → new files/components (each as a separate block) → deployed addresses → tests → test count summary.
- **Sponsors and tools** — name each sponsor/tool (ENS, 0G Storage, KeeperHub, gnubg) the first time it appears in the message and give a one-clause definition if it isn't obvious from context.
- **Deployed addresses** — include the full checksummed hex address for every contract deployed in the phase. Format: contract name on one line, address on the next.
- **Tests** — list every new test file as a top-level bullet; list the individual test cases or logical groups as sublists beneath it. Include the skip condition for any test that is not always run.

The Phase 11 commit message (in `log.md`) is the canonical example of this style.

### Definitions and formatting

Define every project-specific term, contract field, function name, or acronym **the first time it appears** in a commit message. A reader who has only read MISSION.md and the Solidity source should be able to follow the commit message without context. If a name comes from a standard or external system (e.g. ERC-7857, gnubg, 0G Storage), give a one-clause definition the first time it shows up. Examples — what the term means, what units, who sets it, default value — pick the framing that disambiguates fastest.

**File paths — different rules for log.md vs commit messages:**

- **In `log.md`** — use a bold relative markdown link so the path is clickable in VS Code preview and on GitHub: `**[contracts/script/deploy_registrar.js](contracts/script/deploy_registrar.js)**`. The link text and the href are both the repo-root-relative path. Never abbreviate (`tests/...` or `src/...` are ambiguous across sub-projects).
- **In commit messages** — use bold plain text only, no markdown link syntax. Git renders commit bodies as plain text in `git log`, `git show`, and most tooling; `[path](path)` appears verbatim and is noisy. Format: `**contracts/script/deploy_registrar.js**`.

**Other formatting (applies to both log.md and commit messages):**
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
   - Frontend unit-style tests via build/typecheck; visual + DOM regressions via Playwright in `frontend/tests/`
2. **Run tests** — they must fail (red) before implementation.
3. **Implement** the minimum code to make tests pass (green).
4. **Update `log.md`** — append the phase entry with changes, decisions, test results.
5. **Update `README.md`** — keep commands and instructions current.

**Naming:** `server/tests/test_phase{N}_*.py`, `contracts/test/*.test.js`, `frontend/tests/<topic>.spec.ts`. Each phase adds its own test file. Never delete or weaken existing tests.

See `## Frontend Policies` for Playwright, chain registry, and bundler rules — they apply to every frontend commit.

## Frontend Policies

Three rules every change inside `frontend/` must follow. They exist because each one came from a real broken state we don't want to revisit.

### 1. Chain registry — never hardcode chains or addresses

`frontend/app/chains.ts` is the single source of truth for which chains the frontend speaks to and which contract addresses live where. It pairs `chainId → {viem Chain, contract addresses}` by combining a small `CHAIN_DEFS` map (display metadata: name, RPC, explorer) with deployment JSON imported from `contracts/deployments/<network>.json` (which Hardhat writes on every `script/deploy.js` run).

- **Adding a new chain:**
  1. Deploy: `cd contracts && pnpm exec hardhat run script/deploy.js --network <name>` — produces `contracts/deployments/<name>.json` with chainId + addresses.
  2. Edit `frontend/app/chains.ts`: add a `CHAIN_DEFS[<chainId>] = { name, nativeCurrency, rpcUrl, explorerUrl, testnet }` entry and import the new deployment JSON into `ALL_DEPLOYMENTS`. Both `wagmi.ts` and `contracts.ts` pick it up automatically.
- **Active chain follows the wallet at runtime.** There is NO `NEXT_PUBLIC_CHAIN_ID` env var — chainIds live in the deployment JSON, the active selector lives in MetaMask. Switch networks in the wallet and the UI re-targets that chain's contracts. SSR / not-connected falls back to the first chain in `ALL_CHAINS` (the wagmi config default).
- **No per-address env vars.** `NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS` etc. were removed and must not come back. Addresses ride from the deployment JSON files.
- **Reading addresses in components:** call `useChainContracts()` from `frontend/app/contracts.ts` — returns `{matchRegistry, agentRegistry, playerSubnameRegistrar}` for the wallet's current chain. Pair every `useReadContract` / `useReadContracts` with `chainId: useActiveChainId()` so the read goes to the same chain whose addresses you're using.

Why: before this design, switching between Mode A (0G testnet) and Mode B (Hardhat localhost) meant editing four env vars and three TS files. We shipped at least one bug from address/chain mismatch where the wallet was on Hardhat but reads went to testnet addresses.

### 2. Playwright is the visual-regression gate

Any change touching `frontend/app/**` (component, layout, routing) MUST be verified by running `pnpm --filter frontend test:e2e` before committing. The suite (`playwright.config.ts`) spins up `next dev` automatically with `reuseExistingServer: true` so it works whether or not a dev server is already up.

- **Canonical example:** `frontend/tests/dice-size.spec.ts` renders `<DiceRoll>` on a deps-free fixture page (`frontend/app/test-dice/page.tsx`) and asserts each die's bounding box ≤ 32px in both dimensions. The original 40px (`h-10 w-10`) regression is what motivated the test; an accidental upgrade back to `h-10` would fail the spec instantly.
- **Every new visual primitive** (board overflow, dice size, header chrome) gets a similar bounding-box / DOM-shape spec. Don't trust the build + typecheck to catch visual regressions — they won't.
- **Skipping `test:e2e` on a frontend commit is a process violation** even if the build is green.

Why: Tailwind class drift is invisible to TS and the build, but very visible to humans on the demo screen.

### 3. Webpack only — no Turbopack

`frontend/package.json` pins `dev`, `build`, and `test` to `next … --webpack`. **Do not remove the `--webpack` flag** and do not run `next dev` / `next build` without it.

- Reason: Turbopack made the dev box freeze under load (large memory footprint + tight watcher loop). Webpack is slower to compile but stable.
- The `injected` connector is imported from `@wagmi/core` (not `wagmi/connectors`) for the same reason: Webpack chokes on `wagmi/connectors`'s umbrella export, which transitively pulls in `@wagmi/core/tempo` (which imports a missing `accounts` package). Turbopack tree-shakes that path away; Webpack does not. If you reintroduce a `wagmi/connectors` import, you'll break the build.

Why: a frozen dev machine costs more time than a slightly slower bundler. Stability over speed for this project.

## Out of Scope (do not implement without asking)

Commit-reveal dice / VRF, betting/prediction markets, ELO derivative tokens, anti-cheat for human ratings, ZK move proofs, 0G Compute, mainnet deployment, Gensyn integration.
