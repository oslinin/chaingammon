# Chaingammon — Build Log

Per-phase entries are the **commit messages, pasted verbatim** — pasted into this file *before* committing, so the log update lands in the same commit as the code. No separate summary, no commit hash (git history has the hash). Don't edit this file after committing. Architectural rationale and detailed designs live in `plan.md` and `CONTEXT.md`.

Append a new entry at the bottom as each phase lands.

---

### Phase 0 — Scaffolding ✅

**Commit:** `48d26536`
pnpm workspace at root with `contracts:*`, `frontend:*`, `server:*`, `test` scripts. Server uses uv + Python 3.12. Contracts on Hardhat 2 + Solidity 0.8.24. Frontend on Next.js 16 + wagmi + viem. Scaffold tests confirm all three start without errors.

### Phase 1 — gnubg wrapper service ✅

**Commit:** `7893a198`
`server/app/gnubg_client.py` drives gnubg via pexpect. Pydantic GameState model. FastAPI endpoints (new game, roll, move, agent-move, resign). End-to-end pytest plays a full match.

### Phase 2 — Core contracts (code + tests) ✅ (no agent minted persistently)

**Commit:** `a98d94ef`
`EloMath.sol` library (K=32, INITIAL=1500, lookup-table expected score, integer math). `MatchRegistry.sol` owner-only `recordMatch`. `AgentRegistry.sol` ERC-721 with `mintAgent` / `agentMetadata` / `agentElo` proxy. 32 hardhat tests passing. Deploy script written and runs against in-process Hardhat without error. **Nothing is live on 0G testnet yet** — that's Phase 4.

### Plan revision — multi-protocol architecture

ENS for identity (subnames + text records), 0G for agent iNFTs and the match archive, KeeperHub for orchestrated settlement. Agent iNFT carries a tier (immutable) plus two data hashes — shared base gnubg weights and a per-agent experience overlay that grows with play. 25 incremental phases, each introducing at most one new tool. See `plan.md` for the full plan.

### Phase 3: link each match to its 0G Storage game record

Phase 7 will upload every match's full game record (move sequence, dice,
cube actions) to 0G Storage as an immutable archive entry. For that
archive to be cryptographically tied to the on-chain match, MatchRegistry
needs a slot to commit the resulting blob hash. This phase adds the
slot — no 0G Storage SDK is wired up yet (that's Phase 6); the contract
just makes room and accepts whatever the caller passes.

MatchRegistry.sol changes:
- MatchInfo struct gets `bytes32 gameRecordHash` — the 0G Storage blob
  hash for that match's archive entry; `bytes32(0)` when unset
- recordMatch gets a new last argument `bytes32 gameRecordHash`, stored
  on the struct alongside the rest of the match metadata
- New event `GameRecordStored(matchId, hash)`, fired alongside
  `MatchRecorded` so off-chain indexers can subscribe to archive events
  separately from rating events
- No validation on the hash — `bytes32(0)` is permitted, so the contract
  is usable now (before Phase 6 wires up uploads) and future features
  like private games can opt out of archiving

Tests:
- `MatchRegistry_gameRecord.test.js` (new): 5 cases covering the new
  argument, struct round-trip, event emission, zero-hash permitted,
  and that two matches store distinct hashes
- `MatchRegistry.test.js`: 7 existing recordMatch calls updated to
  pass `ZeroHash` as the new argument; their behavior is unchanged

37 hardhat tests passing (32 prior + 5 new).

Also: clarified in CONTEXT.md and log.md header that log entries are
the commit message pasted verbatim, no separate summary.

### Tests: rename hardhat files and describe blocks with phase prefixes

Mocha runs test files alphabetically, so `scaffold.test.js` was running
last after `AgentRegistry`/`EloMath`/`MatchRegistry`. Renaming files to
`phaseN_*.test.js` makes the run order match phase order. Each describe
block also now starts with `Phase N — ...` so the test output reads in
phase order even when files are run in a different order.

Renamed files:
- `scaffold.test.js` → `phase0_scaffold.test.js`
- `EloMath.test.js` → `phase2_EloMath.test.js`
- `MatchRegistry.test.js` → `phase2_MatchRegistry.test.js`
- `AgentRegistry.test.js` → `phase2_AgentRegistry.test.js`
- `MatchRegistry_gameRecord.test.js` → `phase3_MatchRegistry_gameRecord.test.js`

Describe block labels updated to a consistent `Phase N — Title` format.
CONTEXT.md's "run a single test file" example points at the new path.
37/37 hardhat tests still passing; output now reads top-to-bottom in
phase order.

### Phase 4: deploy and verify contracts on 0G testnet

First persistent deploy. MatchRegistry and AgentRegistry are now live
on 0G testnet (chainId 16602); seed agent #1 minted to the deployer.
Both contracts are verified on chainscan-galileo with source code
visible.

Contracts:
- MatchRegistry: 0x905856d067B84E3B51E12DaF95e68B3D525216E6
- AgentRegistry: 0x025a51F5ea78291B303F1416FC05FC0B051393e2

Tooling additions:
- `contracts/hardhat.config.js`: loads `contracts/.env` via dotenv; new
  `etherscan` block with custom chain pointing at chainscan-galileo's
  Etherscan-compatible endpoint (`https://chainscan-galileo.0g.ai/open/api`)
- `contracts/script/verify.js`: reads `deployments/<network>.json`, looks
  up constructor args per contract, calls `verify:verify` for each. Idempotent
  (already-verified contracts are reported and skipped).
- Root `package.json`: new `contracts:verify` and `contracts:deploy-and-verify`
  scripts so verify is part of the standard flow.
- `contracts/package.json`: added `dotenv` devDependency.

Addresses recorded in `contracts/deployments/0g-testnet.json`. Local
`server/.env` and `frontend/.env.local` have been updated to point at
the deployed contracts (those `.env` files are gitignored).

Note: Phase 5 will redeploy AgentRegistry as ERC-7857; this v1 ERC-721
agent will be superseded then. Phase 4 is the smoke test confirming
the deploy + verify pipeline (compile, sign, broadcast, post-confirm
reads, source verification) works end-to-end against a live testnet.

### Phase 5: AgentRegistry as ERC-7857-compatible iNFT

ERC-7857 is the proposed **iNFT (Intelligent NFT)** standard — an extension
of ERC-721 where each token carries one or more hashes pointing at encrypted
"intelligence" stored off-chain. AgentRegistry now implements the iNFT
shape so each agent token carries:

- **tier** (uint8, 0..3) — the agent's skill level: 0=beginner,
  1=intermediate, 2=advanced, 3=world-class. Set at mint time, immutable.
  In Phase 9 this will map to gnubg's search-ply settings (deeper tiers
  search more moves ahead).

