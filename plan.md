# Chaingammon — ETHGlobal Open Agents Submission Plan

> **Read this first if you are an AI coding agent working on this repo.**
> This document is the build plan for the 0G track. Work through the phases in order.
> Stop and ask the human owner before deviating from scope.

---

## 1. Context

**Project:** Chaingammon — see `MISSION.md` for the full vision (web3 backgammon with on-chain ELO and AI agents as iNFTs).

**Hackathon:** ETHGlobal Open Agents (async).

- Live now: April 24 – May 6, 2026
- Submit via the ETHGlobal hacker dashboard
- Confirm exact submission deadline on the event page before final commit

**Track targeted:**

- **0G — Best Autonomous Agents, Swarms & iNFT Innovations** ($1,500 per slot, up to 5 winners)

**Time budget:** ~15 hours total over ~10 days. Evenings only. Scope discipline matters more than feature count.

**Builder profile:** Strong Python/Linux. Some Solidity (deployed templates). Comfortable with FastAPI, weak on React/wagmi.

---

## 2. Submission Thesis

> Chaingammon is a permissionless backgammon ecosystem where AI agents are sovereign assets — minted as iNFTs on 0G, with strategies stored on 0G Storage and ELO ratings on 0G Chain. This submission demonstrates the core primitive: a gnubg-powered agent iNFT that plays humans and earns on-chain reputation.

**The 3-minute demo video must show:**

1. Open web app, connect wallet
2. Pick "Agent #1" — show its iNFT, current ELO, link to 0G explorer
3. Play a quick game — agent's moves come from gnubg
4. Game ends, ELO updates on-chain — show the new value on block explorer
5. Architecture diagram, narrate roadmap (betting, ELO derivatives, agent-vs-agent)

If this loop works end-to-end, the submission is competitive.

---

## 3. Architecture

```
┌──────────────────────────┐
│  Frontend (Next.js)      │
│  - board UI              │
│  - wagmi wallet connect  │
│  - reads on-chain ELO    │
└──────────┬───────────────┘
           │ HTTPS / WSS
           ▼
┌──────────────────────────┐         ┌─────────────────────────┐
│  Game server (FastAPI)   │────────▶│  gnubg subprocess       │
│  - new game / make move  │         │  (external player iface)│
│  - server-side dice      │         └─────────────────────────┘
│  - submits final result  │
└──────────┬───────────────┘
           │ web3.py / ethers.js
           ▼
┌──────────────────────────┐         ┌─────────────────────────┐
│  0G Chain (testnet)      │         │  0G Storage             │
│  - AgentRegistry (iNFT)  │◀────────│  - agent metadata JSON  │
│  - MatchRegistry (ELO)   │         │                         │
└──────────────────────────┘         └─────────────────────────┘
```

**Out of scope (roadmap items):**

- Betting / prediction markets
- ELO derivative tokens
- Agent-vs-agent matches
- VRF / commit-reveal dice (server-side with honesty note is fine)
- Anti-cheat for human ratings

---

## 4. Repo Layout

```
chaingammon/
├── MISSION.md
├── HACKATHON_PLAN.md           (this file)
├── README.md                   (rewrite for submission)
├── ARCHITECTURE.md
├── ROADMAP.md
├── server/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py
│   │   ├── gnubg_client.py
│   │   ├── game_state.py
│   │   └── chain_client.py
│   └── tests/
├── contracts/
│   ├── src/
│   │   ├── AgentRegistry.sol
│   │   ├── MatchRegistry.sol
│   │   └── EloMath.sol
│   ├── script/
│   ├── test/
│   └── hardhat.config.js
├── frontend/
│   ├── package.json
│   ├── app/
│   │   ├── page.tsx
│   │   └── play/[agentId]/page.tsx
│   ├── components/
│   │   ├── Board.tsx
│   │   ├── DiceRoll.tsx
│   │   └── AgentCard.tsx
│   └── lib/
│       ├── wagmi.ts
│       └── contracts.ts
└── docs/
    └── demo-script.md
```

---

## 5. Build Phases

### Phase 0 — Scaffolding (1 hr)

**Goal:** Repo skeleton, dev environments working.

Tasks:

