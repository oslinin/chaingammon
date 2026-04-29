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

Contract changes (**[AgentRegistry.sol](contracts/src/AgentRegistry.sol)**):
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
- **[script/deploy.js](contracts/script/deploy.js)** mints the seed agent at tier 2 (advanced) and
  writes the AgentRegistry constructor args into
  **[deployments/0g-testnet.json](contracts/deployments/0g-testnet.json)** so **[script/verify.js](contracts/script/verify.js)** can replay them.
- **[script/verify.js](contracts/script/verify.js)** reads `agentRegistryConstructorArgs` from the
  deployment JSON, falling back to the legacy single-arg form for older
  deployments.
- Redeployed to 0G testnet:
    MatchRegistry: 0x60E52e2d9Ea7b4A851Dd63365222c7d102A11eaE
    AgentRegistry: 0xCb0a562fa9079184922754717BB3035C0F7A983E
  Both verified on chainscan-galileo. The Phase 4 contracts (0x9058... and
  0x025a...) are now stale.
- **[server/.env](server/.env)** and **[frontend/.env.local](frontend/.env.local)** updated to point at the new
  addresses (those files are gitignored).

Tests:
- **[phase5_AgentRegistry_iNFT.test.js](contracts/test/phase5_AgentRegistry_iNFT.test.js)** (new): 14 cases covering
  `baseWeightsHash` get/set/auth, `tier` storage and validation at mint,
  initial `dataHashes` shape, `updateOverlayHash` semantics + auth +
  non-existent-agent guard, and divergence between two same-tier agents
  after independent matches.
- **[phase2_AgentRegistry.test.js](contracts/test/phase2_AgentRegistry.test.js)**: existing 5 tests updated for the new
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
- **[og-bridge/package.json](og-bridge/package.json)** declares `@0gfoundation/0g-ts-sdk` + `ethers`
  as deps and exposes the two scripts as bin entries.
- **[og-bridge/src/upload.mjs](og-bridge/src/upload.mjs)** — reads bytes from stdin, wraps them in
  the SDK's `MemData`, calls `Indexer.upload`, writes a single JSON line
  `{"rootHash": "0x…", "txHash": "0x…"}` to stdout. SDK progress logging
  is redirected to stderr so stdout stays parseable.
- **[og-bridge/src/download.mjs](og-bridge/src/download.mjs)** — takes a `rootHash` arg, calls
  `Indexer.downloadToBlob`, writes the raw bytes to stdout.
