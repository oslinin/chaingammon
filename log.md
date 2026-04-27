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

### Phase 7: archive each match to 0G Storage and record it on-chain

End-of-game now does three things in one server-side flow: it builds
a canonical match archive (a `GameRecord` envelope), uploads that
archive to 0G Storage to get back a 32-byte Merkle `rootHash` (the
content-addressed identifier 0G Storage uses for blobs), and calls
`recordMatch` on **contracts/src/MatchRegistry.sol** with that
`rootHash` as the `gameRecordHash` field. The on-chain match record is
now cryptographically tied to the off-chain archive: anyone can read
`MatchRegistry.getMatch(id).gameRecordHash` and pull the canonical
replay from 0G Storage.

New modules:

- **server/app/game_record.py** — defines:
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

- **server/app/chain_client.py** — `ChainClient`, a thin web3.py wrapper
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
    sync with **contracts/src/MatchRegistry.sol** when that contract
    changes.

Server endpoint:

- **server/app/main.py** — new `POST /games/{game_id}/finalize` that
  takes `{winner_agent_id, winner_human_address, loser_agent_id,
  loser_human_address}`, validates the game has ended, builds the
  GameRecord, calls `put_blob` (Phase 6's 0G Storage upload), then
  calls `chain.record_match` with the resulting root hash. Returns
  `{match_id, tx_hash, root_hash}`.

Move-history tracking:

- **server/app/main.py** also keeps a per-game `_move_history` dict.
  `POST /games/{game_id}/move` and `POST /games/{game_id}/agent-move`
  capture turn + dice *before* the gnubg call (since dice get cleared
  after a successful move) and append a `MoveEntry(turn, dice, move,
  position_id_after)` after the call returns. `/finalize` passes that
  list into `build_from_state` so the GameRecord uploaded to 0G
  Storage carries the full play sequence.
- **server/app/gnubg_client.py** — `get_agent_move` now surfaces
  `best_move` (the move string gnubg chose) on its return dict so
  the agent's checker actions are recordable. Auto-played positions
  return `best_move=None` and the server logs `"(auto-played)"`.
- Cube actions aren't tracked yet — `cube_actions` stays an empty
  list in v1 because the doubling-cube flow isn't wired through any
  endpoint yet. That's a separate scope item, not a Phase 7 gap.

Env additions (**server/.env.example**):

- `DEPLOYER_PRIVATE_KEY=` — server signs `recordMatch` as the contract
  owner. Mirror the value from **contracts/.env** locally; both
  files are gitignored.

Tests:

- **server/tests/test_phase7_game_record_schema.py** (new): 15 fast
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
- **server/tests/test_phase7_chain_client.py** (new): 9 fast unit
  tests for `ChainClient.record_match` and `from_env` with every
  web3 dependency mocked. Covers happy-path return values
  (matchId parsed from the MatchRecorded log, tx_hash gets a 0x
  prefix), arg pass-through to the contract, correct nonce/chainId
  on the built transaction, error paths (receipt reverted,
  MatchRecorded event missing, game_record_hash without 0x prefix),
  and `from_env` behaviour (missing env, unreachable RPC, full
  construction). No network — runs in ~650 ms.
- **server/tests/test_phase7_move_tracking.py** (new): 3 fast unit
  tests covering the runtime move-history wiring with `gnubg` and
  `_build_game_state` mocked. Asserts that `/games` initialises an
  empty history, that `/move` records a `MoveEntry` carrying
  pre-move turn/dice (since dice get cleared after the move), and
  that `/agent-move` records `gnubg`'s `best_move` string. No
  network — runs in ~1 s.
- **server/tests/test_phase7_game_record.py** (new): a live
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

- **README.md** — new "Match Archive on 0G Storage" section between
  "Agent Intelligence Model" and "Architecture". Explains *why* matches
  are archived off-chain (games are the substance, not just ELO),
  enumerates every field of the `GameRecord` envelope with what each
  carries, and walks through the on-chain ↔ off-chain link (build →
  upload → record on-chain with the resulting `rootHash`). Lands the
  punchline: anyone can resolve a match by id, read the on-chain
  `gameRecordHash`, and pull the canonical replay from 0G Storage —
  no login, no API key, no platform.
- Repo cleanup: removed the obsolete root-level test scripts
  **test_dance.py**, **test_pass.py**, **test_pos.py**, and
  **test_startup.py**. They were exploratory gnubg / startup
  one-shots from before the Phase 0 scaffold; they had been deleted
  from the working tree long ago but the deletions had never been
  staged. Deletions land with Phase 7 to clean up `git status`.
- **.claude/settings.json** — enabled the Anthropic-published
  `superpowers` and `code-review` plugins (`claude-plugins-official`)
  at project scope. `superpowers` ships brainstorming, subagent-driven
  development, systematic debugging, and red/green TDD cycle
  enforcement; `code-review` adds an inline reviewer pass. Adopting
  these from Phase 8 onward in place of the manually-maintained
  policies in CONTEXT.md.

### Phase 8: encrypt gnubg base weights and pin them on 0G Storage

Every agent iNFT carries `dataHashes[0]` — a 32-byte pointer to the encrypted gnubg neural-network weights file on 0G Storage. Until now it was `bytes32(0)` (a placeholder set at mint). This phase uploads the real weights file once, encrypted, and pins the resulting Merkle `rootHash` (the content-addressed identifier 0G Storage uses for blobs) on AgentRegistry via `setBaseWeightsHash`. Every existing and future agent's `dataHashes[0]` now resolves to the same shared blob.

What's "the real weights file"? gnubg ships a single neural-network weights file at **/usr/lib/gnubg/gnubg.wd** (~399 KB on Ubuntu). It's the *intelligence* the gnubg engine runs against; gnubg the binary is the *runtime*. We don't retrain it — see the README's Agent Intelligence Model section for why.

New encryption helper (**server/app/weights.py**):

- AES-256-GCM with a server-held key (`BASE_WEIGHTS_ENCRYPTION_KEY` env var, 32 bytes hex).
  - v2 will switch to per-owner hybrid encryption so each iNFT owner can decrypt independently.
  - v1 keeps a single key because every owner runs the same shared gnubg base.
- `encrypt_weights(plaintext, key) → EncryptedWeights` — fresh random 12-byte nonce per call (GCM mandates nonce uniqueness).
- `decrypt_weights(envelope, key) → bytes` — wraps `cryptography`'s `AESGCM.decrypt`, raises `WeightsCryptoError` on auth-tag failure.
- Envelope on-disk layout: `[version=0x01][nonce: 12 bytes][ciphertext+GCM tag]`. The version byte is reserved so v2 can change layout without breaking v1 readers.
- `EncryptedWeights.to_bytes()` / `from_bytes()` — what gets uploaded to 0G Storage; round-trips deterministically.
- `generate_key()` returns 32 random bytes; `load_key_from_env()` reads `BASE_WEIGHTS_ENCRYPTION_KEY` and decodes hex.

One-time upload script (**server/scripts/upload_base_weights.py**):

- `--print-fresh-key` mode emits a new AES key on stdout (one line of hex) so you can save it to **server/.env** before running the upload.
- Default mode does the full chain in order:
  1. Read **/usr/lib/gnubg/gnubg.wd**.
  2. Encrypt with `BASE_WEIGHTS_ENCRYPTION_KEY` from env.
  3. `put_blob` to 0G Storage (Phase 6's wrapper).
  4. Call `chain.set_base_weights_hash(rootHash)` on the deployed AgentRegistry.
  5. Verify the on-chain read matches the upload before exiting.
- Idempotent — running again replaces the on-chain hash.

ChainClient extensions (**server/app/chain_client.py**):

- New embedded `_AGENT_REGISTRY_ABI` covering `baseWeightsHash`, `setBaseWeightsHash`, `agentCount`, `tier`, `dataHashes`, and the `BaseWeightsHashSet` event.
- Constructor now accepts an optional `agent_registry_address`; when set the client exposes:
  - `base_weights_hash()` — read the contract-level shared hash.
  - `set_base_weights_hash(new_hash)` — owner-only setter.
  - `agent_data_hashes(agent_id)` — returns `[base, overlay]` for an agent.
  - `agent_tier(agent_id)` — returns the immutable tier set at mint.
- `from_env()` reads `AGENT_REGISTRY_ADDRESS` if present.

Deploy script update (**contracts/script/deploy.js**):

- New `INITIAL_BASE_WEIGHTS_HASH` constant defaults to the 0G testnet blob hash produced by this phase's upload script (`0x989ba07766cc35aa0011cf3f764831d9d1a7e11495db78c310d764b4478409ad`).
- Override per-deploy via the `INITIAL_BASE_WEIGHTS_HASH` env var. Pass `0x` + 64 zeros on a fresh network and call `setBaseWeightsHash` later.
- Future deploys (e.g. a v2 redeploy) automatically inherit the pinned hash without a follow-up tx.

Env additions (**server/.env.example**):

- `BASE_WEIGHTS_ENCRYPTION_KEY=` — 32 bytes hex; the AES-256 key for the weights blob. Anyone with this key can decrypt the blob from 0G Storage; treat it like the deployer key.

Live on 0G testnet:

- Encrypted weights blob (~408 KB envelope) at 0G Storage `rootHash` `0x989ba07766cc35aa0011cf3f764831d9d1a7e11495db78c310d764b4478409ad`.
- AgentRegistry.setBaseWeightsHash tx: https://chainscan-galileo.0g.ai/tx/0xa129ce4f8bc230cdc944a061c8902897c7877db6d15e0956f5dd418387936c7b
- Reading `dataHashes[0]` on agent #1 now returns the same hash, so the iNFT's claim ("this agent runs on real gnubg weights") is cryptographically verifiable end-to-end.

Tests:

- **server/tests/test_phase8_weights.py** (new) — 11 fast unit tests. No network — runs in ~70 ms. Covers:
  - AES-256-GCM round-trip on small payloads and on 400 KB realistic-size payloads.
  - Rejection of wrong key (GCM auth tag).
  - Rejection of tampered ciphertext.
  - Nonce uniqueness across calls — so the same plaintext doesn't produce the same blob, and you don't accidentally re-encrypt and clobber.
  - Envelope `to_bytes` / `from_bytes` round-trip.
  - Version byte (`0x01`) presence.
  - Rejection of unknown version bytes and truncated envelopes.
- **server/tests/test_phase8_base_weights_integration.py** (new) — 2 live tests, skipped when env vars or the weights file aren't present:
  - `test_base_weights_hash_resolves_to_real_gnubg_weights` — read contract `baseWeightsHash` → `get_blob` from 0G Storage → decrypt → `assert plaintext == open("/usr/lib/gnubg/gnubg.wd").read()`.
  - `test_minted_agent_inherits_the_same_base_hash` — agent #1's `dataHashes[0]` should equal the contract-level `baseWeightsHash`. Confirms the shared-base model.
- 47 server tests pass total: Phase 0 ×7 + Phase 6 ×1 + Phase 7 ×28 + Phase 8 ×11 unit + Phase 8 ×2 live. 38 fast unit tests run in <2 s combined; the live tests run in ~10 s on testnet.
- Hardhat tests: 52/52 still green; no contract changes in this phase.

Also in this commit:

- **scripts/bootstrap-network.sh** (new) — one-shot orchestrator for a fresh-network bootstrap. Runs in order:
  1. `pnpm contracts:test`
  2. `pnpm contracts:deploy` (writes **contracts/deployments/0g-testnet.json**)
  3. Reads the freshly-deployed AgentRegistry/MatchRegistry addresses from that JSON, sets them as env overrides, and runs **server/scripts/upload_base_weights.py** so the encrypted weights blob is pinned to the new contract — works regardless of what's in **server/.env**.
  4. `pnpm contracts:verify`
  5. Prints the new addresses for the user to copy into **server/.env** and **frontend/.env.local** (doesn't mutate user state).
  Pre-flight checks fail fast with readable errors if `BASE_WEIGHTS_ENCRYPTION_KEY` isn't set in **server/.env** or `/usr/lib/gnubg/gnubg.wd` doesn't exist (with `apt install gnubg` / `brew install gnubg` hint). Solves the "default `INITIAL_BASE_WEIGHTS_HASH` ages out and points at a dead blob" failure mode for clean redeploys.
- **server/scripts/upload_base_weights.py** — improved missing-weights error message to point at `apt install gnubg` / `brew install gnubg` (gnubg's weights file ships only inside the gnubg package, no separate download URL exists).
- **README.md** — restructured "Mode A — testnet (real demo)" around the bootstrap script. The canonical fresh-network path is now `./scripts/bootstrap-network.sh`; sub-flows (redeploy contracts only, re-upload weights only, verify only) are documented as the breakdown for cases where you don't need the full bootstrap. Bootstrap section also explicitly mentions the gnubg install requirement (`apt install gnubg` / `brew install gnubg`) and explains there's no separate weights-file download URL — gnubg ships them inside its own package.
- Repo cleanup: removed six exploratory print-only scripts at the **server/** root (**server/test_match_id.py**, **server/test_turn.py**, **server/test_sim.py**, **server/test_sim2.py**, **server/test_sim3.py**, **server/test_sim4.py**). Same pattern as the Phase 7 root-level cleanup — they had no `assert`s, weren't collected by `pnpm server:test` (which scopes to **server/tests/**), and just confused the layout because their names looked like real tests at a glance.

### Phase 9: agent experience overlay — iNFTs that learn

Every agent iNFT carries `dataHashes[1]` — a 32-byte pointer to the agent's "experience overlay" on 0G Storage. Until now it was `bytes32(0)` (a placeholder set at mint). This phase populates it: after every match the server reads the agent's current overlay from 0G Storage, runs a damped-reinforcement update against the match's move history, uploads the new overlay, and calls `updateOverlayHash` on the iNFT to pin the new hash. `matchCount` and `experienceVersion` (the on-chain counters) bump together. Two iNFTs minted at the same `tier` with the same shared base weights now drift into measurably different playing styles as their match histories diverge — that drift is what makes the iNFT meaningful as an asset rather than a label.

Why this design (and what it isn't):

- **What it's learning:** which categories of behavior correlate with this specific agent's wins vs losses across its match history. After many matches the overlay carries a personalised lean — "this agent wins more often when it builds the 5-point and runs back checkers, so it prefers those shapes."
- **What it's NOT learning:** position evaluation (gnubg still does that — the network stays frozen), move legality, dice math, bear-off mechanics, opponent modeling, or anything requiring backprop. The overlay is a tendency tracker, not an RL policy.
- The category list is hand-coded (~20 entries spanning opening style, point-building, bear-off timing, risk profile, game-phase tendencies, and reserved cube actions). v2 may extend it; v1 freezes it.

New module (**server/app/agent_overlay.py**):

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

ChainClient extensions (**server/app/chain_client.py**):

- New ABI entries: `updateOverlayHash`, `experienceVersion`, `matchCount` (per-agent), `OverlayUpdated` event.
- `update_overlay_hash(agent_id, new_overlay_hash) → tx_hash` — owner-only setter on AgentRegistry. Phase 18 will route this through a KeeperHub workflow; for v1 the server signs directly.
- `agent_match_count(id)` and `agent_experience_version(id)` — read-only views.

Server endpoint (**server/app/main.py**):

- `/games/{id}/finalize` was already calling `recordMatch` (Phase 7). It now also runs the overlay update for every agent in the match:
  1. Fetch the agent's current overlay from 0G Storage via `dataHashes[1]` (or default to zero overlay if the iNFT still has `bytes32(0)`).
  2. Call `update_overlay` with the match's move history and the win/loss flag.
  3. `put_blob` the new overlay envelope to 0G Storage.
  4. `chain.update_overlay_hash(agent_id, root_hash)` to pin it on-chain.
- Added `_fetch_overlay` and `_update_agent_overlay` helpers; they degrade gracefully if a blob is corrupted (fall back to zero overlay rather than blocking finalize).
- The `FinalizeResponse` now carries an `overlay_updates` list with one entry per agent (`{agent_id, won, overlay_root_hash, update_overlay_tx_hash, match_count}`). Empty for human-vs-human matches.

Runtime overlay biasing (`/agent-move` integration):

The overlay isn't just stored — every agent move now actually consults it. gnubg never knows about the overlay; the bias is applied **outside** gnubg by re-ranking its candidate list:

- **server/app/gnubg_client.py** — new `get_candidate_moves(pos_id, match_id) → list[{"move", "equity"}]` parses the *full* numbered list from gnubg's `hint` output (the existing `get_agent_move` only regex-extracted the top line). Empty list = no legal moves (e.g. dance from the bar).
- **server/app/main.py** — `/agent-move` now:
  1. Calls `gnubg.get_candidate_moves`.
  2. If empty → falls back to `gnubg.get_agent_move` (auto-play, nothing to bias).
  3. Otherwise → loads the agent's overlay (lazy-cached per `game_id`, one 0G Storage fetch per game), runs `apply_overlay`, picks the biased-top move, submits it via `gnubg.submit_move`.
  4. Records the chosen move in `_move_history` as before.
- **server/app/main.py** also tracks per-game agent identity (`_game_agent_id`) so the overlay loader knows which iNFT to look up. `_game_overlays` is the per-game cache so agent play stays consistent within a game even if `/finalize` on a concurrent game updates the same agent's overlay on-chain.
- The cache returns a default zero overlay (vanilla gnubg play) for `agent_id == 0`, missing iNFT, missing AGENT_REGISTRY_ADDRESS, corrupted blob, or `dataHashes[1] == bytes32(0)`. A misconfigured chain client can never block play.

Tests:

- **server/tests/test_phase9_overlay_schema.py** (new) — 11 fast unit tests covering `CATEGORIES`, `Overlay.default()`, validation (rejects unknown / missing categories, non-negative match_count), serialization round-trip, determinism, valid-UTF8 JSON output, version-byte and malformed-JSON rejection, and value clipping at construction. ~70 ms.
- **server/tests/test_phase9_overlay_update.py** (new) — 9 fast unit tests for the update rule:
  - Wins reinforce categories the agent leaned into; losses discourage them.
  - Categories with zero exposure are unchanged (so an unrelated bias doesn't drift).
  - `match_count` increments by exactly 1 per update.
  - Damping: early matches move overlay more than late matches.
  - Values stay clipped to `[-1, 1]` even after 500 consecutive wins.
  - Convergence: an agent that always plays the same way and wins settles on a stable overlay (200-match tail spread < 0.05).
  - Exposure normalization: a 50-move match doesn't apply 50× more update than a 5-move one.
  - Empty move list produces no value changes (but still increments match_count).
- **server/tests/test_phase9_overlay_classify_apply.py** (new) — 13 fast unit tests:
  - `classify_move` returns a score for every category, deterministic, distinguishes structurally-different moves.
  - Specific classifier hits: `build_5_point` for `"8/5 6/5"`, `bearoff_efficient` for `"6/off 5/off"`, `runs_back_checker` for `"24/22 24/20"`, `hits_blot` for `"13/8* 6/4"`. Unrelated categories stay at 0.
  - `apply_overlay` keystone property: a zero overlay picks gnubg's top equity (vanilla-gnubg fallback), a negative `build_5_point` bias demotes 5-point moves, a positive `runs_back_checker` bias picks the running move even when gnubg ranks it third.
  - Two agents with different overlays pick different moves on the same candidate set — the iNFT-divergence keystone.
- **server/tests/test_phase9_overlay_integration.py** (new) — 2 live tests against 0G testnet (skipped without env):
  - `test_overlay_update_lands_on_chain_and_round_trips_through_0g_storage` — read agent #1's pre-state → run `update_overlay` → upload → call `update_overlay_hash` → assert `dataHashes[1]` equals the upload's rootHash, `dataHashes[0]` (base weights) is unchanged, `experienceVersion` bumped by 1, and the round-tripped overlay equals what we uploaded.
  - `test_two_consecutive_updates_produce_distinct_overlay_hashes` — two updates in a row produce different rootHashes; the iNFT's `dataHashes[1]` reflects the latest. This is the visible-history property: every match is a distinct `experienceVersion` with its own immutable archive.
- **server/tests/test_phase9_agent_move_overlay.py** (new) — 6 fast wiring tests confirming the overlay actually flows into the runtime `/agent-move` pick. gnubg is mocked so the tests stay deterministic:
  - `test_zero_overlay_picks_gnubg_top_equity_move` — fresh agent (no learned bias) plays vanilla gnubg.
  - `test_overlay_biased_for_back_checkers_picks_running_move` — heavy `runs_back_checker` bias promotes the running move past gnubg's top equity pick.
  - `test_two_agents_with_different_overlays_pick_different_moves` — same gnubg candidate set, two different overlays → two different submitted moves. The keystone iNFT-divergence property at the runtime layer.
  - `test_no_candidates_falls_back_to_get_agent_move` — empty candidate list (dance from the bar) auto-plays via the existing path; `submit_move` is never called.
  - `test_overlay_loaded_once_per_game` — subsequent moves reuse the cached overlay; no per-move 0G Storage fetch.
  - `test_create_game_records_agent_id` — `agent_id` from `NewGameRequest` is captured at game creation so the overlay loader knows which iNFT to look up.
- **server/tests/test_phase7_move_tracking.py** (updated) — adds `mock_gnubg.get_candidate_moves.return_value = []` so the existing tests route through the auto-play fallback (which was the path they already exercised). No behavior change for those tests.
- 90/90 Phase 0/6/7/8/9 server tests pass; 39 fast unit tests run with no network in ~3 s combined; the 2 live tests run in ~65 s on testnet.
- Hardhat tests still green: 52/52, no contract changes in this phase.

Live on 0G testnet:

- Two `updateOverlayHash` txs landed during the integration test run, each bumping agent #1's `experienceVersion` and pinning a fresh overlay rootHash on `dataHashes[1]`. Reading the iNFT now returns a non-zero `dataHashes[1]` and a `matchCount` reflecting the integration runs.

### Phase 10 onward — pending
