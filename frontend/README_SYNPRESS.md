# Synpress Tests for Chaingammon

This directory contains a Playwright test powered by Synpress (`@synthetixio/synpress`) to accurately emulate Metamask wallet flows and interaction for Human-vs-Human gameplay.

## Goal of the tests
The spec `tests/human_vs_human_synpress.spec.ts` contains two full HvH end-to-end tests:

**Test 1 — matchmaking + gnubg oracle + auto-play to completion**
1. Connecting two players via mocked Metamask wallets.
2. Pairing them through an in-memory Nostr relay and a mock RTCPeerConnection bridged across two isolated browser contexts.
3. Verifying the backend gnubg `/evaluate` endpoint ranks legal moves and `/play_to_end` names a winner.
4. Auto-playing both sides (first legal move per turn, `window.__HVH_TEST_MODE`) until the game-over banner appears, asserting exactly one winner.

**Test 2 — model-move gameplay + resolution correctness**
1. Same matchmaking flow, but with `window.__HVH_MODEL_MOVES` set so each turn is played with the highest-equity candidate from the BackgammonNet ONNX evaluator (the model behind the in-game move advisor).
2. After game over, reads both peers' authoritative `MatchState` (`window.__HVH_GAME_STATE`, mirrored in testMode) and asserts the match resolved correctly and identically on both sides:
   - same winner, same final `position_id` (no desync), same score;
   - the winner reached `match_length` points and bore off all 15 checkers;
   - the model actually decided moves on both pages (`window.__HVH_MODEL_MOVE_COUNT > 0`);
   - the "You win!" / "Opponent wins" banner on each page matches that page's assigned side.

## Setting Up Your Local Environment

Since installing external dependencies into this sandbox is not permitted in the CI runner natively, you must execute these instructions locally to run the test:

### 1. Install Synpress
Run the following inside your `frontend/` directory to install Synpress into your dependencies.
```bash
pnpm add -D @synthetixio/synpress
```

### 2. Start Services
Ensure both the frontend and backend servers are running locally:
```bash
# Terminal 1: Start backend gnubg service
cd server && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# Terminal 2: Start frontend
cd frontend && pnpm dev --port 3000
```
Note: The test intercepts the RPC calls natively to mock the ENS response, so no Hardhat Sepolia fork is strictly required.

### 3. Run the Tests via Playwright
To run both Synpress Playwright tests locally, execute:
```bash
cd frontend
pnpm exec playwright test tests/human_vs_human_synpress.spec.ts --project=chromium --headed
```

To run only the model-move resolution test (does not require the gnubg backend):
```bash
cd frontend
pnpm exec playwright test tests/human_vs_human_synpress.spec.ts --project=chromium --grep "model moves"
```

Note: the frontend imports contract ABIs from `contracts/artifacts/**`, so run
`cd contracts && pnpm exec hardhat compile` once before starting the dev server.

### Sandboxed CI runners

`playwright.sandbox.config.ts` is a drop-in copy of the default config that
launches the pre-installed Chromium at `/opt/pw-browsers/chromium` instead of
downloading the browser build pinned by `@playwright/test` (browser downloads
are blocked in some sandboxes). Use it by adding
`--config playwright.sandbox.config.ts` to the commands above.

### Note on Execution via Gemini CLI
If you prefer, you can feed these commands to your local Gemini CLI environment to install Synpress, start the services, and spawn the chromium UI to run the Playwright browser context directly. Ensure your Gemini instance has graphical subsystem access (X11/Wayland) or XVFB to visualize the Playwright runner.