- og-bridge is a workspace member alongside **contracts/** and
  **frontend/** (added to **[pnpm-workspace.yaml](pnpm-workspace.yaml)**).

Python wrapper (**[server/app/og_storage_client.py](server/app/og_storage_client.py)**):
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
  **[contracts/.env](contracts/.env)** since the same wallet pays storage flow-tx fees;
  both .env files are gitignored)

Tests:
- **[server/tests/test_phase6_og_storage.py](server/tests/test_phase6_og_storage.py)** (new): a live round-trip test that
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
- **[README.md](README.md)** — new "Agent Intelligence Model" section between How It
  Works and Architecture. Spells out the two-layer model (shared gnubg
  base on `dataHashes[0]`, per-agent overlay on `dataHashes[1]`) and
  answers "why not fine-tune gnubg's nets directly" — they're small
  feedforward MLPs, not transformer LLMs, so 0G's fine-tuning service
  (LLM-only, LoRA output) doesn't apply.
- **[.claudeignore](.claudeignore)** — heavy build/cache directories that Claude
  shouldn't waste context scanning (`node_modules/`, `.venv/`,
  `target/`, `.next/`, `contracts/artifacts/`, etc.).

### Phase 7: archive each match to 0G Storage and record it on-chain

End-of-game now does three things in one server-side flow: it builds
a canonical match archive (a `GameRecord` envelope), uploads that
archive to 0G Storage to get back a 32-byte Merkle `rootHash` (the
content-addressed identifier 0G Storage uses for blobs), and calls
`recordMatch` on **[contracts/src/MatchRegistry.sol](contracts/src/MatchRegistry.sol)** with that
`rootHash` as the `gameRecordHash` field. The on-chain match record is
now cryptographically tied to the off-chain archive: anyone can read
`MatchRegistry.getMatch(id).gameRecordHash` and pull the canonical
replay from 0G Storage.

New modules:

- **[server/app/game_record.py](server/app/game_record.py)** — defines:
  - `PlayerRef` — one side of the match: either a human (wallet address)
    or an agent iNFT (token id, the ERC-7857 agent registry id).
  - `MoveEntry` / `CubeAction` — per-turn play and doubling-cube events.
  - `GameRecord` — the canonical envelope: `match_length`, `final_score`,
    `winner` / `loser` (PlayerRefs), `final_position_id` and
    `final_match_id` (gnubg's native base64 strings, so any tool with
    gnubg installed can reconstruct the end state bit-perfectly), optional
    `moves` and `cube_actions` lists, optional ISO-8601 `started_at` /
    `ended_at`, and a reserved `mat_format` slot for a v2 `.mat` text
    export from gnubg's `export match` command.
  - `serialize_record(record) → bytes` — canonical JSON, sorted keys,
    UTF-8, so the same record always produces the same Merkle root on
    0G Storage.
  - `build_from_state(state, ...)` — convenience constructor from a
    final-state `GameState`.

- **[server/app/chain_client.py](server/app/chain_client.py)** — `ChainClient`, a thin web3.py wrapper
  around MatchRegistry. v1 sends `recordMatch` from the deployer wallet
  (which owns the contract); Phase 18 will route this through a
  KeeperHub workflow instead. Methods:
  - `record_match(winner_agent_id, winner_human, loser_agent_id,
    loser_human, match_length, game_record_hash) → FinalizedMatch(match_id, tx_hash)`
  - `get_match(match_id) → dict` (returns the on-chain `MatchInfo`
    fields including `gameRecordHash`)
  - `agent_elo(agent_id)`, `human_elo(address)`, `match_count()`
  - `from_env()` constructor reading `RPC_URL`,
    `MATCH_REGISTRY_ADDRESS`, `DEPLOYER_PRIVATE_KEY`.
  - The MatchRegistry ABI is embedded as a Python list (only the
    surface we touch — recordMatch, getMatch, matchCount, agentElo,
    humanElo, MatchRecorded, EloUpdated, GameRecordStored). Keep in
    sync with **[contracts/src/MatchRegistry.sol](contracts/src/MatchRegistry.sol)** when that contract
    changes.

Server endpoint:

- **[server/app/main.py](server/app/main.py)** — new `POST /games/{game_id}/finalize` that
  takes `{winner_agent_id, winner_human_address, loser_agent_id,
  loser_human_address}`, validates the game has ended, builds the
  GameRecord, calls `put_blob` (Phase 6's 0G Storage upload), then
  calls `chain.record_match` with the resulting root hash. Returns
  `{match_id, tx_hash, root_hash}`.

Move-history tracking:

- **[server/app/main.py](server/app/main.py)** also keeps a per-game `_move_history` dict.
  `POST /games/{game_id}/move` and `POST /games/{game_id}/agent-move`
  capture turn + dice *before* the gnubg call (since dice get cleared
  after a successful move) and append a `MoveEntry(turn, dice, move,
  position_id_after)` after the call returns. `/finalize` passes that
  list into `build_from_state` so the GameRecord uploaded to 0G
  Storage carries the full play sequence.
- **[server/app/gnubg_client.py](server/app/gnubg_client.py)** — `get_agent_move` now surfaces
  `best_move` (the move string gnubg chose) on its return dict so
  the agent's checker actions are recordable. Auto-played positions
  return `best_move=None` and the server logs `"(auto-played)"`.
- Cube actions aren't tracked yet — `cube_actions` stays an empty
  list in v1 because the doubling-cube flow isn't wired through any
  endpoint yet. That's a separate scope item, not a Phase 7 gap.

Env additions (**[server/.env.example](server/.env.example)**):

- `DEPLOYER_PRIVATE_KEY=` — server signs `recordMatch` as the contract
  owner. Mirror the value from **[contracts/.env](contracts/.env)** locally; both
  files are gitignored.

Tests:

- **[server/tests/test_phase7_game_record_schema.py](server/tests/test_phase7_game_record_schema.py)** (new): 15 fast
  unit tests pinning down the GameRecord schema and serializer. They
  cover `PlayerRef` validation (kind must be human or agent), JSON
  round-trip (serialize → parse → equality), serialization
  determinism (same record → same bytes — required because the bytes'
  Merkle root *is* the on-chain hash), valid-UTF8 + JSON output,
  None-field omission (so the canonical form stays stable), and
  field-by-field preservation of `final_score`, `final_position_id`,
  `final_match_id`, moves, cube_actions, and player kinds. Plus
  coverage for `build_from_state`. No network — runs in ~130 ms.
  Uses Hardhat's well-known account #0 as a recognizable fake
  address for schema-only fields.
- **[server/tests/test_phase7_chain_client.py](server/tests/test_phase7_chain_client.py)** (new): 9 fast unit
  tests for `ChainClient.record_match` and `from_env` with every
  web3 dependency mocked. Covers happy-path return values
  (matchId parsed from the MatchRecorded log, tx_hash gets a 0x
  prefix), arg pass-through to the contract, correct nonce/chainId
  on the built transaction, error paths (receipt reverted,
  MatchRecorded event missing, game_record_hash without 0x prefix),
  and `from_env` behaviour (missing env, unreachable RPC, full
  construction). No network — runs in ~650 ms.
- **[server/tests/test_phase7_move_tracking.py](server/tests/test_phase7_move_tracking.py)** (new): 3 fast unit
  tests covering the runtime move-history wiring with `gnubg` and
  `_build_game_state` mocked. Asserts that `/games` initialises an
  empty history, that `/move` records a `MoveEntry` carrying
  pre-move turn/dice (since dice get cleared after the move), and
  that `/agent-move` records `gnubg`'s `best_move` string. No
  network — runs in ~1 s.
- **[server/tests/test_phase7_game_record.py](server/tests/test_phase7_game_record.py)** (new): a live
  integration test that builds a synthetic finished GameRecord,
  uploads via `put_blob`, calls `chain.record_match`, then reads the
  match back on-chain and asserts `gameRecordHash` equals the
  upload's root hash. Also re-downloads from 0G Storage and asserts
  byte-exact equality. Skipped automatically when any of
  `OG_STORAGE_PRIVATE_KEY`, `RPC_URL`, `MATCH_REGISTRY_ADDRESS`,
  `DEPLOYER_PRIVATE_KEY` are unset, so CI without secrets stays
  green.
- 36/36 server tests pass: Phase 0 scaffold ×7 + Phase 6 round-trip
  + Phase 7 schema ×15 + Phase 7 chain_client ×9 + Phase 7 move
  tracking ×3 + Phase 7 integration. The 27 fast unit tests run
  with no network in <1 s combined; the one live test runs against
  0G testnet in ~24 s.
- Hardhat tests still green: 52/52, no contract changes in this
  phase.

Notes:

- The web3.py `process_receipt` call warned on every `recordMatch`
  because it tries to decode every log against the `MatchRecorded`
  event ABI (other events fire in the same tx). Suppressed inside
  `chain_client.record_match` with `warnings.catch_warnings` so the
  server log stays clean.

Also in this commit:

- **[README.md](README.md)** — new "Match Archive on 0G Storage" section between
  "Agent Intelligence Model" and "Architecture". Explains *why* matches
  are archived off-chain (games are the substance, not just ELO),
  enumerates every field of the `GameRecord` envelope with what each
  carries, and walks through the on-chain ↔ off-chain link (build →
  upload → record on-chain with the resulting `rootHash`). Lands the
  punchline: anyone can resolve a match by id, read the on-chain
  `gameRecordHash`, and pull the canonical replay from 0G Storage —
  no login, no API key, no platform.
- Repo cleanup: removed the obsolete root-level test scripts
  **[test_dance.py](test_dance.py)**, **[test_pass.py](test_pass.py)**, **[test_pos.py](test_pos.py)**, and
  **[test_startup.py](test_startup.py)**. They were exploratory gnubg / startup
  one-shots from before the Phase 0 scaffold; they had been deleted
  from the working tree long ago but the deletions had never been
  staged. Deletions land with Phase 7 to clean up `git status`.
- **[.claude/settings.json](.claude/settings.json)** — enabled the Anthropic-published
  `superpowers` and `code-review` plugins (`claude-plugins-official`)
  at project scope. `superpowers` ships brainstorming, subagent-driven
  development, systematic debugging, and red/green TDD cycle
  enforcement; `code-review` adds an inline reviewer pass. Adopting
  these from Phase 8 onward in place of the manually-maintained
  policies in CONTEXT.md.

### Phase 8: encrypt gnubg base weights and pin them on 0G Storage

Every agent iNFT carries `dataHashes[0]` — a 32-byte pointer to the encrypted gnubg neural-network weights file on 0G Storage. Until now it was `bytes32(0)` (a placeholder set at mint). This phase uploads the real weights file once, encrypted, and pins the resulting Merkle `rootHash` (the content-addressed identifier 0G Storage uses for blobs) on AgentRegistry via `setBaseWeightsHash`. Every existing and future agent's `dataHashes[0]` now resolves to the same shared blob.

What's "the real weights file"? gnubg ships a single neural-network weights file at **[/usr/lib/gnubg/gnubg.wd](/usr/lib/gnubg/gnubg.wd)** (~399 KB on Ubuntu). It's the *intelligence* the gnubg engine runs against; gnubg the binary is the *runtime*. We don't retrain it — see the README's Agent Intelligence Model section for why.

New encryption helper (**[server/app/weights.py](server/app/weights.py)**):

- AES-256-GCM with a server-held key (`BASE_WEIGHTS_ENCRYPTION_KEY` env var, 32 bytes hex).
  - v2 will switch to per-owner hybrid encryption so each iNFT owner can decrypt independently.
  - v1 keeps a single key because every owner runs the same shared gnubg base.
- `encrypt_weights(plaintext, key) → EncryptedWeights` — fresh random 12-byte nonce per call (GCM mandates nonce uniqueness).
- `decrypt_weights(envelope, key) → bytes` — wraps `cryptography`'s `AESGCM.decrypt`, raises `WeightsCryptoError` on auth-tag failure.
- Envelope on-disk layout: `[version=0x01][nonce: 12 bytes][ciphertext+GCM tag]`. The version byte is reserved so v2 can change layout without breaking v1 readers.
- `EncryptedWeights.to_bytes()` / `from_bytes()` — what gets uploaded to 0G Storage; round-trips deterministically.
- `generate_key()` returns 32 random bytes; `load_key_from_env()` reads `BASE_WEIGHTS_ENCRYPTION_KEY` and decodes hex.

One-time upload script (**[server/scripts/upload_base_weights.py](server/scripts/upload_base_weights.py)**):

- `--print-fresh-key` mode emits a new AES key on stdout (one line of hex) so you can save it to **[server/.env](server/.env)** before running the upload.
- Default mode does the full chain in order:
  1. Read **[/usr/lib/gnubg/gnubg.wd](/usr/lib/gnubg/gnubg.wd)**.
  2. Encrypt with `BASE_WEIGHTS_ENCRYPTION_KEY` from env.
  3. `put_blob` to 0G Storage (Phase 6's wrapper).
  4. Call `chain.set_base_weights_hash(rootHash)` on the deployed AgentRegistry.
  5. Verify the on-chain read matches the upload before exiting.
- Idempotent — running again replaces the on-chain hash.

ChainClient extensions (**[server/app/chain_client.py](server/app/chain_client.py)**):

- New embedded `_AGENT_REGISTRY_ABI` covering `baseWeightsHash`, `setBaseWeightsHash`, `agentCount`, `tier`, `dataHashes`, and the `BaseWeightsHashSet` event.
- Constructor now accepts an optional `agent_registry_address`; when set the client exposes:
  - `base_weights_hash()` — read the contract-level shared hash.
  - `set_base_weights_hash(new_hash)` — owner-only setter.
  - `agent_data_hashes(agent_id)` — returns `[base, overlay]` for an agent.
  - `agent_tier(agent_id)` — returns the immutable tier set at mint.
- `from_env()` reads `AGENT_REGISTRY_ADDRESS` if present.

Deploy script update (**[contracts/script/deploy.js](contracts/script/deploy.js)**):

- New `INITIAL_BASE_WEIGHTS_HASH` constant defaults to the 0G testnet blob hash produced by this phase's upload script (`0x989ba07766cc35aa0011cf3f764831d9d1a7e11495db78c310d764b4478409ad`).
- Override per-deploy via the `INITIAL_BASE_WEIGHTS_HASH` env var. Pass `0x` + 64 zeros on a fresh network and call `setBaseWeightsHash` later.
- Future deploys (e.g. a v2 redeploy) automatically inherit the pinned hash without a follow-up tx.

Env additions (**[server/.env.example](server/.env.example)**):

- `BASE_WEIGHTS_ENCRYPTION_KEY=` — 32 bytes hex; the AES-256 key for the weights blob. Anyone with this key can decrypt the blob from 0G Storage; treat it like the deployer key.

Live on 0G testnet:

- Encrypted weights blob (~408 KB envelope) at 0G Storage `rootHash` `0x989ba07766cc35aa0011cf3f764831d9d1a7e11495db78c310d764b4478409ad`.
- AgentRegistry.setBaseWeightsHash tx: https://chainscan-galileo.0g.ai/tx/0xa129ce4f8bc230cdc944a061c8902897c7877db6d15e0956f5dd418387936c7b
- Reading `dataHashes[0]` on agent #1 now returns the same hash, so the iNFT's claim ("this agent runs on real gnubg weights") is cryptographically verifiable end-to-end.

Tests:

- **[server/tests/test_phase8_weights.py](server/tests/test_phase8_weights.py)** (new) — 11 fast unit tests. No network — runs in ~70 ms. Covers:
  - AES-256-GCM round-trip on small payloads and on 400 KB realistic-size payloads.
  - Rejection of wrong key (GCM auth tag).
  - Rejection of tampered ciphertext.
  - Nonce uniqueness across calls — so the same plaintext doesn't produce the same blob, and you don't accidentally re-encrypt and clobber.
  - Envelope `to_bytes` / `from_bytes` round-trip.
  - Version byte (`0x01`) presence.
  - Rejection of unknown version bytes and truncated envelopes.
- **[server/tests/test_phase8_base_weights_integration.py](server/tests/test_phase8_base_weights_integration.py)** (new) — 2 live tests, skipped when env vars or the weights file aren't present:
  - `test_base_weights_hash_resolves_to_real_gnubg_weights` — read contract `baseWeightsHash` → `get_blob` from 0G Storage → decrypt → `assert plaintext == open("/usr/lib/gnubg/gnubg.wd").read()`.
  - `test_minted_agent_inherits_the_same_base_hash` — agent #1's `dataHashes[0]` should equal the contract-level `baseWeightsHash`. Confirms the shared-base model.
- 47 server tests pass total: Phase 0 ×7 + Phase 6 ×1 + Phase 7 ×28 + Phase 8 ×11 unit + Phase 8 ×2 live. 38 fast unit tests run in <2 s combined; the live tests run in ~10 s on testnet.
- Hardhat tests: 52/52 still green; no contract changes in this phase.

Also in this commit:

- **[scripts/bootstrap-network.sh](scripts/bootstrap-network.sh)** (new) — one-shot orchestrator for a fresh-network bootstrap. Runs in order:
  1. `pnpm contracts:test`
  2. `pnpm contracts:deploy` (writes **[contracts/deployments/0g-testnet.json](contracts/deployments/0g-testnet.json)**)
  3. Reads the freshly-deployed AgentRegistry/MatchRegistry addresses from that JSON, sets them as env overrides, and runs **[server/scripts/upload_base_weights.py](server/scripts/upload_base_weights.py)** so the encrypted weights blob is pinned to the new contract — works regardless of what's in **[server/.env](server/.env)**.
  4. `pnpm contracts:verify`
  5. Prints the new addresses for the user to copy into **[server/.env](server/.env)** and **[frontend/.env.local](frontend/.env.local)** (doesn't mutate user state).
  Pre-flight checks fail fast with readable errors if `BASE_WEIGHTS_ENCRYPTION_KEY` isn't set in **[server/.env](server/.env)** or `/usr/lib/gnubg/gnubg.wd` doesn't exist (with `apt install gnubg` / `brew install gnubg` hint). Solves the "default `INITIAL_BASE_WEIGHTS_HASH` ages out and points at a dead blob" failure mode for clean redeploys.
- **[server/scripts/upload_base_weights.py](server/scripts/upload_base_weights.py)** — improved missing-weights error message to point at `apt install gnubg` / `brew install gnubg` (gnubg's weights file ships only inside the gnubg package, no separate download URL exists).
- **[README.md](README.md)** — restructured "Mode A — testnet (real demo)" around the bootstrap script. The canonical fresh-network path is now `./scripts/bootstrap-network.sh`; sub-flows (redeploy contracts only, re-upload weights only, verify only) are documented as the breakdown for cases where you don't need the full bootstrap. Bootstrap section also explicitly mentions the gnubg install requirement (`apt install gnubg` / `brew install gnubg`) and explains there's no separate weights-file download URL — gnubg ships them inside its own package.
- Repo cleanup: removed six exploratory print-only scripts at the **server/** root (**[server/test_match_id.py](server/test_match_id.py)**, **[server/test_turn.py](server/test_turn.py)**, **[server/test_sim.py](server/test_sim.py)**, **[server/test_sim2.py](server/test_sim2.py)**, **[server/test_sim3.py](server/test_sim3.py)**, **[server/test_sim4.py](server/test_sim4.py)**). Same pattern as the Phase 7 root-level cleanup — they had no `assert`s, weren't collected by `pnpm server:test` (which scopes to **server/tests/**), and just confused the layout because their names looked like real tests at a glance.

### Phase 9: agent experience overlay — iNFTs that learn

Every agent iNFT carries `dataHashes[1]` — a 32-byte pointer to the agent's "experience overlay" on 0G Storage. Until now it was `bytes32(0)` (a placeholder set at mint). This phase populates it: after every match the server reads the agent's current overlay from 0G Storage, runs a damped-reinforcement update against the match's move history, uploads the new overlay, and calls `updateOverlayHash` on the iNFT to pin the new hash. `matchCount` and `experienceVersion` (the on-chain counters) bump together. Two iNFTs minted at the same `tier` with the same shared base weights now drift into measurably different playing styles as their match histories diverge — that drift is what makes the iNFT meaningful as an asset rather than a label.

Why this design (and what it isn't):

- **What it's learning:** which categories of behavior correlate with this specific agent's wins vs losses across its match history. After many matches the overlay carries a personalised lean — "this agent wins more often when it builds the 5-point and runs back checkers, so it prefers those shapes."
- **What it's NOT learning:** position evaluation (gnubg still does that — the network stays frozen), move legality, dice math, bear-off mechanics, opponent modeling, or anything requiring backprop. The overlay is a tendency tracker, not an RL policy.
- The category list is hand-coded (~20 entries spanning opening style, point-building, bear-off timing, risk profile, game-phase tendencies, and reserved cube actions). v2 may extend it; v1 freezes it.

New module (**[server/app/agent_overlay.py](server/app/agent_overlay.py)**):

- `CATEGORIES` — canonical tuple of category names. Stable: changes invalidate every existing 0G Storage blob. Adding categories at the end is safe; old blobs round-trip with new entries zero-filled.
- `Overlay` dataclass with `version`, `values: {category → [-1, 1]}`, `match_count`. Frozen, clipped at construction, validated against `CATEGORIES`.
- `Overlay.to_bytes()` / `Overlay.from_bytes()` — canonical UTF-8 JSON, sorted keys, deterministic. Same overlay → same Merkle root.
- `classify_move(move) → {category: score in [0, 1]}` — hand-coded heuristics. Reads gnubg's move string (`"8/5 6/5"`, `"24/22 13/9*"`), extracts `(source, dest, hit)` triples, and lights up categories like `build_5_point`, `runs_back_checker`, `hits_blot`, `bearoff_efficient`, `anchors_back`, `opening_split`. v1 doesn't need to be tactically correct; it needs to be deterministic and distinguish moves with different characters.
- `apply_overlay(candidates, overlay) → ranked` — re-ranks gnubg's candidate moves by `gnubg_equity + sum(v[c] * classifier_c(move))`. Picks `argmax(biased_score)`. With a zero overlay this is a no-op (the fresh-agent case picks gnubg's top move every time).
- `update_overlay(overlay, agent_moves, won, match_count) → new_overlay` — applies the post-match update rule:
  1. Compute per-category exposure across the agent's moves.
  2. Normalize so total signal is bounded (a 50-move match doesn't apply 50× more update than a 5-move match).
  3. Outcome signal = +1 win / -1 loss.
  4. Proposed delta = `LEARNING_RATE * outcome * exposure[c]`.
  5. Damping: `alpha = N / (N + match_count)`. Early matches move the overlay a lot; late matches barely shift it. Keeps the agent's learned identity stable instead of getting overwritten by one freak win at match 200.
  6. Clip to `[-1, 1]`. The overlay is a bias, not an unbounded score.

ChainClient extensions (**[server/app/chain_client.py](server/app/chain_client.py)**):

- New ABI entries: `updateOverlayHash`, `experienceVersion`, `matchCount` (per-agent), `OverlayUpdated` event.
- `update_overlay_hash(agent_id, new_overlay_hash) → tx_hash` — owner-only setter on AgentRegistry. Phase 18 will route this through a KeeperHub workflow; for v1 the server signs directly.
- `agent_match_count(id)` and `agent_experience_version(id)` — read-only views.

Server endpoint (**[server/app/main.py](server/app/main.py)**):

- `/games/{id}/finalize` was already calling `recordMatch` (Phase 7). It now also runs the overlay update for every agent in the match:
  1. Fetch the agent's current overlay from 0G Storage via `dataHashes[1]` (or default to zero overlay if the iNFT still has `bytes32(0)`).
  2. Call `update_overlay` with the match's move history and the win/loss flag.
  3. `put_blob` the new overlay envelope to 0G Storage.
  4. `chain.update_overlay_hash(agent_id, root_hash)` to pin it on-chain.
- Added `_fetch_overlay` and `_update_agent_overlay` helpers; they degrade gracefully if a blob is corrupted (fall back to zero overlay rather than blocking finalize).
- The `FinalizeResponse` now carries an `overlay_updates` list with one entry per agent (`{agent_id, won, overlay_root_hash, update_overlay_tx_hash, match_count}`). Empty for human-vs-human matches.

Runtime overlay biasing (`/agent-move` integration):

The overlay isn't just stored — every agent move now actually consults it. gnubg never knows about the overlay; the bias is applied **outside** gnubg by re-ranking its candidate list:

- **[server/app/gnubg_client.py](server/app/gnubg_client.py)** — new `get_candidate_moves(pos_id, match_id) → list[{"move", "equity"}]` parses the *full* numbered list from gnubg's `hint` output (the existing `get_agent_move` only regex-extracted the top line). Empty list = no legal moves (e.g. dance from the bar).
- **[server/app/main.py](server/app/main.py)** — `/agent-move` now:
  1. Calls `gnubg.get_candidate_moves`.
  2. If empty → falls back to `gnubg.get_agent_move` (auto-play, nothing to bias).
  3. Otherwise → loads the agent's overlay (lazy-cached per `game_id`, one 0G Storage fetch per game), runs `apply_overlay`, picks the biased-top move, submits it via `gnubg.submit_move`.
  4. Records the chosen move in `_move_history` as before.
- **[server/app/main.py](server/app/main.py)** also tracks per-game agent identity (`_game_agent_id`) so the overlay loader knows which iNFT to look up. `_game_overlays` is the per-game cache so agent play stays consistent within a game even if `/finalize` on a concurrent game updates the same agent's overlay on-chain.
- The cache returns a default zero overlay (vanilla gnubg play) for `agent_id == 0`, missing iNFT, missing AGENT_REGISTRY_ADDRESS, corrupted blob, or `dataHashes[1] == bytes32(0)`. A misconfigured chain client can never block play.

Tests:

- **[server/tests/test_phase9_overlay_schema.py](server/tests/test_phase9_overlay_schema.py)** (new) — 11 fast unit tests covering `CATEGORIES`, `Overlay.default()`, validation (rejects unknown / missing categories, non-negative match_count), serialization round-trip, determinism, valid-UTF8 JSON output, version-byte and malformed-JSON rejection, and value clipping at construction. ~70 ms.
- **[server/tests/test_phase9_overlay_update.py](server/tests/test_phase9_overlay_update.py)** (new) — 9 fast unit tests for the update rule:
  - Wins reinforce categories the agent leaned into; losses discourage them.
  - Categories with zero exposure are unchanged (so an unrelated bias doesn't drift).
  - `match_count` increments by exactly 1 per update.
  - Damping: early matches move overlay more than late matches.
  - Values stay clipped to `[-1, 1]` even after 500 consecutive wins.
  - Convergence: an agent that always plays the same way and wins settles on a stable overlay (200-match tail spread < 0.05).
  - Exposure normalization: a 50-move match doesn't apply 50× more update than a 5-move one.
  - Empty move list produces no value changes (but still increments match_count).
- **[server/tests/test_phase9_overlay_classify_apply.py](server/tests/test_phase9_overlay_classify_apply.py)** (new) — 13 fast unit tests:
  - `classify_move` returns a score for every category, deterministic, distinguishes structurally-different moves.
  - Specific classifier hits: `build_5_point` for `"8/5 6/5"`, `bearoff_efficient` for `"6/off 5/off"`, `runs_back_checker` for `"24/22 24/20"`, `hits_blot` for `"13/8* 6/4"`. Unrelated categories stay at 0.
  - `apply_overlay` keystone property: a zero overlay picks gnubg's top equity (vanilla-gnubg fallback), a negative `build_5_point` bias demotes 5-point moves, a positive `runs_back_checker` bias picks the running move even when gnubg ranks it third.
  - Two agents with different overlays pick different moves on the same candidate set — the iNFT-divergence keystone.
- **[server/tests/test_phase9_overlay_integration.py](server/tests/test_phase9_overlay_integration.py)** (new) — 2 live tests against 0G testnet (skipped without env):
  - `test_overlay_update_lands_on_chain_and_round_trips_through_0g_storage` — read agent #1's pre-state → run `update_overlay` → upload → call `update_overlay_hash` → assert `dataHashes[1]` equals the upload's rootHash, `dataHashes[0]` (base weights) is unchanged, `experienceVersion` bumped by 1, and the round-tripped overlay equals what we uploaded.
  - `test_two_consecutive_updates_produce_distinct_overlay_hashes` — two updates in a row produce different rootHashes; the iNFT's `dataHashes[1]` reflects the latest. This is the visible-history property: every match is a distinct `experienceVersion` with its own immutable archive.
- **[server/tests/test_phase9_agent_move_overlay.py](server/tests/test_phase9_agent_move_overlay.py)** (new) — 6 fast wiring tests confirming the overlay actually flows into the runtime `/agent-move` pick. gnubg is mocked so the tests stay deterministic:
  - `test_zero_overlay_picks_gnubg_top_equity_move` — fresh agent (no learned bias) plays vanilla gnubg.
  - `test_overlay_biased_for_back_checkers_picks_running_move` — heavy `runs_back_checker` bias promotes the running move past gnubg's top equity pick.
  - `test_two_agents_with_different_overlays_pick_different_moves` — same gnubg candidate set, two different overlays → two different submitted moves. The keystone iNFT-divergence property at the runtime layer.
  - `test_no_candidates_falls_back_to_get_agent_move` — empty candidate list (dance from the bar) auto-plays via the existing path; `submit_move` is never called.
  - `test_overlay_loaded_once_per_game` — subsequent moves reuse the cached overlay; no per-move 0G Storage fetch.
  - `test_create_game_records_agent_id` — `agent_id` from `NewGameRequest` is captured at game creation so the overlay loader knows which iNFT to look up.
- **[server/tests/test_phase7_move_tracking.py](server/tests/test_phase7_move_tracking.py)** (updated) — adds `mock_gnubg.get_candidate_moves.return_value = []` so the existing tests route through the auto-play fallback (which was the path they already exercised). No behavior change for those tests.
- 90/90 Phase 0/6/7/8/9 server tests pass; 39 fast unit tests run with no network in ~3 s combined; the 2 live tests run in ~65 s on testnet.
- Hardhat tests still green: 52/52, no contract changes in this phase.

Live on 0G testnet:

- Two `updateOverlayHash` txs landed during the integration test run, each bumping agent #1's `experienceVersion` and pinning a fresh overlay rootHash on `dataHashes[1]`. Reading the iNFT now returns a non-zero `dataHashes[1]` and a `matchCount` reflecting the integration runs.

### Phase 10: ENS subname registrar contract (PlayerSubnameRegistrar)

Players (and AI agents) get a subname under `chaingammon.eth` — `alice.chaingammon.eth`, `gnubg-classic.chaingammon.eth` — whose ENS-shaped text records carry their portable reputation: `elo`, `match_count`, `last_match_id`, `style_uri`, `archive_uri`. Phase 10 ships the contract that issues those subnames and stores those records.

Scope (honest): v1 is a **self-contained ENS-compatible registrar deployed on 0G testnet**, not wired into real ENS on Sepolia or Linea. We can't realistically own `chaingammon.eth` on a chain with a live ENS root inside the hackathon timeline. The contract's interface is ENS-shaped (namehash, text records, resolver semantics) so a v2 deployment can mirror to real ENS via a Durin-style L2 subname registrar without rewriting anything — the *contract* is portable, the *deployment target* is what changes.

New contract (**[contracts/src/PlayerSubnameRegistrar.sol](contracts/src/PlayerSubnameRegistrar.sol)**):

- `parentNode` (immutable) — ENS namehash of the parent name (`chaingammon.eth`). Pinned at construction.
- `subnameNode(label) → bytes32` — computes ENS-style namehash `keccak256(parentNode || keccak256(label))` so any ENS resolver can look subnames up by the same node.
- `mintSubname(label, subnameOwner)` — owner-only. Rejects empty labels, the zero address, and duplicate labels. Emits `SubnameMinted(label, label, node, subnameOwner)`. (Both the indexed and the readable `label` are emitted because indexed strings are stored as keccak hashes only.)
- `ownerOf(node) → address` — ENS-resolver shape; returns `address(0)` for missing nodes.
- `text(node, key) → string` — ENS-resolver shape; returns `""` for unset records.
- `setText(node, key, value)` — dual-auth:
  - The subname's owner can update their own profile.
  - The contract owner (the server) can update any record. This is what lets the server push ELO/match-count updates after every match.
  - Anyone else reverts with `NotAuthorized`.
- `subnameCount` — running counter for diagnostics.

Tests (**[contracts/test/phase10_PlayerSubnameRegistrar.test.js](contracts/test/phase10_PlayerSubnameRegistrar.test.js)**, new):

21 hardhat tests, all green. Coverage:

- **Constructor** — parent node and contract owner pinned correctly.
- **namehash helper** — `subnameNode("alice")` matches an off-chain ENS namehash computation; different labels produce different nodes.
- **`mintSubname`**:
  - Records the subname owner.
  - Emits `SubnameMinted` with the right args.
  - Rejects duplicate labels, empty labels, mint to zero address.
  - Owner-only.
  - Auto-increments `subnameCount`.
- **Text records**:
  - `text` returns `""` for unset keys.
  - `setText` stores and emits `TextRecordSet`.
  - Subname owner can update their own.
  - Contract owner can update any.
  - Strangers cannot.
  - Reverts on non-existent subname.
  - Multiple keys per subname coexist.
  - Overwriting replaces the value.
- **`ownerOf`** — returns `address(0)` for unminted subnames.

Deploy + verify integration:

- **[contracts/script/deploy.js](contracts/script/deploy.js)** — now also deploys `PlayerSubnameRegistrar(ENS_PARENT_NODE)` after the agent + match registries. `ENS_PARENT_NODE` defaults to the namehash of `chaingammon.eth` (computed in JS at deploy time); override via the `ENS_PARENT_NODE` env var if you've registered a different parent on a real-ENS chain. Constructor args recorded in `playerSubnameRegistrarConstructorArgs` in **[contracts/deployments/0g-testnet.json](contracts/deployments/0g-testnet.json)** for `verify.js` to replay.
- **[contracts/script/verify.js](contracts/script/verify.js)** — verifies the new registrar with the right `parentNode` arg.
- Smoke-tested against in-process Hardhat: all three contracts deploy, the registrar gets `parentNode` `0x543cb3ed47a1ed324d00f8245468ef208194cc298026553f9adc78fb17e41cec` (namehash of `chaingammon.eth`), and the deployments JSON round-trips through `verify.js` correctly.

Live deploy deliberately deferred:

The registrar is ready to go but isn't redeployed to 0G testnet in this commit. Running `pnpm contracts:deploy` would bump every contract address — including AgentRegistry — which would wipe agent #1's accumulated overlay state from Phase 9 (different contract, no history). The next time a fresh bootstrap is needed, **[scripts/bootstrap-network.sh](scripts/bootstrap-network.sh)** will deploy the full set including this registrar; until then the new contract lives only as code + tests.

73/73 hardhat tests pass (52 prior + 21 new). No server changes in this phase — Phase 11 wires the server up to call `mintSubname` and `setText`.

Also in this commit (carry-over working-tree changes that hadn't landed yet):

- **[ARCHITECTURE.md](ARCHITECTURE.md)** (new) — full architecture document with Mermaid diagrams covering the player → server → 0G Storage / 0G Chain / KeeperHub data flow.
- **[chaingammon.pptx](chaingammon.pptx)** + **[scripts/make_deck.py](scripts/make_deck.py)** (new) — submission slide deck and the Python script that generated it.
- **[.claude/settings.json](.claude/settings.json)** — enabled the `telegram` plugin from `claude-plugins-official` alongside the existing `superpowers` and `code-review` plugins.
- **[.gitignore](.gitignore)** — added `.~lock.*#` (LibreOffice editor lock files) so they stop appearing as untracked between commits.

## Phase 11: server-side ENS text record updates from /finalize

After every match, push reputation text records to each player's `<label>.chaingammon.eth` subname so any third-party tool reading their ENS profile sees the latest ELO and a pointer to the latest match. ENS (Ethereum Name Service) subnames are the standard portable-identity primitive; `PlayerSubnameRegistrar` (Phase 10) issues them under `chaingammon.eth`. This phase wires the server to call `setText` on that contract after every finalized match.

Deploy script (**[contracts/script/deploy_registrar.js](contracts/script/deploy_registrar.js)**, new):
- Deploys only `PlayerSubnameRegistrar` and merges its address into **[contracts/deployments/0g-testnet.json](contracts/deployments/0g-testnet.json)** without touching `MatchRegistry` or `AgentRegistry` addresses — redeploying `AgentRegistry` would wipe agent #1's accumulated overlay state from Phase 9.
- Same parent-node logic as `deploy.js`: namehash of `chaingammon.eth` by default; override via `ENS_PARENT_NODE`.

Server ENS client (**[server/app/ens_client.py](server/app/ens_client.py)**, new):
- `EnsClient` with embedded `PlayerSubnameRegistrar` ABI.
- `subname_node(label)` — pure client-side ENS namehash (`keccak256(parentNode || keccak256(label))`); `parent_node` read once at construction so per-label hashing needs no RPC.
- `set_text(node, key, value)` — owner-only write; signs and sends as `DEPLOYER_PRIVATE_KEY`.
- `mint_subname(label, owner)` — owner-only write; not auto-called from `/finalize` (frontend drives the mint flow), but exposed here so a single client owns all registrar writes.
- `text(node, key)`, `owner_of(node)` — view helpers used by the live integration test.
- `from_env()` factory keyed off `RPC_URL`, `PLAYER_SUBNAME_REGISTRAR_ADDRESS`, `DEPLOYER_PRIVATE_KEY`.

Wiring into /finalize (**[server/app/main.py](server/app/main.py)**, updated):
- `FinalizeRequest` gains optional `winner_label` and `loser_label`.
- After `recordMatch` + agent overlay updates, iterates each side; if a label is set, calls `set_text` for `elo` (read fresh from `MatchRegistry.humanElo` / `MatchRegistry.agentElo`) and `last_match_id` (the just-recorded matchId).
- ENS push failure is non-fatal — the match is already on-chain — and surfaces as an `error` entry in `FinalizeResponse.ens_updates`.
- v1 pushes `elo` and `last_match_id` only; `match_count` for human sides isn't trivially derivable on-chain and `style_uri`/`archive_uri` need per-player aggregator blobs not yet built — both deferred.

Env files (**[server/.env.example](server/.env.example)**, updated):
- Added `PLAYER_SUBNAME_REGISTRAR_ADDRESS=` (filled after `pnpm exec hardhat run script/deploy_registrar.js --network 0g-testnet`).

Tests (server/tests/):
- **[server/tests/test_phase11_ens_client.py](server/tests/test_phase11_ens_client.py)** (new, 10 tests):
  - `subname_node` matches the Solidity formula bit-for-bit (validated against an `eth_utils.keccak`-derived reference value).
  - `set_text` builds, signs, sends a tx; rejects unprefixed nodes; raises `EnsError` on revert.
  - `text` view delegates to the contract.
  - `from_env` raises on missing vars and on unreachable RPC; constructs successfully with mocked Web3.
- **[server/tests/test_phase11_ens_live.py](server/tests/test_phase11_ens_live.py)** (new, 1 test):
  - Round-trip against the live registrar: mint a random `test-<8-hex>` label, `set_text("elo", "1500")`, read back via `text(node, "elo")` and assert match. Random label keeps re-runs idempotent (the registrar reverts on `SubnameAlreadyExists`).
  - Skip condition: `PLAYER_SUBNAME_REGISTRAR_ADDRESS` not set.

101 server unit tests pass (91 prior + 10 new). The live integration test stays skipped until `PLAYER_SUBNAME_REGISTRAR_ADDRESS` is set.

Also in this commit (carry-over working-tree changes that hadn't landed yet):
- **[CONTEXT.md](CONTEXT.md)** (updated) — added "Structure" subsection to Commit Messages section with anatomy template, section-order rule, and file-path linking policy (bold-linked in log.md, bold-plain in commit messages).
- **[log.md](log.md)** (updated) — converted all bold file paths to relative markdown hyperlinks (`**[path](path)**`) so they are clickable in VS Code preview and on GitHub.
- **[plan.md](plan.md)** (updated) — KeeperHub redesign notes: two-phase commitment (`registerMatch` at game start + `settleMatch` at game end), four KeeperHub workflows, integrity argument.

## Phase 12: frontend wallet connect to 0G testnet

First real use of the wagmi scaffold: a user lands on `/`, sees "Connect wallet", clicks it, and gets their shortened address in the header. If they're on the wrong network, an amber "Switch to 0G testnet" pill appears and calls `switchChain` to request a network add via the injected provider. wagmi is the standard React hooks library for EVM wallets; 0G Galileo testnet (chainId `16602`) is the deployment target throughout this project.

Wagmi config (**[frontend/app/wagmi.ts](frontend/app/wagmi.ts)**, replaces empty stub):
- `defineChain` for 0G Galileo testnet — chainId `16602`, native currency `OG`, RPC from `NEXT_PUBLIC_OG_RPC_URL` with `https://evmrpc-testnet.0g.ai` fallback, explorer `https://chainscan-galileo.0g.ai`.
- `createConfig` with one connector (`injected({ shimDisconnect: true })`) and `http()` transport; `ssr: true` because the App Router pre-renders on the server.
- Module augmentation registers the config with `wagmi` so all hooks know our chain shape.

Providers (**[frontend/app/providers.tsx](frontend/app/providers.tsx)**, replaces empty stub):
- Client Component (`"use client"`); wraps the tree in `WagmiProvider` + `QueryClientProvider`.
- `QueryClient` created with `useState(() => new QueryClient())` so React keeps the same instance across renders (otherwise the cache resets every render, defeating react-query's purpose).

Layout + page:
- **[frontend/app/layout.tsx](frontend/app/layout.tsx)** (updated) — wraps `{children}` with `<Providers>`; renames metadata to "Chaingammon" with the project tagline.
- **[frontend/app/page.tsx](frontend/app/page.tsx)** (updated) — replaces boilerplate with a header (project title + `<ConnectButton />`) and a one-paragraph intro pointing at the ENS subname concept.

Connect button (**[frontend/app/ConnectButton.tsx](frontend/app/ConnectButton.tsx)**, new):
- Three states: no injected wallet → "Install MetaMask" link; wallet present, not connected → "Connect wallet" button (calls `connect({ connector })`); connected → shortened address (`0x1234…abcd`), chain-switch pill, Disconnect button.
- Hooks: `useAccount`, `useChainId`, `useConnect`, `useDisconnect`, `useSwitchChain` from wagmi.

Env files (**[frontend/.env.example](frontend/.env.example)**, updated):
- Added `NEXT_PUBLIC_OG_RPC_URL` and `NEXT_PUBLIC_PLAYER_SUBNAME_REGISTRAR_ADDRESS=0xf260aE6b2958623fC4e865433201050DC2Ed1ccC` (Phase 11 deploy).

Smoke test: `pnpm exec next build` passes (4 static routes). `curl http://localhost:3000/` returns 200 with `<title>Chaingammon</title>` and `<button>Connect wallet</button>` in the SSR-rendered DOM. Full wallet flow (MetaMask popup, signing) requires a browser — not automated.

Also in this commit (carry-over working-tree changes that hadn't landed yet):
- **[chaingammon.pptx](chaingammon.pptx)** + **[scripts/make_deck.py](scripts/make_deck.py)** (updated) — slide deck extended with ELO formula + betting mechanics slide, and three sponsor spotlight slides (ENS subname table, 0G Storage primitives, KeeperHub workflow pipeline).

## Phase 13 — frontend agents list + on-chain ELO display

Goal: the landing page now shows a live list of agents pulled from `AgentRegistry`. Each card shows the agent's metadata label (the string passed at `mintAgent` time, e.g. "gnubg-default-placeholder"), its ELO read from `MatchRegistry`, and a "Play" link to `/match?agentId=N`. This is the first place where the user *sees* on-chain state in the UI rather than just connecting a wallet.

Components:

- **frontend/app/AgentsList.tsx** (new) — Client Component (`"use client"`). Calls `useReadContract` for `AgentRegistry.agentCount()` (Phase 5; the per-mint counter), then renders one `<AgentCard>` per ID `1..count`. Shows "Loading agents…" while the read is in flight and "No agents registered yet." if `count === 0`. Separated from `page.tsx` so the page shell stays a server component and only this subtree hydrates on the client.
- **frontend/app/AgentCard.tsx** (replaces the empty stub from Phase 0) — Client Component; one batched `useReadContracts` call hits `agentMetadata(agentId)` on `AgentRegistry` + `agentElo(agentId)` on `MatchRegistry` so each card pays exactly one RPC. Falls back to `Agent #N` if `agentMetadata` is empty or longer than 80 chars (which would mean it's a URI rather than a short label). "Play" routes to `/match?agentId=N`, the route built in Phase 14.
- **frontend/app/page.tsx** — adds an "Available agents" section between the intro and the page footer; mounts `<AgentsList />`. The intro paragraph was tightened ("Every match settles on 0G Chain…") and now mentions the iNFT framing ("AI agents are ERC-7857 iNFTs — their skill persists on-chain").

Smoke test:

- `pnpm exec next build` — clean prod build, all routes prerender static (`/` is still static; the agents list hydrates client-side).
- Live: with the seed agent (#1 = `gnubg-default-placeholder`, tier 2) on 0G testnet, the card renders the metadata label + the live ELO from `MatchRegistry`.

## Phase 14 — frontend match flow

Goal: a user can pick an agent on the landing page and play a complete backgammon match in the browser. Frontend talks to the FastAPI server (gnubg subprocess wrapper) for all game logic; nothing on-chain in this phase — settlement is Phase 17 (KeeperHub).

Match page:

- **frontend/app/match/page.tsx** (new) — `/match?agentId=N` route. Client Component wrapped in a `<Suspense>` boundary (Next 16 requires it whenever `useSearchParams` is used inside a page, otherwise static prerendering bails at build time).
- State machine: starts a new game on mount via `POST /games {match_length: 3, agent_id}` (the seed agent from Phase 5 is `agentId=1`). After that, the human turn (`turn=0`) shows a "Roll dice" button until dice land, then a free-form move input; the agent turn (`turn=1`) auto-drives via `POST /games/:id/roll` (if no dice yet) followed by `POST /games/:id/agent-move` (Phase 9's overlay-biased pick).
- Auto-drive guard: a `useRef(false)` flag flips to `true` while the agent is mid-step and back to `false` afterwards, so React's StrictMode double-invocation in dev doesn't fire two parallel agent moves. A 400ms delay before each agent step makes the board flash visible.
- Match-end banner: shows winner, final score, and a *disabled* "Settle on-chain (coming Phase 17)" button as a placeholder for the KeeperHub workflow.
- Errors render inline; missing-server case shows a "make sure the game server is running at \<API\>" hint.

Visual board:

- **frontend/app/Board.tsx** (replaces empty stub) — Tailwind-only board (no SVG). Top row points `13..24` left-to-right; bottom row `12..1` left-to-right; vertical "BAR" cell in the middle of each row. Checkers shown as colored dots (blue = player 0 / human; red = player 1 / agent). When a point holds more than 5 checkers, the extras render as a `+N` text label so a stacked point never overflows the cell. Turn indicator above the board ("Your turn (blue)" / "Agent's turn (red)") and borne-off counts below.
- The point ordering matches gnubg's convention (player 0 enters at point 24, bears off at points 1..6); `flip` reverses dot growth direction so top-row checkers grow downward and bottom-row checkers grow upward, as in a physical board.

Dice:

- **frontend/app/DiceRoll.tsx** (replaces empty stub) — inline-SVG dice (one rounded square per die) with the standard 1-6 pip patterns; doubles render as two identical dice. Returns `null` if `dice` is empty / null so the same component stays in the layout across turns.

Notation:

- The frontend exposes gnubg's native move syntax to the user (`8/5 6/5` for two checker movements, `bar/N` to enter from the bar, `N/off` for bear-off). A small footnote on the move row documents this. Could move to a graphical move-picker in a later phase, but keeping notation explicit makes test reproduction easy.

API helper:

- A tiny `apiFetch` wraps `fetch(API + path, …)` and decodes the response as `GameState`. The `API` URL comes from `NEXT_PUBLIC_API_URL` (already in the env from Phase 0) with `http://localhost:8000` as a default.

Smoke test:

- `pnpm exec next build` — clean, all 5 routes (`/`, `/_not-found`, `/match`) prerender as static content; the match page is wholly client-rendered after hydration.
- End-to-end against the local server: roll → move → opponent auto-plays → repeat → game-over banner. Wallet not yet wired into the match (no signing happens here in v1; that arrives with Phase 17 settlement).

## Phase 15 — frontend ENS name resolution + display

Goal: a connected wallet gets a real identity in the header — `alice.chaingammon.eth (1547)` — instead of the raw shortened address. If the wallet hasn't claimed a name yet, an inline "Claim name" form lets the user mint one without leaving the page.

This is the first phase where the ENS framing actually shows up in the UI. The plumbing was in place since Phase 10 (registrar contract) and Phase 11 (server-side text records); now it surfaces to the user.

Server endpoint:

- **server/app/main.py** — `POST /subname/mint` (new). Body: `{label, owner_address}`. Calls `EnsClient.mint_subname` (Phase 11 client) which signs as `DEPLOYER_PRIVATE_KEY` (the registrar's `Ownable` owner). Returns `{label, node, tx_hash}`. The user never pays gas for the claim in v1; the server eats it. Empty / whitespace labels are rejected with HTTP 400; on-chain failure (e.g. `SubnameAlreadyExists`) bubbles back as HTTP 502 so the frontend can show the error inline.

Frontend contracts wiring:

- **frontend/app/contracts.ts** — adds `PLAYER_SUBNAME_REGISTRAR_ADDRESS` (read from `NEXT_PUBLIC_PLAYER_SUBNAME_REGISTRAR_ADDRESS`) and `PlayerSubnameRegistrarABI` (imported from the Hardhat artifact at `contracts/artifacts/src/PlayerSubnameRegistrar.sol/PlayerSubnameRegistrar.json`). All wagmi reads route through this single source of truth.

Address → label lookup:

- **frontend/app/useChaingammonName.ts** (new) — Client-side hook. The registrar doesn't have an on-chain reverse mapping (address → label) because that would double the storage cost per mint. Instead the hook walks the `SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner)` event log filtered by `subnameOwner = address`. The label sits in the unindexed event data, so it's readable straight off the log. If a wallet owns multiple subnames (shouldn't happen in v1 but possible), the most recent mint wins. Returns `{label, name, isLoading}` where `name = "<label>.chaingammon.eth"`.

Profile (ELO) lookup:

- **frontend/app/useChaingammonProfile.ts** (new) — uses wagmi's `useReadContract` twice: once for `parentNode()` (immutable, cached forever via `staleTime: Infinity`), once for `text(node, "elo")`. The namehash is computed locally with `keccak256(encodePacked(["bytes32","bytes32"], [parentNode, keccak256(label)]))` — no extra RPC call for `subnameNode(label)`. Returns `{elo, node, isLoading}`.

Badge component:

- **frontend/app/ProfileBadge.tsx** (new) — Client Component with three states:
  - Lookup in flight → shows the shortened address (`0xabcd…1234`) so the header isn't blank.
  - Subname found → `alice.chaingammon.eth (1547)`. The ELO comes from the registrar text record that Phase 11 writes after every match; if the player hasn't played yet, the parenthetical is omitted.
  - No subname → shortened address plus a "Claim name" pill. Clicking opens an inline `<label>.chaingammon.eth` text input. Submitting POSTs to `/subname/mint`. On success the page reloads so every consumer of `useChaingammonName` re-runs its log scan and picks up the new mint.

UI integration:

- **frontend/app/ConnectButton.tsx** — replaces the inline shortened-address span with `<ProfileBadge address={address} />`. The chain-switch nudge and Disconnect button are unchanged.
- **frontend/app/AgentCard.tsx** — strips the `ipfs://` (or any `<scheme>://`) prefix from `agentMetadata`, replaces `/` with `-`, and formats as `<cleanLabel>.chaingammon.eth` for visual parity with player names. For agent #1 (`ipfs://gnubg-default-placeholder`) this renders as `gnubg-default-placeholder.chaingammon.eth`. Falls back to `Agent #N` if the metadata is missing or too long (>60 chars) to be a clean label.

Smoke test:

- `pnpm exec next build` — clean build, all 5 routes (`/`, `/_not-found`, `/match`) prerender as static content; the badge and agents list hydrate client-side.
- `next dev` SSR DOM contains "Chaingammon", "Connect wallet", "Available agents", and "chaingammon.eth" — the agent card already shows the ENS-style name on first paint because the registrar parent node is reachable via the public RPC during SSR.
- Live mint flow needs a browser + wallet; not automated. Once a wallet claims a label, the header re-renders to show it after the page reloads.

## cleanup: External Player gnubg, dual-mode chain registry, Playwright + Alice/Bob invariants, frontend policies

A grab-bag of cleanup that landed on top of Phase 15. Three structural changes worth reading separately: the gnubg integration was rewritten because the old flow was silently auto-rolling and auto-playing past the single move we asked for; the frontend's chain wiring was collapsed into a single `chains.ts` registry that follows the wallet at runtime instead of an env-var-pinned chainId; and Playwright now gates frontend commits because Tailwind class drift is invisible to the build. Also folds in the match-replay route + 0G Storage archive viewer, and a forward-looking ROADMAP, both originally drafted as separate phases.

Match replay route (**[frontend/app/match/[matchId]/page.tsx](frontend/app/match/%5BmatchId%5D/page.tsx)**, new) + game-record endpoint (**[server/app/main.py](server/app/main.py)**, updated):

- Frontend can now replay any finalized match move-by-move. `/match/<matchId>` reads `MatchRegistry.getMatch(matchId)` via wagmi → `gameRecordHash` (the 0G Storage Merkle root pinned at finalize time, Phase 7), fetches the archive via react-query against `GET /game-records/<hash>`, and steps through the moves with a `<Board>` render per step.
- New `GET /game-records/{root_hash}` server endpoint fetches the 0G Storage blob by Merkle root, parses it as a `GameRecord` (Phase 7 schema), and decodes each `position_id_after` via the existing `decode_position_id` so the frontend can render `<Board>` without a gnubg subprocess.
- Coexists with `/match?agentId=N` (the live-play route from Phase 14) — Next 16 prefers the static `match/page.tsx` for `/match` exactly, the dynamic `[matchId]/page.tsx` for `/match/<id>`.
- First place the match archive becomes user-visible — until now the on-chain `gameRecordHash` was an opaque commitment.

ROADMAP and architecture pointers (**[ROADMAP.md](ROADMAP.md)**, new; **[README.md](README.md)**, updated):

- New `ROADMAP.md` with: a **Shipped (v1)** table (one row per capability cross-referenced to the phase that landed it and the file(s) it lives in); **Near-term (weeks)** — commit-reveal VRF, agent-vs-agent, KeeperHub-orchestrated settlement, the "Settle on-chain" button getting wired, match replay polish; **Medium-term (months)** — ZK move proofs, anti-cheat for agent swap-out, betting + doubling cube, ELO derivatives, `style_uri` aggregator, 0G Compute; **Long-term (year+)** — real-ENS chain migration, on-chain tournament protocol, cross-platform rating imports, gnubg PR certification; and a **Won't do** section pinning closed-source agents, mandatory subscriptions, and server-side rating manipulation knobs as out of scope.
- README's existing "Roadmap" section gets a one-line pointer to `ROADMAP.md` for the full version and `ARCHITECTURE.md` for the diagrams.


gnubg integration bugfix (**[server/app/gnubg_client.py](server/app/gnubg_client.py)**, **[server/app/main.py](server/app/main.py)**, **[server/app/game_state.py](server/app/game_state.py)**):

- Rewrote `gnubg_client` to use gnubg's deterministic External Player command set: every gnubg auto-behaviour is disabled at session start, both players are pinned as `human`, and structured `set output rawboard on` is parsed for the canonical board state. Without these guards, applying X's move silently auto-rolled and auto-played past the move, producing the user-visible "my pieces are in the wrong place after the agent moves" symptom.
- New `decode_board(position_id, match_id)` reads points + bars from gnubg's rawboard output. `position_id` is player-on-roll relative — it mirrors when fTurn flips — so passing `match_id` is mandatory to restore the correct fTurn before reading.
- Bar field indexing in the rawboard layout: `values[27]` = X bar (positive), `values[2]` = −O_bar (sign-flipped). Verified empirically by sweeping `set board simple <26 values>`.
- `_build_game_state` (**[server/app/main.py](server/app/main.py)**) now sources board state from `gnubg.decode_board` instead of pure-Python `decode_position_id` (the latter has bit-alignment edge cases on mid-game positions).
- `decode_match_id` inverts gnubg's bit-11 turn convention (gnubg: 0=O / 1=X) into our convention (0=human / 1=agent), and same for `player_on_roll`.
- `decode_position_id` keeps its `elif → if` fix (player 1's checkers were silently dropped at any board index where player 0 had checkers — the agent's red checkers wouldn't appear on the board). Still exported for tests.

Phase-1 game-flow invariant tests (**[server/tests/test_phase24_decode_position.py](server/tests/test_phase24_decode_position.py)**, **[server/tests/test_phase24_game_flow.py](server/tests/test_phase24_game_flow.py)**, new):

- `test_bob_pieces_do_not_change_while_alice_plays` and `test_alice_pieces_do_not_change_while_bob_plays` — during one player's turn, the other player's checker count at every point can only ever decrease (via a hit). Captures the wrong-place-pieces symptom in a per-point before/after diff.
- `test_turn_convention_matches_human_zero_agent_one` — drives one agent move from any starting state and asserts `state["turn"] == 1 - starting_turn`. Pins the gnubg-bit-11 inversion deterministically.
- `test_create_game_returns_initial_state_with_both_players_on_board` and `test_roll_then_move_advances_position_id` — small invariants that pin the elif fix and the no-op `/move` regression.
- `test_phase24_decode_position.py` — three unit tests pinning the opening position's expected layout.
- 20 sequential runs: 20/20 pass. Full server unit-test suite: 105/105 non-network tests pass.


Frontend chain registry (**[frontend/app/chains.ts](frontend/app/chains.ts)**, new):

- Single source of truth for `{chainId → {viem Chain, contract addresses}}` built from `CHAIN_DEFS` (display metadata) + deployment JSON imported from `contracts/deployments/<network>.json`. Adding a chain is two steps: deploy + edit `chains.ts`.
- `useActiveChain()` / `useActiveChainId()` hooks return the wallet's current chain entry. SSR / not-connected falls back to the first registry chain.
- **[frontend/app/contracts.ts](frontend/app/contracts.ts)** exposes `useChainContracts()` returning `{matchRegistry, agentRegistry, playerSubnameRegistrar}` for the active chain. Static address constants are gone.
- **[frontend/app/wagmi.ts](frontend/app/wagmi.ts)** builds `chains:` and `transports:` from the registry. The `injected` connector imports from `@wagmi/core` (not `wagmi/connectors`) to avoid the umbrella export's broken `tempo/Connectors.js`.
- `ConnectButton`, `AgentsList`, `AgentCard`, `match/[matchId]/page.tsx`, `useChaingammonName`, `useChaingammonProfile` all switched to the hook-based API and pin `chainId: useActiveChainId()` so reads go to the chain whose addresses they're using.
- **[frontend/.env.example](frontend/.env.example)** stripped of all `NEXT_PUBLIC_*_ADDRESS` and `NEXT_PUBLIC_CHAIN_ID` vars; only `NEXT_PUBLIC_API_URL` and the optional RPC override remain.

Webpack-only frontend (**[frontend/package.json](frontend/package.json)**, **[frontend/next.config.js](frontend/next.config.js)**, **[frontend/next.config.ts](frontend/next.config.ts)**):

- `dev`, `build`, `test` scripts pinned to `next … --webpack`. Reason: Turbopack froze the dev box under load.
- Deleted empty **frontend/postcss.config.js** (was shadowing `postcss.config.mjs` and crashing Webpack).
- `next.config.{js,ts}` set `turbopack.root` to silence the workspace-root warning.

Frontend Playwright suite (**[frontend/playwright.config.ts](frontend/playwright.config.ts)** + **frontend/tests/**, new):

- `dice-size.spec.ts` — renders `<DiceRoll>` on a deps-free fixture page and asserts each die's bounding box ≤ 32 px (catches the original `h-10 w-10` 40 px regression).
- `match-flow-methods.spec.ts` — drives the live-play page with mocked endpoints via `page.route()`, asserts every game endpoint is POSTed (catches a regression where `apiFetch` defaulted to GET when no body was provided, 405-ing the auto-drive's `/roll` and `/agent-move`).
- **[frontend/app/match/page.tsx](frontend/app/match/page.tsx)**'s `apiFetch` always POSTs now; body is optional and defaults to `JSON.stringify({})`.

CORS middleware (**[server/app/main.py](server/app/main.py)**):

- `CORSMiddleware(allow_origins=["*"], …)` at startup so the Next dev server (`:3000`) reaches FastAPI (`:8000`) cross-origin in dev. Production should restrict `allow_origins`.

Forfeit button (**[frontend/app/match/page.tsx](frontend/app/match/page.tsx)**):

- New `doForfeit` handler + small red-bordered "Forfeit match" button under the move/roll controls. POSTs `/games/<id>/resign` (Phase 1 endpoint, runs gnubg's `resign normal; accept`). `window.confirm` guards against accidental clicks.

Frontend policies (**[CONTEXT.md](CONTEXT.md)**, new section):

Three rules every change inside `frontend/` must follow, codified after each one came from a real broken state:

1. **Chain registry — never hardcode chains or addresses.** `chains.ts` is the single source of truth; no per-address env vars; reads pair with `chainId: useActiveChainId()`.
2. **Playwright is the visual-regression gate.** `pnpm --filter frontend test:e2e` runs before any `frontend/**` commit. Build + typecheck don't catch Tailwind class drift.
3. **Webpack only — no Turbopack.** Turbopack froze the dev machine; the `@wagmi/core` import workaround is part of this rule.

Also in this commit (carry-over working-tree changes that hadn't landed yet):

- **chaingammon.pptx** (updated) — submission slide deck refreshed.
- **contracts/deployments/localhost.json** (updated) — fresh Hardhat localhost deployment record from the latest `script/deploy.js` run.
- **web_readme.html** (updated) — one-line whitespace cleanup.
- **frontend/.gitignore** — adds `/test-results` and `/playwright-report` so Playwright run artifacts don't show up as untracked noise.

### Pivot — Gensyn AXL + two-sig settlement + LLM coach

pivot: drop FastAPI server + KeeperHub; adopt Gensyn AXL + two-sig settlement + LLM coach

This commit records the architectural pivot in **[docs/superpowers/specs/2026-04-28-decentralized-server-design.md](docs/superpowers/specs/2026-04-28-decentralized-server-design.md)** and the implementation plan in **[docs/superpowers/plans/2026-04-28-decentralized-server.md](docs/superpowers/plans/2026-04-28-decentralized-server.md)**. No code changes land here — implementation follows in Phases 17+.

Motivation: the centralized FastAPI server (gnubg subprocess, dice roller, game state relay) was a single point of failure. ELO and identity were already decentralized (ENS + 0G) but live gameplay was not.

Game server (**[server/](server/)**, to be removed in Phase 17): gnubg evaluation moves out of FastAPI entirely.

AXL agent nodes (**[agent/](agent/)**, incoming): Gensyn AXL (Agent eXchange Layer) — a P2P network node built on Yggdrasil — provides the encrypted communication mesh. Two FastAPI services run as AXL-registered agents: `gnubg_service.py` for move evaluation (wraps gnubg subprocess, reuses gnubg_client.py logic) and `coach_service.py` for LLM coaching hints (flan-t5-base inference on gnubg equity output + gnubg strategy docs from 0G Storage as RAG context). Any operator can run these nodes; the canonical gnubg agent's AXL public key is published as an ENS text record (`gnubg_axl_pubkey`) on chaingammon.eth for serverless discovery.

KeeperHub (to be removed): settlement moves to a permissionless two-ECDSA-signature flow. Both players sign `keccak256(winner, loser, winner, gameRecordHash)` off-chain; either submits both signatures to `MatchRegistry.recordMatch`. The contract verifies via `ecrecover`, updates ELO via EloMath, and calls `PlayerSubnameRegistrar.setTextBatch` for each player atomically — one transaction, no orchestrator.

WebRTC + 0G KV signaling (to be removed): all P2P communication (AI move requests, coach hints, H-vs-H relay) routes through AXL at `localhost:9002/a2a/<pubkey>/<service>/<endpoint>`.

Sponsor coverage after pivot:
- ENS: portable identity + ELO text records + AXL agent key discovery via `gnubg_axl_pubkey` text record
- 0G Chain: MatchRegistry (two-sig, permissionless), AgentRegistry, PlayerSubnameRegistrar (`setTextBatch` added)
- 0G Storage: game records, gnubg weights, gnubg strategy docs (coach RAG context)
- Gensyn AXL: encrypted P2P mesh — AI moves, LLM coach hints, H-vs-H game relay

Also in this commit:
- **[docs/superpowers/specs/2026-04-28-decentralized-server-design.md](docs/superpowers/specs/2026-04-28-decentralized-server-design.md)** (new) — full architectural spec
- **[docs/superpowers/plans/2026-04-28-decentralized-server.md](docs/superpowers/plans/2026-04-28-decentralized-server.md)** (new) — 10-task implementation plan

### Phase 17: AXL agent nodes — gnubg + coach services, match-flow endpoints, uv-managed

AXL (Gensyn Agent eXchange Layer) is a P2P encrypted mesh where nodes register named services; peers reach each other via a local AXL node at localhost:9002. Two FastAPI services replace the removed FastAPI server: `gnubg_service.py` evaluates positions, picks moves, and advances state on the browser's behalf; `coach_service.py` runs flan-t5-base inference to produce coaching hints. Both services register with a local AXL node and are reachable by the browser without a centralised relay. The Python project under `agent/` is `uv`-managed.

gnubg agent service (**[agent/gnubg_service.py](agent/gnubg_service.py)**, new):
- POST /move — sets match_id + board + dice in a fresh gnubg subprocess, calls `hint`, parses ranked candidates, returns best move + top-3 list
  - `set dice D1 D2` is required before `hint`; without it gnubg shows cube analysis instead of move candidates
  - Returns `{"move": None, "candidates": []}` on no legal moves
- POST /evaluate — same as /move but returns candidates without picking (used by coach_service to format the LLM prompt)
- POST /new — starts a new match (`new match N`) and returns the opening MatchState (full position + match-state decoded)
- POST /apply — applies a move with given dice; 422 with gnubg's error text on illegal input. The move string is sent literally (no `move` prefix, which gnubg interprets as "let the AI pick"). Sequence: `set matchid` / `set board` / `set dice` / `<move>` / `show board`
- POST /resign — human forfeit. gnubg's `resign normal` + `accept` makes the player on roll the WINNER of the offered point (counter-intuitive: the on-roll player offers the opponent a 1-point loss; opponent accepts), so the endpoint forces the agent to be on roll first via `set turn O` so the agent always wins on forfeit
- `_run_gnubg(commands)` spawns a hermetic gnubg subprocess with auto-behaviour disabled. **Merges stderr into stdout** (`subprocess.STDOUT`) so /apply's illegal-move detection works regardless of which stream gnubg used — gnubg writes "Illegal or unparsable move." to stderr
- `_snapshot(commands)` runs gnubg, appends `show board`, parses the output via `gnubg_state.snapshot_state` into the unified MatchState shape

gnubg state decoders (**[agent/gnubg_state.py](agent/gnubg_state.py)**, new):
- Pure bit-unpacking decoders ported from `server/app/game_state.py`: `decode_position_id` (24 signed checker counts + bar + off) and `decode_match_id` (turn / dice / score / cube / game-over). Same human=0 / agent=1 convention applied (gnubg's raw turn bit is 0=O / 1=X — we invert)
- `snapshot_state(stdout)` parses gnubg `show board` output into a `MatchStateDict` (the unified shape consumed by both the agent's HTTP responses and the frontend's TypeScript `MatchState`). Takes the LAST occurrence of each id since gnubg auto-prints the board on `set board` AND `show board`
- No FastAPI, no gnubg subprocess — easy to unit-test, called from `gnubg_service.py`'s `_snapshot` helper

LLM coach agent service (**[agent/coach_service.py](agent/coach_service.py)**, new):
- POST /hint — fetches gnubg strategy docs from 0G Storage via `docs_hash`, builds a flan-t5-base prompt (context + dice + moves), returns a 1-2 sentence coaching explanation
- `_load_model()` lazy-loads flan-t5-base (google/flan-t5-base, Apache-2.0) on first request; ~250 MB download, cached in ~/.cache/huggingface
- `_fetch_docs(hash)` falls back to a built-in brief when the hash is empty or 0G Storage is unreachable

AXL configuration (**[agent/axl-config.json](agent/axl-config.json)** + **[agent/start.sh](agent/start.sh)**, new):
- axl-config.json registers "gnubg" (port 8001) and "coach" (port 8002) as named services on the local AXL node
- start.sh starts both uvicorn servers via `uv run uvicorn` (so deps come from the agent's uv venv) then calls `axl start --config axl-config.json`

uv migration for the agent (**[agent/pyproject.toml](agent/pyproject.toml)** + **[agent/uv.lock](agent/uv.lock)**, new):
- Dependencies (anyio, fastapi, httpx, pytest, pytest-anyio, torch, transformers, uvicorn) ported from the original `requirements.txt`. `[tool.pytest.ini_options]` testpaths=`["tests"]` so `uv run pytest` finds the suite without arguments
- `agent/requirements.txt` removed; `pyproject.toml` is now the source of truth

gnubg docs upload script (**[scripts/upload_gnubg_docs.py](scripts/upload_gnubg_docs.py)**, new):
- One-time script: `cd server && uv run python ../scripts/upload_gnubg_docs.py`
- Loads `server/.env` via `python-dotenv` so OG_STORAGE_{RPC,INDEXER,PRIVATE_KEY} are visible without a manual `set -a; source` step
- Uploads a ~1 KB gnubg strategy reference (opening, equity, bear-off, cube) to 0G Storage via the server's existing `put_blob` helper
- Prints `GNUBG_DOCS_HASH=0x<hash>` for copying to agent/.env and frontend/.env.local

Tests (**[agent/tests/](agent/tests/)**):
- **[agent/tests/test_gnubg_service.py](agent/tests/test_gnubg_service.py)** (new, 6 tests):
  - /move returns candidates with move + equity for the opening position + dice [3,1]
  - /move with missing required field returns 422
  - /new returns sane initial state (24-element board, 30 checkers total, score [0,0], match_length 3)
  - /apply advances state for a legal opening move (position id changes, turn flips)
  - /apply returns 422 for an illegal move (e.g. moving from an empty point)
  - /resign ends the game with `winner=1` (agent always wins on human forfeit)
- **[agent/tests/test_gnubg_state.py](agent/tests/test_gnubg_state.py)** (new, 4 tests):
  - decode_position_id returns 24 signed counts + correct totals (15 checkers per side)
  - decode_match_id parses opening match length / score / game_over from a real `new match 3` fixture
  - snapshot_state extracts ids from gnubg-style stdout
  - snapshot_state raises ValueError when ids are missing
- **[agent/tests/test_coach_service.py](agent/tests/test_coach_service.py)** (new, 2 tests):
  - /hint returns non-empty string (mocks _load_model and _generate)
  - /hint with missing required field returns 422

12 agent tests pass (0 prior + 12 new).

### Phase 18: match page over AXL gnubg agent node (no central server)

Migrates the match page from the retired FastAPI server (port 8000) to the AXL `gnubg_service` agent node (port 8001, added in Phase 17). The browser now owns the entire game state — a single `MatchState` object held in React — and round-trips every move through `gnubg_service` for validation and state advancement. Dice are rolled in the browser via `crypto.getRandomValues`. This is sub-project A of the post-pivot match flow; coach narration (sub-project B) and two-sig on-chain settlement (sub-project C) remain out of scope.

dice helper (**[frontend/app/dice.ts](frontend/app/dice.ts)**, new):
- `rollDice(): [number, number]` — uniform 1..6 via `crypto.getRandomValues`. Single swap-out point for VRF / commit-reveal in v2.

Match page (**[frontend/app/match/page.tsx](frontend/app/match/page.tsx)**, rewritten):
- New `MatchState` type drops `game_id`, `cube`, `cube_owner` from the old `GameState`. Keys: `position_id`, `match_id`, `board`, `bar`, `off`, `turn`, `dice`, `score`, `match_length`, `game_over`, `winner` — matches `agent/gnubg_state.py:MatchStateDict` exactly so the JSON wire format is consumed without renaming.
- `gnubgPost` helper points at `NEXT_PUBLIC_GNUBG_URL` (default `http://localhost:8001`) and unwraps 422 `detail` strings into thrown `Error` messages.
- State machine: `/new` on mount → roll opening dice → human or agent loop → `/apply` (or `/move` + `/apply` for agent) → roll next dice → loop. Forfeit calls `/resign`.
- `withFreshDice(state)` helper centralises "post-move, roll for whichever side is now on roll" so the human/agent branches don't drift.
- Error UI now points the user at the `gnubg_service` URL instead of port 8000.

frontend/.env.example: added `NEXT_PUBLIC_GNUBG_URL=http://localhost:8001`. The legacy `NEXT_PUBLIC_API_URL` is retained as a comment for any pre-pivot tooling that still references it.

Tests (**[frontend/tests/match-flow-methods.spec.ts](frontend/tests/match-flow-methods.spec.ts)**, rewritten, 2 tests):
- Full game cascade `/new` → `/apply` (human) → `/move` → `/apply` (agent) → ... → `game_over=true` → "You win!" banner.
- Forfeit dialog: clicking the Forfeit button calls `/resign` and shows the "Agent wins." banner.

10 frontend Playwright tests pass.

Also in this commit:
- **[docs/superpowers/specs/2026-04-28-axl-match-flow-design.md](docs/superpowers/specs/2026-04-28-axl-match-flow-design.md)** (new) — design spec for sub-project A (this phase). Points at the `README.md` § "Match flow" section as the user-facing design source.
- **[docs/superpowers/plans/2026-04-28-axl-match-flow.md](docs/superpowers/plans/2026-04-28-axl-match-flow.md)** (new) — 10-task implementation plan executed for this phase.

Note: web_readme.html updates for this phase are pending.
