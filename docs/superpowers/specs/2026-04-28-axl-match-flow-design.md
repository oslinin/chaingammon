# AXL match flow — sub-project A — design

**Date:** 2026-04-28
**Topic:** Migrate the match page from the deprecated FastAPI server (`localhost:8000`) to the AXL `gnubg_service` agent node (`localhost:8001`). Browser owns game state; gnubg stays authoritative on rules.
**User-facing reference:** `README.md` § "Match flow — browser-driven game state".

## Goal

Make `/match?agentId=N` work again. Today it network-errors against `localhost:8000` because the old FastAPI server has been retired (commit `7053a9fb`, "pivot: drop FastAPI server + KeeperHub; adopt Gensyn AXL + two-sig settlement + LLM coach"). The match page should drive a complete human-vs-agent game by talking to `gnubg_service` directly — no central server in the loop.

## Scope (decomposed plan, this is sub-project A)

In: human-vs-agent gameplay end-to-end. Browser holds state, calls `gnubg_service` for `/new`, `/apply`, `/move`, `/resign`. Game runs to completion and shows the existing post-game banner. Forfeit works.

Out (separate brainstorms later):
- **Sub-project B** — coach narration via `coach_service /hint` injected into the match page.
- **Sub-project C** — two-signature on-chain settlement (`MatchRegistry.recordMatch(sig1, sig2)`). Requires a contract change.

Also out at this layer: cube doubling, human-vs-human peer discovery, VRF / commit-reveal dice, deletion of dead `server/app/main.py` `/games` endpoints (cleanup PR later).

## Architecture (one-line summary)

The browser holds a `MatchState` object and round-trips every move through `gnubg_service`. `gnubg_service` gets three new endpoints (`/new`, `/apply`, `/resign`) that all return the same `MatchState` shape. Existing `/move` and `/evaluate` are unchanged. Dice are rolled in the browser (`crypto.getRandomValues`).

The full `MatchState` shape, endpoint table, and per-turn flow diagram are documented in `README.md` § "Match flow — browser-driven game state". This spec defers to that section as the authoritative description and only records the implementation-side decisions below.

## Why approach A1 ("/apply on the agent node" rather than a JS engine in the browser)

gnubg already encodes every backgammon rule (move legality, hit detection, dice consumption order, bear-off, game-over) inside `submit_move` over its External Player protocol. The pre-pivot FastAPI server used exactly this. A JS engine in the browser would either duplicate years of rule-tuning work or quietly diverge from the engine the agent uses. Adding `/apply` to `gnubg_service` is the smallest delta — it reuses the exact gnubg-shell sequence the old `submit_move` used.

This also matches the AXL trust model: each player runs gnubg locally and can audit it. There is no advantage to moving rule logic into the browser when the engine is already on the player's machine.

## Endpoint contract details

For the implementation plan, the three new endpoints conform to:

**`POST /new`**
- Request: `{ "match_length": int }` (1, 3, 5, 7, …)
- Response: full `MatchState` (see README), with `score=[0,0]`, `match_length=req.match_length`, `dice=null`, `turn=0` (gnubg defaults), `game_over=false`, `winner=null`.
- Implementation: gnubg `new match <N>` followed by `show matchid` / `show board`.

**`POST /apply`**
- Request: `{ position_id, match_id, dice: [d1, d2], move: string }`. `move` uses gnubg notation (`"8/5 6/5"`, `"bar/22"`, `"6/off"`).
- Response 200: full `MatchState` after the move. `dice` in the response is `null` (post-move gnubg state has no rolled dice).
- Response 422: `{ "detail": <string from gnubg's error output> }` when the move is illegal.
- Implementation:
  ```
  set matchid <match_id>
  set board <position_id>
  set dice <d1> <d2>
  move <move>
  show matchid
  show board
  ```
  Reuses `_run_gnubg` helper.

**`POST /resign`**
- Request: `{ position_id, match_id }`
- Response: full `MatchState` with `game_over=true`, `winner` = the side that did NOT resign (i.e. opposite of pre-resign `turn`).
- Implementation: gnubg `resign normal` + `accept`. The same sequence the old `gnubg.resign(...)` used.

The shared response decoder lives once in `agent/gnubg_service.py` and is re-used by all three endpoints.

## Files to touch

| File | Change |
| --- | --- |
| `agent/gnubg_service.py` | Add `/new`, `/apply`, `/resign` endpoints + a shared `_decode_match_state(...)` helper. Keep existing `/move` and `/evaluate` untouched. |
| `agent/tests/test_gnubg_service.py` | Add tests: `/new` returns sane initial state; `/apply` advances state for a legal move and 422s for an illegal one; `/resign` ends the game with the correct winner. |
| `frontend/app/match/page.tsx` | Rewrite the state machine: replace `apiFetch` with calls to `gnubg_service`; add client-side dice rolling; remove `agent_id` from the body of `/new` (it isn't needed at the gnubg layer — the agent identity stays a URL param the page renders for context). |
| `frontend/app/dice.ts` (new) | Pure function `rollDice(): [number, number]` using `crypto.getRandomValues`. Unit-testable, swap-out point for VRF/commit-reveal later. |
| `frontend/.env.example` | Add `NEXT_PUBLIC_GNUBG_URL=http://localhost:8001`. |
| `frontend/tests/match-flow-methods.spec.ts` | Update mocks to intercept `gnubg_service` endpoints instead of the old `/games/...` API. The spirit of the test (POST-only methods, full turn cascade) is preserved. |

## Testing strategy

Server-side: pytest tests in `agent/tests/test_gnubg_service.py`. Use the opening position constants already defined there (`OPENING_POSITION_ID`, `OPENING_MATCH_ID`) for fixture state.

Frontend: Playwright spec mocks `gnubg_service` with `page.route` (same pattern as the existing `match-flow-methods.spec.ts`). The mock returns canned `MatchState` responses that walk a game from start → human move → agent move → game over. Asserts:

- POST `/new` fires on mount.
- POST `/apply` fires after each human move and each agent move.
- POST `/move` fires once per agent turn (before `/apply`).
- The full cascade reaches `game_over=true` and the post-game banner renders.

No live gnubg in Playwright. The `gnubg` subprocess is exercised by the pytest tests on the server side.

## Risks / open calls during implementation

- **gnubg's `move` command** sometimes rejects partial moves (e.g. when the user submits one die's worth and gnubg expects both consumed). The legacy `submit_move` returned the raw stderr; we surface that same string in the 422 detail body. The match page already renders an error toast, so this should "just work."
- **Dice consumption rules** (must use both dice if any legal sequence exists) — gnubg enforces these, so the browser doesn't need to. Bad inputs → 422 → user retries.
- **Initial `match_id` for `match_length` other than 3** — `gnubg new match N` should produce a valid initial state for any N. Test the common values (1, 3, 5, 7) in pytest.
- **Race conditions on the auto-drive** — current match page uses an `agentMoving` ref to prevent concurrent /agent-move calls. Keep that pattern.

## What success looks like

`pnpm frontend:dev` + `cd agent && ./start.sh`, then visit `/match?agentId=1`:

1. The board renders with the standard backgammon opening.
2. Dice appear under the board.
3. You enter a move (e.g. `8/5 6/5`) and click Move.
4. The agent rolls and plays a move within ~1s.
5. Steps 3–4 repeat until the game ends.
6. The "You win!" / "Agent wins" banner appears.
7. Forfeit also produces the banner.

No requests to `localhost:8000`. The browser network tab shows only `localhost:8001`.
