# Chaingammon — Build Log

Short per-phase summary. One paragraph or a few bullets per phase — like a commit message. Architectural rationale and detailed designs live in `plan.md` and `CONTEXT.md`; don't duplicate them here.

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

### Phase 3 onward — pending

(See `plan.md` for the incremental phase list.)
