# Changelog

All notable changes to Chaingammon are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). For
the per-phase verbatim commit log (with full architectural rationale), see
[log.md](log.md). For pending and post-hackathon work, see [ROADMAP.md](ROADMAP.md).

## [Unreleased]

### Added

- **`agent/sample_trainer.py`** — runnable end-to-end demo of the per-agent value-network training loop. Defines `BackgammonNet` (gnubg-init core + per-agent random extras head + scalar equity head); instantiates two networks that share the same gnubg-initialised core but have different random extras (the "same gnubg base, different personality" picture); runs self-play TD(λ) with eligibility traces; logs scalars (TD error, value estimates, eligibility-trace norm, gradient norm, win-rate vs the frozen opponent), parameter and gradient histograms, and the model graph to TensorBoard via `torch.utils.tensorboard.SummaryWriter`. Supports `--launch-tensorboard` to subprocess the dashboard, `--save-checkpoint` / `--load-checkpoint` for state-dict round-trips, and a tiny in-file `RaceEnv` so the demo runs anywhere without a backgammon engine. New tests in `agent/tests/test_sample_trainer.py` (11 cases) lock in the shared-core / divergent-extras invariants and the checkpoint round-trip.
- **`tensorboard>=2.16.0`** dependency added to `agent/pyproject.toml` for `SummaryWriter` + the dashboard binary.
- **`runs/`, `*.ckpt`, `*.pt`** added to `.gitignore` — TensorBoard event files and trainer checkpoints are per-run, large, and should not be tracked.

### Changed

- **README.md** — concise rewrite (863 → 408 lines) aligned with `chaingammon_plan.md`. Replaces the obsolete "shared frozen gnubg + per-agent overlay" framing with the per-agent trained-NN model: gnubg weights as starter init, TD(λ) self-play training, browser inference by default with 0G Compute (TEE-attested) for offline play. Re-targets settlement to Sepolia (KeeperHub-native) and adds drand as the dice VRF (each turn's roll is `keccak256(drand_round_digest, turn_index) mod 36`). Splits the protocol-roles table into sponsor protocols (0G, ENS, KeeperHub — the three Chaingammon targets at ETHGlobal Open Agents) and other infrastructure (Sepolia, drand). Drops the redundant Mission/Motivation/Advantages sections.
- **CONTEXT.md architecture diagram** mirrors the README's target architecture.
- **Removed all AXL / Gensyn AXL references** from code and documentation. AXL was described as the relay layer between the browser and the local agent services in earlier drafts but was never actually used (the browser hits `localhost:8001` / `:8002` directly). Deleted `agent/axl-config.json` and four stale plan/spec files under `docs/superpowers/`. Rewrote the `start.sh` startup script and the docstrings in `agent/{gnubg_service,coach_service,gnubg_state}.py`.

- **Phase 20 — 0G Compute coach with agent-bias awareness.** Replaces the local-only flan-t5-base coach with verifiable inference on 0G Compute (Qwen 2.5 7B Instruct) via a new `og-compute-bridge` Node CLI. Adds an `AgentProfile` abstraction (`agent/agent_profile.py`) that pulls each agent's experience overlay from 0G Storage and renders its top biases as a one-sentence prompt context — forward-compatible with the `learn` branch's PyTorch model. Coach panel now has a Paid · 0G / Free · Local toggle (persisted in `localStorage`); the server falls back from compute → local invisibly when 0G is unreachable, and surfaces the served backend in the hint card.
- **Phase 18 — match page over local gnubg agent process.** Browser holds match state; routes every move through `gnubg_service` (`/new`, `/apply`, `/move`, `/resign`) on `localhost:8001`; rolls dice client-side via `crypto.getRandomValues`. Removes the last dependency on the retired FastAPI server. (`frontend/app/match/page.tsx`, `frontend/app/dice.ts`)
- **Phase 17 — local agent processes** (`agent/gnubg_service.py`, `agent/coach_service.py`). gnubg service exposes `/move` / `/evaluate` plus the new `/new` / `/apply` / `/resign` endpoints over a unified `MatchState` shape. Coach service runs flan-t5-base for one-to-two-sentence move narrations. Python project is `uv`-managed.
- **Network dropdown in navbar.** Lets the user switch between 0G Galileo Testnet, Sepolia, and (in dev) Hardhat Localhost from the connect button area. Replaces the one-shot "Switch to X" amber nudge.
- **`/test-network-dropdown` fixture page** + Playwright spec covering dropdown variants.
- **`home-navbar.spec.ts`** — positive Playwright assertion that the home page renders one of the three connect-state UIs (catches a class of regressions where `ConnectButton` silently fails to render).
- **`allowedDevOrigins`** in `next.config.{js,ts}` so the dev server accepts cross-origin requests from LAN hostnames.
- **`scripts/upload_gnubg_docs.py`** — one-time uploader for the gnubg strategy doc consumed by `coach_service` as RAG context.

### Changed

- **Frontend match page** rewritten end-to-end for the post-pivot local-agent flow. New `MatchState` interface (drops `game_id`, `cube`, `cube_owner`); calls `NEXT_PUBLIC_GNUBG_URL` (default `http://localhost:8001`) instead of the retired FastAPI server.
- **`MatchRegistry.recordMatch`** records `winnerHuman` / `loserHuman` addresses with zero-address slots when an agent plays — same shape, kept compatible with the upcoming two-sig design.
- **Pivot (`7053a9fb`):** dropped the central FastAPI server and KeeperHub workflow in favor of local agent processes (gnubg + coach FastAPI services on `localhost`) and a two-sig (or future state-channel) on-chain settlement.

### Fixed

- **Sepolia default RPC.** Replaced dead `https://rpc.sepolia.org` (Cloudflare 522 / connection timeout) with `https://ethereum-sepolia.publicnode.com`. The `NEXT_PUBLIC_SEPOLIA_RPC_URL` env override is unchanged.
- **SSR/client hydration mismatch in `ConnectButton`.** Defers real render until after client `useEffect` flips a `mounted` flag, so the SSR (no `window.ethereum`) and post-hydration trees agree. Without this, React silently dropped the click handler.
- **Cross-origin LAN dev access.** Next 16 blocks `_next/*` resources from non-localhost origins by default; `allowedDevOrigins` in `next.config.*` whitelists LAN hostnames so JS bundles + HMR load correctly when accessing from another device.
- **`upload_gnubg_docs.py`** loads `server/.env` via `python-dotenv` automatically. Eliminates the "Missing env vars for 0G Storage" failure when running the script directly.

## [0.1.0] — pending

Tag at hackathon submission time.

---

## Phase ledger (pre-pivot)

For the chronological per-phase commit log spanning Phases 0–15 of the original
ETHGlobal build plan (gnubg wrapper → contracts → 0G Storage round-trip →
encrypted weights → agent overlay → ENS subnames → frontend match flow), see
[log.md](log.md). Each entry there is the verbatim commit message for that
phase. This changelog deliberately summarises rather than duplicates that
ledger.
