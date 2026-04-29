# Changelog

All notable changes to Chaingammon are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). For
the per-phase verbatim commit log (with full architectural rationale), see
[log.md](log.md). For pending and post-hackathon work, see [ROADMAP.md](ROADMAP.md).

## [Unreleased]

### Added

- **Phase 18 — match page over AXL gnubg agent node.** Browser holds match state; routes every move through `gnubg_service` (`/new`, `/apply`, `/move`, `/resign`); rolls dice client-side via `crypto.getRandomValues`. Removes the last dependency on the retired FastAPI server. (`frontend/app/match/page.tsx`, `frontend/app/dice.ts`)
- **Phase 17 — AXL agent nodes** (`agent/gnubg_service.py`, `agent/coach_service.py`). gnubg service exposes `/move` / `/evaluate` plus the new `/new` / `/apply` / `/resign` endpoints over a unified `MatchState` shape. Coach service runs flan-t5-base for one-to-two-sentence move narrations. Python project is `uv`-managed.
- **Network dropdown in navbar.** Lets the user switch between 0G Galileo Testnet, Sepolia, and (in dev) Hardhat Localhost from the connect button area. Replaces the one-shot "Switch to X" amber nudge.
- **`/test-network-dropdown` fixture page** + Playwright spec covering dropdown variants.
- **`home-navbar.spec.ts`** — positive Playwright assertion that the home page renders one of the three connect-state UIs (catches a class of regressions where `ConnectButton` silently fails to render).
- **`allowedDevOrigins`** in `next.config.{js,ts}` so the dev server accepts cross-origin requests from LAN hostnames.
- **`scripts/upload_gnubg_docs.py`** — one-time uploader for the gnubg strategy doc consumed by `coach_service` as RAG context.

### Changed

- **Frontend match page** rewritten end-to-end for the post-pivot AXL flow. New `MatchState` interface (drops `game_id`, `cube`, `cube_owner`); calls `NEXT_PUBLIC_GNUBG_URL` (default `http://localhost:8001`) instead of the retired FastAPI server.
- **`MatchRegistry.recordMatch`** records `winnerHuman` / `loserHuman` addresses with zero-address slots when an agent plays — same shape, kept compatible with the upcoming two-sig design.
- **Pivot (`7053a9fb`):** dropped the central FastAPI server and KeeperHub workflow in favor of local AXL agent nodes and a two-sig (or future state-channel) on-chain settlement.

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