- **dataHashes[0] = baseWeightsHash** — 32-byte hash of the encrypted
  gnubg neural-network weights file stored on 0G Storage. Shared across
  all agents (every agent runs against the same gnubg base). Phase 8
  uploads the real weights and sets this hash; for now it's bytes32(0).

- **dataHashes[1] = overlayHash** — 32-byte hash of *this* agent's
  "experience overlay" stored on 0G Storage. The overlay (Phase 9) is a
  small preference vector that biases the agent's move choices and grows
  after every match — that's how each iNFT acquires a unique playing
  style on top of the shared gnubg base. Starts at bytes32(0).

- **matchCount** (uint32) — how many matches this agent has played.

- **experienceVersion** (uint32) — bumped every time the overlay is
  updated. In v1 it tracks 1:1 with matchCount.

Full ERC-7857 transfer-with-reencryption-proof flow is out of scope for
v1; we implement the data-hash *shape* that makes the iNFT story
verifiable to other tools.

Contract changes (**AgentRegistry.sol**):
- Constructor: (matchRegistryAddress, initialBaseWeightsHash)
- `mintAgent(to, metadataURI, tier)` — tier validated 0..3 at mint
- `setBaseWeightsHash(bytes32)` — owner-only; lets Phase 8 publish the
  real `baseWeightsHash` without redeploying
- `updateOverlayHash(agentId, bytes32)` — owner-only; sets `dataHashes[1]`
  and bumps `matchCount` + `experienceVersion` together
- New views: `dataHashes(agentId)` → [base, overlay]; `tier(agentId)`;
  `matchCount(agentId)`; `experienceVersion(agentId)`
- New events: `AgentMinted` now carries tier; `OverlayUpdated`; `BaseWeightsHashSet`

Deploy + verify:
- **script/deploy.js** mints the seed agent at tier 2 (advanced) and
  writes the AgentRegistry constructor args into
  **deployments/0g-testnet.json** so **script/verify.js** can replay them.
- **script/verify.js** reads `agentRegistryConstructorArgs` from the
  deployment JSON, falling back to the legacy single-arg form for older
  deployments.
- Redeployed to 0G testnet:
    MatchRegistry: 0x60E52e2d9Ea7b4A851Dd63365222c7d102A11eaE
    AgentRegistry: 0xCb0a562fa9079184922754717BB3035C0F7A983E
  Both verified on chainscan-galileo. The Phase 4 contracts (0x9058... and
  0x025a...) are now stale.
