# Synpress Tests for Chaingammon

This directory contains a Playwright test powered by Synpress (`@synthetixio/synpress`) to accurately emulate Metamask wallet flows and interaction for Human-vs-Human gameplay.

## Goal of the test
The test `tests/human_vs_human_synpress.spec.ts` handles:
1. Connecting two players via Metamask.
2. Resolving their Primary ENS name via mocked RPC responses to verify that it's requested and shown instead of the `.chaingammon.eth` fallback.
3. Checking opponent ENS name resolution.
4. Verifying Turn Synchronization after moves are sent:
    - Specifically, exposing a desync bug where the Left Player mistakenly executes `rollMyDice` when the Right Player should be acting.
5. Emulating gameplay and verifying via cross-referencing `rules_engine.ts` with the local `gnubg_service` API that `rules_engine` miscalculates finished moves compared to the backend `gnubg` oracle.

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

### 3. Run the Test via Playwright
To run the Synpress Playwright test locally, execute:
```bash
cd frontend
pnpm exec playwright test tests/human_vs_human_synpress.spec.ts --project=chromium --headed
```

### Note on Execution via Gemini CLI
If you prefer, you can feed these commands to your local Gemini CLI environment to install Synpress, start the services, and spawn the chromium UI to run the Playwright browser context directly. Ensure your Gemini instance has graphical subsystem access (X11/Wayland) or XVFB to visualize the Playwright runner.