- Create directory structure
- Init `server/` (Python 3.11+, FastAPI, pydantic, web3, httpx, pytest)
- Init `contracts/` with Hardhat
- Init `frontend/` with Next.js + TypeScript + wagmi + viem
- `.env.example` files in each sub-project
- `.gitignore` covering Python, Node, Hardhat artifacts, `.env`

**Done when:** All three start without errors (`uv run uvicorn`, `npx hardhat compile`, `npm run dev`).

### Phase 1 — gnubg wrapper service (3 hrs)

**Goal:** FastAPI service exposing backgammon engine via gnubg's External Player interface.

Background: gnubg has a socket-based external player protocol. Spec: https://www.gnu.org/software/gnubg/manual/html_node/A-technical-description-of-the-External-Player-Interface.html

Tasks:

- Install gnubg (`sudo apt install gnubg`)
- `app/gnubg_client.py` — class managing gnubg subprocess. Methods: `new_match(length)`, `submit_move(board_state, dice, move)`, `get_agent_move(board_state, dice)`, `is_game_over()`, `winner()`
- `app/game_state.py` — typed GameState model (24-point board, bar, off notation matching gnubg)
- `app/main.py` — FastAPI endpoints:
  - `POST /games` — new game vs agent ID
  - `GET /games/{game_id}` — current state
  - `POST /games/{game_id}/roll` — server rolls dice
  - `POST /games/{game_id}/move` — human move
  - `POST /games/{game_id}/agent-move` — request agent response
  - `POST /games/{game_id}/resign` — concede
- In-memory game store (SQLite if time allows)
- Tests: one end-to-end happy path (2-point match to completion)

**Honesty note:** Server rolls dice, so server is trusted per match. Document clearly. Commit-reveal is v2.

**Done when:** pytest test plays full game, agent moves are legal.

### Phase 2 — Smart contracts (4 hrs)

**Goal:** Deploy AgentRegistry (iNFT) and MatchRegistry (ELO) to 0G testnet.

0G testnet:

- RPC: `https://evmrpc-testnet.0g.ai`
- Chain ID: `16602`
- Compile with `evmVersion: "cancun"`
- Faucet: https://build.0g.ai
- Docs: https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts

`AgentRegistry.sol`:

- ERC-721 (or ERC-7857 if reference impl is clean; otherwise fallback to 721 with note)
- `mintAgent(to, metadataURI) -> agentId`
- `agentMetadata(agentId) -> string`
- `agentElo(agentId) -> int256` (proxies to MatchRegistry)

`EloMath.sol`:

- Standard ELO formula (K=32, initial=1500)
- Fixed-point integers, no floats
- Unit-tested extensively (ELO bugs are embarrassing)

`MatchRegistry.sol`:

- `recordMatch(winnerAgentId, winnerHuman, loserAgentId, loserHuman, matchLength) -> matchId`
- Stores: timestamp, participants, winner, length
- Updates both participants' ELO
- Mappings: `agentElo(uint256)`, `humanElo(address)`, default 1500 for unseen
- Emits: `MatchRecorded(matchId, winner, loser, newWinnerElo, newLoserElo)`, `EloUpdated(participant, oldElo, newElo)`
- Permissioning: deployer only can call recordMatch (note trust model, decentralize in v2)

Tasks:

- Write contracts
- Hardhat tests: minting, recording match, ELO updates symmetric, multiple matches accumulate
- Deploy script minting seed agent "gnubg-default"
- Deploy to 0G testnet
- Save addresses to `contracts/deployments/0g-testnet.json` and `frontend/lib/contracts.ts`
- Verify on 0G block explorer (chainscan-galileo.0g.ai)

**Done when:** Hardhat tests pass, contracts deployed on 0G testnet, `recordMatch` works via script, ELO updates visible on explorer.

### Phase 3 — Frontend (4 hrs)

**Goal:** Web app to play against agent and see ELO update on-chain.

Tasks:

- Wagmi config for 0G testnet (custom chain via viem/chains defineChain)
- Landing page: list agents from AgentRegistry, show ELO, "Play" button
- Play page:
  - Board component (search npm for react-backgammon / bg-board; if none, simple SVG)
  - Call `POST /games` to start
  - Show turn, dice, legal moves
  - On game end: show result + "Submit on-chain" button → `recordMatch`
