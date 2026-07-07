# Incremental Hardening & Agent-Vision Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is sized for a Sonnet-class worker: every task is self-contained, has explicit verify commands, and never requires inventing architecture — when a step says "mirror X", read X first and copy its pattern.

**Goal:** Close the highest-leverage gaps found in the July 2026 project audit, one independently shippable task at a time: (1) tests actually run in CI, (2) matchmaking infrastructure is configurable and hardened (relays, TURN, dice-roll validation, ELO verification), (3) the competitive trainers train on real backgammon instead of the toy race environment, (4) every trained agent is benchmarked against the gnubg baseline, and (5) agents condition on their opponent's style at inference, not only in training.

**Architecture:** No new subsystems. Each task extends an existing module along its established seams: env-var indirection for the relay/ICE lists in `frontend/lib/nostr.ts` / `frontend/lib/webrtc_match.ts`; a pure validation helper in `frontend/lib/drand_dice.ts` consumed by `PlayHumanClient`; the existing `state_factory` parameter of `td_lambda_match` threaded through the three competitive trainers; a new benchmark CLI that reuses `OnnxBoardState`; a `set_style` message added to the existing ONNX worker protocol.

**Tech Stack:** Next.js 16 (webpack only — see `frontend/AGENTS.md`), React 19, wagmi v3, viem v2, TypeScript, Playwright; Python 3.12 via `uv` (PyTorch, FastAPI); Hardhat + Solidity 0.8.24; GitHub Actions.

**Audit reference:** the findings behind each task are in the July 2026 audit conversation; the numbers cited per task (file:line) were verified against the tree at commit `7519bd5`.

**Project rules to obey (every task):**
1. **No commits without owner approval.** This plan contains NO `git commit` steps. Each task ends with "show the owner the diff"; the final task drafts a commit message and stops.
2. **Use `pnpm`, never `npm`/`npx`.** Python runs through `uv run` from the relevant package dir.
3. **Webpack only.** Never run `next dev`/`next build` without the existing pnpm scripts (they pass `--webpack`).
4. **Playwright is the frontend gate.** Any change under `frontend/` must end with the affected specs green. In sandboxes where Playwright cannot download browsers, append `--config playwright.sandbox.config.ts` (pre-installed Chromium) to every `playwright test` command.
5. **README is the user's manual.** Every task ends with a README update so the owner always knows how to install and test what just landed. Follow the exact "README step" in each task — do not skip it, do not batch READMEs across tasks.
6. **CHANGELOG.md** gets one entry per task under `## [Unreleased]` (`### Added` / `### Fixed` / `### Changed` as appropriate), in the file's existing style.
7. **Contract artifacts:** the frontend imports ABIs from `contracts/artifacts/**`. If typecheck fails with "Cannot find module '../../contracts/artifacts/…'", run `cd contracts && pnpm exec hardhat compile` first (needs network access to download solc; in restricted sandboxes see `frontend/README_SYNPRESS.md` for the solc-js fallback).
8. **Known pre-existing failure:** `frontend/tests/debug-privy-modal.spec.ts` has two `tsc` errors (`innerText` on `Element`). Task 1 fixes them; until then, filter them out when judging "tsc green".

---

## Task order and independence

Tasks are ordered so each can ship alone. Do them in order; if a task blocks, skip it and continue — no later task depends on an earlier one except Task 6 (benchmark) which reuses the `--board` flag from Task 5.

| # | Task | Risk | Touches |
|---|------|------|---------|
| 1 | CI: run tests on every PR | low | `.github/workflows/`, one test file, README |
| 2 | Env-configurable Nostr relays + ICE/TURN | low | `frontend/lib/nostr.ts`, `webrtc_match.ts`, README |
| 3 | Reject ground dice rolls (drand freshness + turn monotonicity) | medium | `frontend/lib/drand_dice.ts`, `PlayHumanClient.tsx`, tests |
| 4 | Verify claimed ELO against chain at pairing | medium | `frontend/app/page.tsx`, helper + tests |
| 5 | Competitive trainers on the full board | medium | `agent/*_trainer.py`, tests |
| 6 | Benchmark every agent vs the gnubg baseline | low | new `agent/benchmark_vs_gnubg.py`, README |
| 7 | Opponent style at inference | medium | `onnx_worker.ts`, `onnx_eval.ts`, `team-demo`, tests |
| 8 | Final verification + handoff | low | README test matrix |

