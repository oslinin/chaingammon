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

### Phase 4 onward — pending

(See `plan.md` for the incremental phase list.)