- Header: show connected wallet's human ELO from MatchRegistry
- Default Tailwind styling (form > fashion)

**Done when:** User connects wallet, plays full game, ELO updates on 0G testnet (visible via explorer).

### Phase 4 — 0G Storage integration (1 hr)

**Goal:** Agent metadata lives on 0G Storage.

Tasks:

- Read 0G Storage docs (https://docs.0g.ai, find Storage SDK)
- Create JSON: `{ "name": "gnubg-default", "engine": "gnubg", "skill_level": "world-class", "doubling_strategy": "..." }`
- Upload to 0G Storage, capture hash/URI
- Update deployed agent's metadataURI to point at 0G Storage
- Frontend fetches metadata at runtime

**Done when:** Agent card displays metadata from 0G Storage.

### Phase 5 — Demo + submission (1.5 hrs)

Tasks:

- Rewrite README: one-line pitch, demo video link, live URL, deployed addresses with explorer links, architecture diagram, track targeted, roadmap pointer, setup instructions
- Write ARCHITECTURE.md: component descriptions
- Write ROADMAP.md: v2 plans (betting, derivatives, agent-vs-agent, VRF, anti-cheat)
- Record demo video < 3 min (follow `docs/demo-script.md`)
- Deploy frontend (Vercel)
- Deploy backend (Oracle ARM box if ready, else fly.io / render)
- Submit on ETHGlobal dashboard
- Tag commit: `git tag submission-v1`

**Done when:** Submission accepted on dashboard.

---

## 6. Daily Cadence

15 hrs / 10 days = ~1.5 hrs/evening.

| Day | Phase                   | Hrs |
| --- | ----------------------- | --- |
| 1   | Phase 0 + start Phase 1 | 1.5 |
| 2   | Phase 1 finish          | 1.5 |
| 3   | Phase 2 write + test    | 1.5 |
| 4   | Phase 2 deploy + verify | 1.5 |
| 5   | Phase 3 board + flow    | 1.5 |
| 6   | Phase 3 wagmi + ELO     | 1.5 |
| 7   | Phase 4 0G Storage      | 1.5 |
| 8   | Buffer / catch-up       | 1.5 |
| 9   | Phase 5 docs + deploy   | 1.5 |
| 10  | Phase 5 demo + submit   | 1.5 |

If behind by Day 7: drop Phase 4 (use static IPFS pin instead of 0G Storage), keep iNFT angle intact.

---

## 7. Resources

**0G:**

- Builder hub: https://build.0g.ai
- Docs: https://docs.0g.ai
- Chain: https://docs.0g.ai/concepts/chain
- Deploy: https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts
- Testnet RPC: `https://evmrpc-testnet.0g.ai`, chain ID `16602`
- Explorer: https://chainscan-galileo.0g.ai
- Support: https://t.me/+mQmldXXVBGpkODU1
- Track: https://ethglobal.com/events/openagents/prizes/0g

**gnubg:**

- Project: https://savannah.gnu.org/projects/gnubg
- External interface: https://www.gnu.org/software/gnubg/manual/html_node/A-technical-description-of-the-External-Player-Interface.html
- Install: `sudo apt install gnubg`

**ERC-7857 (iNFT):**

- Search for latest spec. If reference impl not ready, use ERC-721 with rationale.

---

## 8. Submission Checklist

- [ ] Public GitHub repo
- [ ] README with pitch, demo link, live URL
- [ ] Demo video < 3 min
- [ ] Deployed contracts with explorer links
- [ ] Architecture diagram
- [ ] Team name + contact (Telegram + X)
- [ ] At least one working example agent (seed gnubg agent)
- [ ] iNFT minted on 0G (or ERC-721 with documented fallback)

---

## 9. Anti-Goals

- No features beyond this plan without asking
- Max 30 min per tooling issue — flag and workaround
- No over-engineering frontend (default Tailwind is correct)
- No betting, derivatives, or VRF in this submission
- No skipping EloMath.sol tests
- No secrets committed (use .env.example)
- No mainnet, 0G testnet only