---

## Task 1: CI — run the existing test suites on every PR

**Why:** the repo has ~68 Python test files, ~20 Hardhat suites, and ~19 Playwright specs, but `.github/workflows/` contains only Pages deploy and Claude bots. Nothing gates a PR.

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `frontend/tests/debug-privy-modal.spec.ts` (fix 2 pre-existing tsc errors)
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Fix the pre-existing tsc errors.** In `frontend/tests/debug-privy-modal.spec.ts` lines ~72 and ~83, `innerText` is accessed on `Element`. Cast inside the `page.evaluate` callback: `(el as HTMLElement).innerText`. Verify: `cd frontend && pnpm exec tsc --noEmit` → zero errors (compile contracts first per plan rule 7 if artifact imports fail).

- [ ] **Step 2: Create `.github/workflows/ci.yml`** with four jobs, all `runs-on: ubuntu-latest`, triggered on `pull_request` and `push: branches: [master]`:
  - **contracts**: checkout → `pnpm/action-setup@v4` → node 22 with pnpm cache → `pnpm install --frozen-lockfile` (repo root) → `cd contracts && pnpm exec hardhat compile && pnpm exec hardhat test`.
  - **frontend**: checkout → pnpm + node 22 → `pnpm install --frozen-lockfile` → `cd contracts && pnpm exec hardhat compile` (artifacts for tsc) → `cd frontend && pnpm exec tsc --noEmit` → `pnpm exec playwright install --with-deps chromium` → `pnpm exec playwright test tests/rules_engine.spec.ts tests/move_dedup.spec.ts --project=chromium --retries=0` (fast logic specs only — the HvH E2E suite is too slow/flaky for PR gating; do NOT add it here).
  - **agent-tests**: checkout → `astral-sh/setup-uv@v5` with cache → `cd agent && uv sync && uv run pytest -x -q`. Give this job `timeout-minutes: 30` (torch download).
  - **server-tests**: same pattern in `server/`.
  Do not use `continue-on-error` anywhere. Copy checkout/pnpm boilerplate from `.github/workflows/pages.yml` so versions match.

- [ ] **Step 3: Verify locally what CI will run** (CI itself can only be verified after push): `cd contracts && pnpm exec hardhat test` green; `cd frontend && pnpm exec tsc --noEmit` green; `pnpm exec playwright test tests/rules_engine.spec.ts tests/move_dedup.spec.ts --project=chromium` green; `cd agent && uv run pytest -x -q` green; `cd server && uv run pytest -x -q` green. If a suite has pre-existing failures, do NOT fix them in this task — exclude that suite from the workflow with a `# TODO(pre-existing failures, see plan Task 1)` comment and list the failures in your report to the owner.

- [ ] **Step 4: README.** Add a `## Continuous integration` section after the existing test instructions: name each CI job, its exact local-equivalent command (the four commands from Step 3), and the sentence "All four must be green before merging; the same commands reproduce CI locally."

- [ ] **Step 5: CHANGELOG** entry under `### Added`. Show the owner the diff.

---

## Task 2: Env-configurable Nostr relays and ICE/TURN servers

**Why:** the relay list is hardcoded to three public relays (`frontend/lib/nostr.ts:27-35`) and the only TURN server is a hardcoded IP `132.145.158.84:3479` (`frontend/lib/webrtc_match.ts:24-31`) — single points of failure the owner cannot change without a code edit. This also unblocks running a self-hosted relay later.

**Files:**
- Modify: `frontend/lib/nostr.ts`, `frontend/lib/webrtc_match.ts`
- Create: `frontend/.env.example` (if absent; otherwise append)
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Relays.** In `nostr.ts`, keep the current arrays as `DEFAULT_PUBLISH_RELAYS` / `DEFAULT_SUBSCRIBE_RELAYS` and derive the exported values from env: `NEXT_PUBLIC_NOSTR_PUBLISH_RELAYS` and `NEXT_PUBLIC_NOSTR_RELAYS`, comma-separated `wss://` URLs, trimmed, falling back to the defaults when unset or empty. Note: `NEXT_PUBLIC_*` vars are inlined at build time — read them as `process.env.NEXT_PUBLIC_NOSTR_RELAYS` directly (no dynamic key access, or webpack cannot inline).

