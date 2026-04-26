# Chaingammon — Build Log

Progress log for the ETHGlobal Open Agents submission (0G track, deadline May 6 2026).
Updated after each phase lands. Append new entries at the bottom.

---

## Commits

| Date (ET) | Hash | Message | Author |
|---|---|---|---|
| 2026-04-26 00:30 | `43f9b6c7` | Add Chaingammon mission statement | Oleg Slinin |
| 2026-04-26 01:34 | `44d2362f` | Add hackathon implementation plan for ETHGlobal Open Agents (0G track) | Oleg Slinin |
| 2026-04-26 08:08 | `c7113d8f` | Phase 0: scaffold server, contracts, and frontend | Oleg Slinin |
| 2026-04-26 08:15 | `98cd0951` | Add CLAUDE.md, README, and project permission allowlist | Oleg Slinin |

---

## Phase Goals

### Phase 0 — Scaffolding
**Goal:** Repo skeleton, dev environments working.
**Done when:** All three start without errors (`uv run uvicorn`, `npx hardhat compile`, `npm run dev`).

Tasks:
- [x] Create directory structure
- [x] Init `server/` (Python 3.12, FastAPI, pydantic, web3, httpx, pytest)
- [x] Init `contracts/` with Hardhat 2, Solidity 0.8.24 cancun
- [x] Init `frontend/` with Next.js 16 + TypeScript + wagmi + viem
- [x] `.env.example` files in each sub-project
- [x] `.gitignore` covering Python, Node, Hardhat artifacts, `.env`

### Phase 1 — gnubg wrapper service
**Goal:** FastAPI service exposing backgammon engine via gnubg's External Player interface.
**Done when:** pytest test plays full game, agent moves are legal.

Tasks:
- [ ] Install gnubg (`sudo apt install gnubg`)
- [ ] `app/gnubg_client.py` — subprocess wrapper (new_match, submit_move, get_agent_move, is_game_over, winner)
- [ ] `app/game_state.py` — typed GameState model (24-point board, bar, off)
- [ ] `app/main.py` — FastAPI endpoints (POST /games, GET /games/{id}, roll, move, agent-move, resign)
- [ ] Tests: end-to-end happy path (2-point match to completion)

### Phase 2 — Smart contracts
**Goal:** Deploy AgentRegistry (iNFT) and MatchRegistry (ELO) to 0G testnet.
**Done when:** Hardhat tests pass, contracts deployed, `recordMatch` works, ELO visible on explorer.

Tasks:
- [ ] `EloMath.sol` — K=32, initial=1500, fixed-point, unit-tested
- [ ] `AgentRegistry.sol` — ERC-721 iNFT registry
- [ ] `MatchRegistry.sol` — records matches, updates ELO for agents and humans
- [ ] Deploy to 0G testnet, verify on chainscan-galileo.0g.ai
- [ ] Save addresses to `contracts/deployments/0g-testnet.json` and `frontend/app/contracts.ts`

### Phase 3 — Frontend
**Goal:** Web app to play against agent and see ELO update on-chain.
**Done when:** User connects wallet, plays full game, ELO updates on 0G testnet.

Tasks:
- [ ] wagmi config for 0G testnet (custom chain)
- [ ] Landing page: list agents from AgentRegistry, show ELO, "Play" button
- [ ] Play page: board component, dice, legal moves, "Submit on-chain" button
- [ ] Header: show connected wallet's human ELO

### Phase 4 — 0G Storage integration
**Goal:** Agent metadata lives on 0G Storage.
**Done when:** Agent card displays metadata fetched from 0G Storage.

Tasks:
- [ ] Upload agent metadata JSON to 0G Storage
- [ ] Update deployed agent's metadataURI to 0G Storage hash
- [ ] Frontend fetches metadata at runtime

### Phase 5 — Demo + submission
**Goal:** Ship.
**Done when:** Submission accepted on ETHGlobal dashboard.

Tasks:
- [ ] Rewrite README with demo link, live URL, deployed addresses, architecture diagram
- [ ] Write ARCHITECTURE.md and ROADMAP.md
- [ ] Record demo video < 3 min
- [ ] Deploy frontend (Vercel) and backend (fly.io / render)
- [ ] Submit on ETHGlobal dashboard
- [ ] `git tag submission-v1`

---

## Test Results

### Phase 0 — 2026-04-26

**Commit:** `c7113d8f` + `98cd0951`

#### server/ — pytest (25 tests)

```
tests/test_phase0_scaffold.py::test_fastapi_importable PASSED
tests/test_phase0_scaffold.py::test_pydantic_importable PASSED
tests/test_phase0_scaffold.py::test_web3_importable PASSED
tests/test_phase0_scaffold.py::test_httpx_importable PASSED
tests/test_phase0_scaffold.py::test_uvicorn_importable PASSED
tests/test_phase0_scaffold.py::test_python_version PASSED
tests/test_phase0_scaffold.py::test_server_app_dir_exists PASSED
tests/test_phase0_scaffold.py::test_server_tests_dir_exists PASSED
tests/test_phase0_scaffold.py::test_contracts_src_dir_exists PASSED
tests/test_phase0_scaffold.py::test_contracts_test_dir_exists PASSED
tests/test_phase0_scaffold.py::test_frontend_app_dir_exists PASSED
tests/test_phase0_scaffold.py::test_server_pyproject_exists PASSED
tests/test_phase0_scaffold.py::test_contracts_hardhat_config_exists PASSED
tests/test_phase0_scaffold.py::test_frontend_package_json_exists PASSED
tests/test_phase0_scaffold.py::test_server_env_example_exists PASSED
tests/test_phase0_scaffold.py::test_contracts_env_example_exists PASSED
tests/test_phase0_scaffold.py::test_frontend_env_example_exists PASSED
tests/test_phase0_scaffold.py::test_server_env_example_has_rpc_url PASSED
tests/test_phase0_scaffold.py::test_server_env_example_has_chain_id PASSED
tests/test_phase0_scaffold.py::test_contracts_env_example_has_deployer_key PASSED
tests/test_phase0_scaffold.py::test_frontend_env_example_has_api_url PASSED
tests/test_phase0_scaffold.py::test_hardhat_compiles PASSED
tests/test_phase0_scaffold.py::test_frontend_declares_wagmi PASSED
tests/test_phase0_scaffold.py::test_frontend_declares_viem PASSED
tests/test_phase0_scaffold.py::test_frontend_declares_next PASSED

25 passed, 1 warning in 2.26s
```

#### contracts/ — Hardhat/Mocha (12 tests)

```
Phase 0 — Scaffold
  hardhat config
    ✔ targets Solidity 0.8.24
    ✔ uses evmVersion cancun
    ✔ has optimizer enabled
    ✔ declares 0g-testnet network
    ✔ 0g-testnet has correct chainId
  directory structure
    ✔ src/ exists
    ✔ test/ exists
    ✔ script/ exists
  .env.example
    ✔ exists
    ✔ contains DEPLOYER_PRIVATE_KEY
    ✔ contains RPC_URL
  compilation
    ✔ compiles with no errors

12 passing (22ms)
```

**Total: 37 passed, 0 failed.**