- **server/.env** and **frontend/.env.local** updated to point at the new
  addresses (those files are gitignored).

Tests:
- **phase5_AgentRegistry_iNFT.test.js** (new): 14 cases covering
  `baseWeightsHash` get/set/auth, `tier` storage and validation at mint,
  initial `dataHashes` shape, `updateOverlayHash` semantics + auth +
  non-existent-agent guard, and divergence between two same-tier agents
  after independent matches.
- **phase2_AgentRegistry.test.js**: existing 5 tests updated for the new
  `mintAgent` signature (passes `tier`) and new constructor (passes
  `ZeroHash`). Behavior unchanged.

52 hardhat tests passing (37 prior + 15 new in Phase 5).

### Phase 6: 0G Storage round-trip via the og-bridge Node helper

0G Storage is the decentralized storage layer of 0G; clients upload bytes
and get back a Merkle `rootHash` that any other client can use to fetch
those bytes. There is no native Python SDK — only Go and TypeScript — so
this phase introduces **og-bridge**, a thin Node workspace package that
wraps the official `@0gfoundation/0g-ts-sdk` and exposes two stdin/stdout
CLI scripts. The Python server shells out to them via `subprocess`.

og-bridge layout:
- **og-bridge/package.json** declares `@0gfoundation/0g-ts-sdk` + `ethers`
  as deps and exposes the two scripts as bin entries.
- **og-bridge/src/upload.mjs** — reads bytes from stdin, wraps them in
  the SDK's `MemData`, calls `Indexer.upload`, writes a single JSON line
  `{"rootHash": "0x…", "txHash": "0x…"}` to stdout. SDK progress logging
  is redirected to stderr so stdout stays parseable.
- **og-bridge/src/download.mjs** — takes a `rootHash` arg, calls
  `Indexer.downloadToBlob`, writes the raw bytes to stdout.
- og-bridge is a workspace member alongside **contracts/** and
  **frontend/** (added to **pnpm-workspace.yaml**).

Python wrapper (**server/app/og_storage_client.py**):
- `put_blob(data: bytes) → UploadResult(root_hash, tx_hash)`
- `get_blob(root_hash: str) → bytes`
- Both spawn `node og-bridge/src/<script>.mjs` with the server's env so
  `OG_STORAGE_RPC`, `OG_STORAGE_INDEXER`, `OG_STORAGE_PRIVATE_KEY` flow
  through. `OgStorageError` is raised on any non-zero exit.
- Env loading uses `python-dotenv` (added to server deps).

Env additions (server/.env.example):
- `OG_STORAGE_RPC=https://evmrpc-testnet.0g.ai`
- `OG_STORAGE_INDEXER=https://indexer-storage-testnet-turbo.0g.ai`
- `OG_STORAGE_PRIVATE_KEY=` (locally mirrors `DEPLOYER_PRIVATE_KEY` from
  **contracts/.env** since the same wallet pays storage flow-tx fees;
  both .env files are gitignored)

Tests:
- **server/tests/test_phase6_og_storage.py** (new): a live round-trip test that
  uploads 64 random bytes prefixed with a magic header, then downloads
  by `rootHash` and asserts byte-exact equality. Skipped automatically
  when `OG_STORAGE_PRIVATE_KEY` is unset, so CI without secrets stays
  green.
- Confirmed end-to-end against 0G Storage testnet (~14 s round-trip,
  most of which is waiting for the on-chain transaction that pins the
  data to 0G Storage's flow contract). All 52 hardhat tests still
  passing — no contract changes in this phase.

Phase 7 (game records on 0G Storage Log) and Phase 8 (encrypted gnubg
base weights) will both call `put_blob` / `get_blob` through this
client.

Also in this commit:
- **README.md** — new "Agent Intelligence Model" section between How It
  Works and Architecture. Spells out the two-layer model (shared gnubg
  base on `dataHashes[0]`, per-agent overlay on `dataHashes[1]`) and
  answers "why not fine-tune gnubg's nets directly" — they're small
  feedforward MLPs, not transformer LLMs, so 0G's fine-tuning service
  (LLM-only, LoRA output) doesn't apply.
- **.claudeignore** — heavy build/cache directories that Claude
  shouldn't waste context scanning (`node_modules/`, `.venv/`,
  `target/`, `.next/`, `contracts/artifacts/`, etc.).

### Phase 7 onward — pending