- [ ] **Step 2: ICE.** In `webrtc_match.ts`, keep the current list as the default and allow override via `NEXT_PUBLIC_ICE_SERVERS` — a JSON array of `RTCIceServer` objects. Parse inside a try/catch; on parse failure `console.warn` and use the default. Preserve the existing comment explaining why TURN exists.

- [ ] **Step 3: Tests.** `cd frontend && pnpm exec tsc --noEmit`, then `pnpm exec playwright test tests/human_vs_human_synpress.spec.ts --project=chromium --grep "model moves"` (the harness mocks `wss://**`, so it passes regardless of the relay list — this is a regression check that the refactor didn't break module init).

- [ ] **Step 4: README.** Add a `## Configuring matchmaking infrastructure` section: a 3-row table (`NEXT_PUBLIC_NOSTR_RELAYS`, `NEXT_PUBLIC_NOSTR_PUBLISH_RELAYS`, `NEXT_PUBLIC_ICE_SERVERS` — format, default, example), plus a short "Self-hosting a relay" note: strfry via Docker (`docker run -p 7777:7777 ghcr.io/hoytech/strfry`), then set `NEXT_PUBLIC_NOSTR_RELAYS=wss://your-relay.example,wss://nos.lol`. Include how to test: rebuild (`pnpm build`), start, and confirm two browsers still pair on `/`.

- [ ] **Step 5: CHANGELOG** under `### Changed`. Show the owner the diff.

---

## Task 3: Reject ground dice rolls

**Why:** in `PlayHumanClient.tsx`'s `"roll"` handler the receiver trusts both `msg.roundNumber` and `msg.turnIndex` (it even resets its own counter: `turnIndexRef.current = msg.turnIndex + 1`). Old drand rounds are public, so a cheating client can scan `(round, index)` pairs for favorable dice. For staked play this is the #1 fairness hole.

**Files:**
- Modify: `frontend/lib/drand_dice.ts` (add pure validator + constants)
- Modify: `frontend/app/play-human/PlayHumanClient.tsx` (use it)
- Create: `frontend/tests/drand_roll_validation.spec.ts`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Read `frontend/lib/drand_dice.ts` first.** Find the beacon constants (quicknet genesis time and 3s period). If they are not already exported, export `DRAND_GENESIS_SEC` and `DRAND_PERIOD_SEC` using the values already used by `fetchDrandRound` (do not invent values — read what the fetcher uses; drand quicknet is genesis `1692803367`, period `3`, but the file is authoritative).

- [ ] **Step 2: Add the pure validator** to `drand_dice.ts`:
  ```ts
  export interface RollValidationInput {
    roundNumber: number;      // claimed by the roller
    turnIndex: number;        // claimed by the roller
    expectedTurnIndex: number; // receiver's own counter
    nowMs: number;            // Date.now() at receipt
    toleranceRounds?: number;  // default 40 (~2 min of 3s rounds)
  }
  export function validateRollMsg(i: RollValidationInput):
    { ok: true } | { ok: false; reason: string }
  ```
  Reject when `turnIndex !== expectedTurnIndex` (reason `"turn-index"`), and when `|roundNumber − currentRound(nowMs)| > tolerance` (reason `"stale-round"`), where `currentRound(nowMs) = floor((nowMs/1000 − DRAND_GENESIS_SEC) / DRAND_PERIOD_SEC)`. Pure function, no I/O — that's what makes it testable.

- [ ] **Step 3: Wire it into the `"roll"` handler** in `PlayHumanClient.tsx`. Before fetching the round: compute `expectedTurnIndex = turnIndexRef.current`, call the validator, and on failure `setPhaseError(\`Opponent sent an invalid dice roll (${reason}). Game aborted.\`); return;`. **Skip only the stale-round check when `testMode` is true** (the Playwright harness mocks drand with a fixed `round: 1000`); the turn-index check runs in testMode too — the harness sends sequential indices, so existing E2E stays green. Keep the `turnIndexRef.current = msg.turnIndex + 1` update, which is now safe because `msg.turnIndex` was validated.

- [ ] **Step 4: Unit spec** `frontend/tests/drand_roll_validation.spec.ts` (same style as `rules_engine.spec.ts` — plain `test()` blocks, no browser): accepts a current round at the exact expected turn index; rejects turnIndex+1 ahead and −1 behind; rejects a round 1000 rounds in the past and one 1000 in the future; tolerance boundary is inclusive.

- [ ] **Step 5: Verify.** `pnpm exec tsc --noEmit`; `pnpm exec playwright test tests/drand_roll_validation.spec.ts tests/rules_engine.spec.ts --project=chromium`; then the full HvH E2E `tests/human_vs_human_synpress.spec.ts --grep "model moves"` to prove the wiring didn't break live play.

- [ ] **Step 6: README.** Under the existing dice/fairness description add: how dice are derived, what the client now enforces (fresh round ±2 min, strictly sequential turn index), and how to run the new spec. **CHANGELOG** under `### Fixed`. Show the owner the diff.

---

## Task 4: Verify claimed ELO against the chain at pairing

**Why:** `matchmaker.ts:20` promises "callers should verify this against the ENS record (anti-sandbag)" — no caller does. Presence is unauthenticated, so anyone can advertise ELO 900 and farm weaker opponents.

**Files:**
- Modify: `frontend/app/page.tsx` (presence handler)
- Create: `frontend/lib/elo_verify.ts`
- Create: `frontend/tests/elo_verify.spec.ts`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Helper** `frontend/lib/elo_verify.ts`: `makeEloVerifier(readElo: (address: string) => Promise<number | null>)` returning `verify(address: string, claimed: number): Promise<number>` — resolves to the on-chain ELO when readable, otherwise the claimed value clamped to `[800, 2400]`; caches per address for 60s (plain `Map<string, {v: number, at: number}>`). Pure DI (the reader is injected) so tests need no chain.

- [ ] **Step 2: Wire into `page.tsx`.** In the `subscribePresence` callback (where entries are added to `searchersRef`), replace the trusted `p.elo ?? 1500` with the verifier result before inserting. Build the reader from the existing wagmi `usePublicClient()` + `MatchRegistryABI.humanElo` (mirror the read pattern used elsewhere in the file for `chainEloRaw`). The handler is sync today — make the insertion async-safe: verify, then insert; a searcher appearing ~1 read later is fine (the repair timer re-pairs every 5s). **In testMode (`__HVH_TEST_MODE`), bypass verification** (mock chain has no registry) — mirror how testMode is read in this file already.

- [ ] **Step 3: Unit spec** `frontend/tests/elo_verify.spec.ts`: on-chain value wins over claim; null reader → clamped claim (test 100→800, 9999→2400, 1500→1500); cache hit does not re-call the reader within 60s (inject a counting stub).

- [ ] **Step 4: Verify.** `tsc --noEmit`; new spec + `rules_engine.spec.ts`; full HvH E2E `--grep "model moves"` still green (testMode bypass covers it).

- [ ] **Step 5: README** — one paragraph under matchmaking: claimed ELO is now verified against `MatchRegistry.humanElo` before pairing; how to run the spec. **CHANGELOG** `### Fixed`. Show the owner the diff.

---

## Task 5: Competitive trainers on the full board

**Why:** `td_lambda_match` defaults its `state_factory` to `RaceState` — a toy pip race (`agent/sample_trainer.py:205,410`). `round_robin_trainer.py`, `challenge_trainer.py`, and `team_challenge_trainer.py` never pass a factory, so the marketplace/tournament/team loops train agents on the wrong game. `OnnxBoardState` (`agent/onnx_board_state.py`) is a gnubg-free full-backgammon environment that already satisfies the same interface.

**Files:**
- Modify: `agent/round_robin_trainer.py`, `agent/challenge_trainer.py`, `agent/team_challenge_trainer.py`
- Create: `agent/tests/test_trainers_full_board.py`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Read the reference wiring first.** In `agent/sample_trainer.py`, read `main()`'s `--full-board` handling end to end, plus the module-level full-board flag near lines 276–306 and the type-dispatch in `encode_state` / `legal_successors`. Note exactly: (a) how the state factory is constructed, (b) which module global (if any) must be set, (c) how `OnnxBoardState.initial(...)` is called and what arguments it needs (read `agent/onnx_board_state.py` for the signature — do not guess).

- [ ] **Step 2: Add `--board {race,full}` (default `full`)** to all three trainers' CLIs. When `full`, build the same `state_factory` as the reference wiring and pass it to every `td_lambda_match(...)` call (`round_robin_trainer.py` ~line 394; find the equivalents in the other two). In `team_challenge_trainer.py`, also replace the direct `RaceState()` construction at ~line 154 with the factory. When `race`, behavior is byte-identical to today (this keeps CI fast and provides an A/B lever).

- [ ] **Step 3: Emit the mode.** Add `"board": "full"|"race"` to each trainer's `started` JSONL status event so runs are auditable, and — important — so tournament/ELO records can never silently mix environments.

- [ ] **Step 4: Tests** in `agent/tests/test_trainers_full_board.py`: (a) one `round_robin` epoch, 2 agents, `--board full`, tiny settings → completes; asserts the match event's `plies` exceeds the race env's typical length (assert `plies >= 10`) and `started.board == "full"`; (b) `--board race` still runs one epoch (regression); (c) team trainer smoke with 4 agents `--board full`. Mark the full-board tests `@pytest.mark.slow` if the suite has that convention (check `agent/pyproject.toml` / existing markers first).

- [ ] **Step 5: Verify.** `cd agent && uv run pytest tests/test_trainers_full_board.py -q` and the whole `uv run pytest -x -q` still green.

- [ ] **Step 6: README.** Update the training section: the three trainer commands now show `--board full` explicitly, with one sentence — "race is the legacy toy environment; full is real backgammon via the pure-Python board and is the default; agent ELO earned in the two modes is not comparable." Include the exact test command. **CHANGELOG** `### Fixed` (this is a correctness fix, not a feature). Show the owner the diff.

---

## Task 6: Benchmark every agent against the gnubg baseline

**Why:** the pitch is "improves on gnubg", but nothing measures it. The distilled gnubg core (`agent/data/gnubg_core.pt`, produced by `gnubg_distill.py`) is a ready-made frozen baseline: a net with the distilled core and an untouched head is "gnubg-as-shipped".

**Files:**
- Create: `agent/benchmark_vs_gnubg.py`
- Create: `agent/tests/test_benchmark_vs_gnubg.py`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: CLI** `uv run python benchmark_vs_gnubg.py --checkpoint <path> [--games 200] [--board full] [--seed 42] [--json out.json]`. Load the candidate via `sample_trainer.load_checkpoint`; build the baseline exactly the way `sample_trainer` mints a fresh net (gnubg core + fresh head, neutral extras) — read the mint path first and reuse it, do not re-implement. Play `--games` matches with `td_lambda_match`'s machinery in eval mode — read `sample_trainer.evaluate` (line ~534) first; if it already supports a `state_factory`, reuse it, otherwise write a small eval loop mirroring it with no gradient updates and alternating who moves first. Output: win rate, 95% Wilson interval, plies/game, and the JSON blob when `--json` is set.

- [ ] **Step 2: Determinism.** Seed torch + python RNG from `--seed`. Do NOT use wall-clock anywhere in the result (the JSON gets `games`, `win_rate`, `ci95`, `seed`, `board`, `checkpoint_sha256`).

- [ ] **Step 3: Test** `test_benchmark_vs_gnubg.py`: run with `--games 4 --board race` (fast) against a freshly minted checkpoint → completes, win_rate ∈ [0,1], JSON parses, same seed twice → identical JSON.

- [ ] **Step 4: Verify.** `cd agent && uv run pytest tests/test_benchmark_vs_gnubg.py -q`; then run a real 20-game full-board benchmark once and paste the output into your report to the owner.

- [ ] **Step 5: README.** New subsection "Benchmarking an agent against gnubg": the exact command, what the baseline is (distilled gnubg core + fresh head), how to read the interval, and the caveat that race-board numbers are meaningless for real strength. **CHANGELOG** `### Added`. Show the owner the diff.

---

## Task 7: Opponent style at inference

**Why:** training feeds real opponent style profiles into extras slots [18:36] (`agent/round_robin_trainer.py:338-363`), but at inference the browser fills those slots with zeros: `team-demo/page.tsx:559-567,968-978` calls `encodeStyleVector(profile.values)` with the agent's OWN profile only, and the worker's style is fixed at init (`onnx_worker.ts:70-76,170`). The model never sees who it's playing.

**Scope guard:** agent-vs-agent surfaces only (`team-demo`, and `match` if it uses the same loader — check). Human opponents' style profiles (0G KV by address) are OUT of scope — note it in the report, don't attempt it.

**Files:**
- Modify: `frontend/lib/onnx_worker.ts`, `frontend/lib/onnx_eval.ts`
- Modify: `frontend/lib/career_features.ts` (only if the opp param needs plumbing — it already exists at line 61-68)
- Modify: `frontend/app/team-demo/page.tsx`
- Create: `frontend/tests/opponent_style.spec.ts`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Worker message.** In `onnx_worker.ts` add a `{type: "set_style", styleVec: number[]}` handler that replaces `_styleVec` without reloading the model, replying `{type: "set_style_ok"}`. Mirror the existing message-handling shape exactly.

- [ ] **Step 2: API.** In `onnx_eval.ts` export `setEvaluatorStyle(styleVec: number[]): Promise<void>` (singleton worker) and `setAgentEvaluatorStyle(agentId: number, styleVec: number[]): Promise<void>` (per-agent workers) — post `set_style`, resolve on `set_style_ok`. Follow the init-promise pattern already in the file.

- [ ] **Step 3: Build the combined vector at match start.** In `team-demo/page.tsx`, where `styleVec` is currently built from the agent's own profile (both call sites), also fetch the OPPONENT's profile using the same profile fetcher already used there (read the surrounding code to find it — it's the `profile?.values` source), and call `encodeStyleVector(ownProfile.values, oppProfile.values)` — the second parameter exists and is currently unused. When the opponent profile is unavailable, pass only own (current behavior). Call `setEvaluatorStyle`/`setAgentEvaluatorStyle` when a new match starts against a different opponent rather than reloading models.

- [ ] **Step 4: Unit spec** `opponent_style.spec.ts` (logic-only, like `rules_engine.spec.ts`): `encodeStyleVector(own, opp)` puts own into [0:18], opp into [18:36], bias slot 39 = 1; omitting opp leaves [18:36] zeroed; array length 40.

- [ ] **Step 5: Verify.** `tsc --noEmit`; new spec + `onnx_parity.spec.ts` + `team_play.spec.ts` (existing agent specs) green with the sandbox config; then `agent-teammate.spec.ts` if it exercises team-demo.

- [ ] **Step 6: README.** Under the agent/career-features section: state that agent-vs-agent inference now feeds the opponent's public style profile into the extras head (matching how training conditions on opponents), and how to run the new spec. **CHANGELOG** `### Added`. Show the owner the diff.

---

## Task 8: Final verification and handoff

- [ ] **Step 1: Full local matrix.** Run and record pass/fail: `cd contracts && pnpm exec hardhat test`; `cd frontend && pnpm exec tsc --noEmit && pnpm exec playwright test --project=chromium` (full suite; note any spec that needs the backend and skip it explicitly); `cd agent && uv run pytest -q`; `cd server && uv run pytest -q`.

- [ ] **Step 2: README final pass.** Confirm the README now contains, in one place: install steps (pnpm + uv), the CI-equivalent test matrix (Task 1), matchmaking config (Task 2), fairness guarantees (Tasks 3–4), training commands with `--board` (Task 5), the benchmark command (Task 6), and opponent-style inference notes (Task 7). Fix any section the tasks left inconsistent.

- [ ] **Step 3: Stop.** Present the owner: the diff stat, the test matrix results, one draft commit message per task (conventional-commit style), and any suites excluded in Task 1 Step 3. **Do not commit.**

---

## Out of scope (deliberately — needs owner decisions first)

- **Guest/no-wallet play** — product/auth architecture (Privy) decision.
- **Async challenge links + ENS `open_to_challenges` record** — protocol addition; spec it separately.
- **Human opponent style at HvH inference** — needs a 0G KV read path by wallet address.
- **ERC-7857 re-encryption transfer / agent marketplace** — contract-audit-grade work.
- **Both-sign settlement griefing fallback (KeeperHub adjudication)** — cross-system design.
