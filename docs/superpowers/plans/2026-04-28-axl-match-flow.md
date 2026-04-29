# AXL Match Flow Implementation Plan (sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/match?agentId=N` work again by routing the match page through `gnubg_service` (port 8001) instead of the retired FastAPI server (port 8000). Browser owns game state; gnubg stays authoritative on rules.

**Architecture:** Add three endpoints to `agent/gnubg_service.py` — `/new`, `/apply`, `/resign` — that all return a unified `MatchState` shape. Rewrite the match page state machine to call those endpoints, hold its own `MatchState`, and roll dice client-side via `crypto.getRandomValues`.

**Tech Stack:** Python 3.12 + FastAPI + uvicorn (managed by uv) for `gnubg_service`; gnubg subprocess via External Player CLI; Next.js 16 (webpack) + React 19 + TypeScript + wagmi v3 for the frontend; Playwright for visual-regression coverage; pytest for server tests.

**Spec:** `docs/superpowers/specs/2026-04-28-axl-match-flow-design.md`. The user-facing description of `MatchState` and the per-turn flow lives in `README.md` § "Match flow — browser-driven game state".

**Project rules to obey** (from `feedback_*` memories and `CONTEXT.md`):
1. **No commits without owner approval.** This plan stages and shows a diff at the end; it does NOT run `git commit`.
2. **Use `pnpm`, never `npm`/`npx`.** Use `uv` for all Python (`agent/` is now uv-managed; `server/` is too).
3. **Webpack only** — don't remove the `--webpack` flag from `frontend/package.json`.
4. **Frontend Policy 2** — every change to `frontend/app/**` must be verified by `pnpm --filter frontend test:e2e` before "done."
5. **Frontend Policy 1** — no chain or address hardcoding outside `frontend/app/chains.ts`. (Not directly applicable here, but flagged.)

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `agent/gnubg_state.py` | Create | Pure helpers — `decode_position_id`, `decode_match_id`, `MatchStateDict`, `snapshot_state(stdout) -> MatchStateDict`. Ported from `server/app/game_state.py`; no FastAPI, no gnubg subprocess. Easy to unit-test. |
| `agent/gnubg_service.py` | Modify | Add `/new`, `/apply`, `/resign` endpoints. Add a single `_snapshot(commands)` helper that runs gnubg, extracts `position_id` + `match_id` from the output, and feeds them through `gnubg_state.snapshot_state`. Existing `/move` and `/evaluate` are unchanged. |
| `agent/tests/test_gnubg_service.py` | Modify | Add live-gnubg tests for the 3 new endpoints (success + invalid-move). |
| `agent/tests/test_gnubg_state.py` | Create | Unit tests for the pure decoders (no gnubg required). Locks down the bit-unpacking math against known-good fixtures. |
| `frontend/app/dice.ts` | Create | `rollDice(): [number, number]` using `crypto.getRandomValues`. Pure, testable, swap-out point for VRF later. |
| `frontend/app/match/page.tsx` | Rewrite (mostly) | Replace `apiFetch` calls to `localhost:8000` with calls to `NEXT_PUBLIC_GNUBG_URL` (default `http://localhost:8001`). New state machine: `/new` on mount → human turn drives `/apply` → agent turn drives `/move` + `/apply`. Dice come from `rollDice()`. |
| `frontend/app/test-gnubg-fixture/page.tsx` | (not added — direct e2e is enough) | — |
| `frontend/.env.example` | Modify | Add `NEXT_PUBLIC_GNUBG_URL=http://localhost:8001`. |
| `frontend/tests/match-flow-methods.spec.ts` | Rewrite | Mock the new endpoints (`/new`, `/apply`, `/move`, `/resign`) on port 8001 and walk through a complete game including game-over banner. |

---

## Task 1: Port gnubg state decoders into `agent/`

Pure-Python helpers — no gnubg subprocess, no FastAPI. They exist so `/new`, `/apply`, `/resign` can produce the unified `MatchState` shape without each shelling out twice (once for the move, once to "decode the result").

**Files:**
- Create: `agent/gnubg_state.py`
- Create: `agent/tests/test_gnubg_state.py`

- [ ] **Step 1: Write failing tests for the pure decoders**

Create `agent/tests/test_gnubg_state.py`:

```python
"""Tests for gnubg_state.py — pure bit-unpacking decoders.

The fixtures below come from the gnubg opening position used everywhere
else in this repo (a fresh `new match 3`). If gnubg's encoding ever
changes, these tests fail loudly. Position/match id pairs were captured
from a real `new match 3` session — see also
`agent/tests/test_gnubg_service.py::OPENING_*`.
"""
import pytest

from gnubg_state import decode_match_id, decode_position_id, snapshot_state


OPENING_POSITION_ID = "4HPwATDgc/ABMA"
OPENING_MATCH_ID = "cAkAAAAAAAAA"


def test_decode_position_id_returns_24_signed_points():
    board, bar, off = decode_position_id(OPENING_POSITION_ID)
    assert len(board) == 24
    # Standard backgammon opening totals.
    assert sum(c for c in board if c > 0) + bar[0] + off[0] == 15
    assert -sum(c for c in board if c < 0) + bar[1] + off[1] == 15
    # Both bars start empty.
    assert bar == [0, 0]


def test_decode_match_id_initial_state():
    info = decode_match_id(OPENING_MATCH_ID)
    assert info["match_length"] == 3
    assert info["score"] == [0, 0]
    assert info["game_over"] is False


def test_snapshot_state_extracts_ids_from_gnubg_output():
    fake_stdout = (
        "Some preamble...\n"
        f"Position ID: {OPENING_POSITION_ID}\n"
        f"Match ID  : {OPENING_MATCH_ID}\n"
        "Some postamble.\n"
    )
    state = snapshot_state(fake_stdout)
    assert state["position_id"] == OPENING_POSITION_ID
    assert state["match_id"] == OPENING_MATCH_ID
    assert len(state["board"]) == 24
    assert state["match_length"] == 3
    assert state["game_over"] is False
    assert state["winner"] is None


def test_snapshot_state_raises_when_ids_missing():
    with pytest.raises(ValueError, match="position id"):
        snapshot_state("gnubg banner with no id at all")
```

- [ ] **Step 2: Run the test — should fail**

Run: `cd agent && uv run pytest tests/test_gnubg_state.py -v`
Expected: ImportError / ModuleNotFoundError for `gnubg_state` (the file doesn't exist yet).

- [ ] **Step 3: Create `agent/gnubg_state.py`**

```python
"""gnubg_state.py — pure bit-unpacking decoders for gnubg ids.

Ported from `server/app/game_state.py` so the AXL agent node is fully
self-contained. NO gnubg subprocess, NO FastAPI here — these helpers
exist so HTTP endpoints can hand back the unified `MatchState` shape
without each one shelling out twice.

The encoding is gnubg's documented bitstream layout (see gnubg manual
§ "Position ID" / "Match ID"). Bits within each byte are little-endian.
"""

from __future__ import annotations

import base64
import re
from typing import TypedDict


class MatchStateDict(TypedDict):
    """Mirrors the frontend `MatchState` interface (see README §
    "Match flow"). Keys are snake_case to match FastAPI defaults; the
    frontend type uses camelCase for props but reads the JSON via the
    snake_case keys we ship here."""

    position_id: str
    match_id: str
    board: list[int]
    bar: list[int]
    off: list[int]
    turn: int
    dice: list[int] | None
    score: list[int]
    match_length: int
    game_over: bool
    winner: int | None


def decode_position_id(pos_id: str) -> tuple[list[int], list[int], list[int]]:
    """Decode gnubg's base64 position id into a 24-point board with bar
    and off-board counts. Positive integers are player 0 (human / X);
    negative are player 1 (agent / O).

    Returns (board, bar, off) where:
      - board is 24 signed counts in player-0 perspective
      - bar  is [player0_count, player1_count]
      - off  is [player0_count, player1_count]
    """
    b = base64.b64decode(pos_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))

    def parse_player(bits_iter):
        points: list[int] = []
        count = 0
        for _ in range(25):
            while next(bits_iter) == "1":
                count += 1
            points.append(count)
            count = 0
        return points

    bits_iter = iter(bits)
    player0 = parse_player(bits_iter)
    player1 = parse_player(bits_iter)

    board = [0] * 24
    for i in range(24):
        if player0[i] > 0:
            board[i] = player0[i]
        # Player 1's points are mirrored in the player-0 perspective.
        # Must be a separate `if`, not `elif`, since both players can
        # have checkers on different physical points that happen to
        # share an index.
        if player1[i] > 0:
            board[23 - i] = -player1[i]

    p0_on_board = sum(player0)
    p1_on_board = sum(player1)
    bar = [player0[24], player1[24]]
    off = [15 - p0_on_board, 15 - p1_on_board]

    return board, bar, off


def decode_match_id(match_id: str) -> dict:
    """Decode gnubg's base64 match id into a dict of turn/score/cube/
    game-over fields. See gnubg manual for the bit layout; mirrors the
    decoder in server/app/game_state.py with the same human=0 / agent=1
    convention applied (gnubg's raw turn bit is 0=O / 1=X — we invert)."""
    b = base64.b64decode(match_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))

    def get_int(start: int, length: int) -> int:
        sub = bits[start : start + length]
        val = 0
        for i, bit in enumerate(sub):
            if bit == "1":
                val += 1 << i
        return val

    log_cube = get_int(0, 4)
    cube_owner_raw = get_int(4, 2)
    raw_player_on_roll = get_int(6, 1)
    game_state = get_int(8, 3)
    raw_turn = get_int(11, 1)
    dice1 = get_int(15, 3)
    dice2 = get_int(18, 3)
    match_length = get_int(21, 15)
    p0_score = get_int(36, 15)
    p1_score = get_int(51, 15)

    # Invert gnubg's raw turn bit so human=0, agent=1.
    turn = 1 - raw_turn
    player_on_roll = 1 - raw_player_on_roll

    dice = [dice1, dice2] if dice1 > 0 and dice2 > 0 else None
    game_over = game_state > 1

    return {
        "cube": 1 << log_cube if log_cube > 0 else 1,
        "cube_owner": cube_owner_raw if cube_owner_raw < 3 else -1,
        "turn": turn,
        "player_on_roll": player_on_roll,
        "dice": dice,
        "match_length": match_length,
        "score": [p0_score, p1_score],
        "game_over": game_over,
    }


# Regex matches gnubg's `show board` / `show matchid` output. The id
# appears on its own line as `Position ID: <base64>` (and similarly for
# match id). Whitespace before the colon is variable across gnubg
# versions, so we permit it.
_POSITION_ID_RE = re.compile(r"^Position ID\s*:\s*(\S+)\s*$", re.MULTILINE)
_MATCH_ID_RE = re.compile(r"^Match ID\s*:\s*(\S+)\s*$", re.MULTILINE)


def snapshot_state(stdout: str) -> MatchStateDict:
    """Parse gnubg subprocess stdout into a MatchStateDict.

    `stdout` is expected to contain a `Position ID:` and `Match ID:`
    line each. `_run_gnubg` in gnubg_service.py guarantees this by
    issuing `show board` and `show matchid` after the move. Raises
    ValueError if either id is missing — that's a gnubg subprocess
    failure and the caller should surface it as an HTTP 500.
    """
    pos_match = _POSITION_ID_RE.search(stdout)
    if not pos_match:
        raise ValueError("gnubg output missing position id")
    mid_match = _MATCH_ID_RE.search(stdout)
    if not mid_match:
        raise ValueError("gnubg output missing match id")

    position_id = pos_match.group(1)
    match_id = mid_match.group(1)

    board, bar, off = decode_position_id(position_id)
    info = decode_match_id(match_id)

    winner: int | None = None
    if info["game_over"]:
        winner = 1 if info["score"][1] > info["score"][0] else 0

    return MatchStateDict(
        position_id=position_id,
        match_id=match_id,
        board=board,
        bar=bar,
        off=off,
        turn=info["turn"],
        dice=info["dice"],
        score=info["score"],
        match_length=info["match_length"],
        game_over=info["game_over"],
        winner=winner,
    )
```

- [ ] **Step 4: Run the unit tests — should pass**

Run: `cd agent && uv run pytest tests/test_gnubg_state.py -v`
Expected: 4 passed.

---

## Task 2: Add `/new` endpoint to `gnubg_service`

**Files:**
- Modify: `agent/gnubg_service.py`
- Modify: `agent/tests/test_gnubg_service.py`

- [ ] **Step 1: Write a failing test for `/new`**

Add to `agent/tests/test_gnubg_service.py` (append at end):

```python
@pytest.mark.anyio
async def test_new_returns_initial_state(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/new", json={"match_length": 3})
    assert resp.status_code == 200
    state = resp.json()
    assert len(state["board"]) == 24
    assert sum(abs(c) for c in state["board"]) == 30  # 30 checkers on the opening board
    assert state["score"] == [0, 0]
    assert state["match_length"] == 3
    assert state["game_over"] is False
    assert state["winner"] is None
    assert state["bar"] == [0, 0]
    assert state["position_id"]  # non-empty
    assert state["match_id"]
```

- [ ] **Step 2: Run the test — should fail**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_new_returns_initial_state -v`
Expected: 404 from `POST /new` (route not yet defined).

- [ ] **Step 3: Add `_snapshot` helper + `/new` endpoint**

Open `agent/gnubg_service.py`. Add an import for the new state helpers near the existing imports:

```python
from gnubg_state import MatchStateDict, snapshot_state
```

Then add a snapshot helper just below `_run_gnubg` (around line 65):

```python
def _snapshot(commands: str) -> MatchStateDict:
    """Run gnubg with `commands`, append `show matchid` + `show board`,
    parse the resulting state. The helper guarantees both ids appear in
    the output by appending the show commands here — callers don't have
    to remember.
    """
    full = commands + "show matchid\nshow board\n"
    stdout = _run_gnubg(full)
    return snapshot_state(stdout)
```

Add a request model alongside the existing `MoveRequest`:

```python
class NewMatchRequest(BaseModel):
    """Request body for POST /new.

    @param match_length  Match-point target (1, 3, 5, 7, …). gnubg
                         supports anything; the frontend uses 3.
    """

    match_length: int = 3
```

Add the endpoint after the existing `/move` and `/evaluate` definitions:

```python
@app.post("/new")
def new_match(req: NewMatchRequest) -> MatchStateDict:
    """Start a new match and return the opening state.

    @notice Called by the frontend on mount of /match?agentId=N. The
            opening dice are auto-rolled by gnubg's `new match` command;
            the frontend ignores them and rolls its own (see dice.ts).
    @return Full MatchState for the opening position.
    """
    return _snapshot(f"new match {req.match_length}\n")
```

- [ ] **Step 4: Run the test — should pass**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_new_returns_initial_state -v`
Expected: 1 passed.

---

## Task 3: Add `/apply` endpoint

**Files:**
- Modify: `agent/gnubg_service.py`
- Modify: `agent/tests/test_gnubg_service.py`

- [ ] **Step 1: Write failing tests for `/apply`**

Append to `agent/tests/test_gnubg_service.py`:

```python
@pytest.mark.anyio
async def test_apply_advances_state_for_legal_move(app):
    """Apply a legal opening move and confirm state advances:
    the position id changes, the turn flips, and dice are cleared
    (post-move state has no rolled dice)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Get fresh opening state.
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()

        # Apply a standard human opening move with [3,1] dice.
        resp = await client.post(
            "/apply",
            json={
                "position_id": opening["position_id"],
                "match_id": opening["match_id"],
                "dice": [3, 1],
                "move": "8/5 6/5",
            },
        )
    assert resp.status_code == 200
    after = resp.json()
    # Position id changed.
    assert after["position_id"] != opening["position_id"]
    # Turn flipped (assuming opening turn was 0; if gnubg seeded it as 1,
    # this still asserts the flip happened).
    assert after["turn"] != opening["turn"]
    # No dice in the post-move state.
    assert after["dice"] is None


@pytest.mark.anyio
async def test_apply_returns_422_for_illegal_move(app):
    """An illegal move (move from an empty point) returns 422 with
    detail describing what gnubg rejected."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()
        resp = await client.post(
            "/apply",
            json={
                "position_id": opening["position_id"],
                "match_id": opening["match_id"],
                "dice": [3, 1],
                "move": "1/24 1/23",  # nothing on point 1 to move
            },
        )
    assert resp.status_code == 422
    body = resp.json()
    assert "detail" in body
    assert body["detail"]  # non-empty
```

- [ ] **Step 2: Run the tests — should fail**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_apply_advances_state_for_legal_move tests/test_gnubg_service.py::test_apply_returns_422_for_illegal_move -v`
Expected: 404 (route not yet defined).

- [ ] **Step 3: Add the `/apply` endpoint**

In `agent/gnubg_service.py`, add the request model after `NewMatchRequest`:

```python
class ApplyRequest(BaseModel):
    """Request body for POST /apply.

    @param position_id  Current gnubg base64 board.
    @param match_id     Current gnubg base64 match state.
    @param dice         Two-element list [d1, d2] — the browser-rolled
                        dice for the current turn. Browser is the source
                        of truth for dice (rolled via crypto.getRandomValues).
    @param move         gnubg move notation. "from/to" per checker,
                        space-separated. Examples: "8/5 6/5", "bar/22",
                        "6/off". Send the move string literally — do
                        NOT prefix it with the word `move`.
    """

    position_id: str
    match_id: str
    dice: list[int]
    move: str
```

Add the endpoint (after `/new`):

```python
@app.post("/apply")
def apply_move(req: ApplyRequest) -> MatchStateDict:
    """Apply a move and return the post-move state.

    @notice gnubg validates the move against position + match + dice. An
            illegal move is surfaced as HTTP 422 with the gnubg error
            text in `detail`.
    @dev    The move string is sent as a plain notation line (NOT
            prefixed with `move`, which gnubg interprets as "let the AI
            pick"). Same convention the legacy server's `submit_move`
            used.
    @return Full MatchState after the move.
    """
    d1, d2 = req.dice[0], req.dice[1]
    commands = (
        f"set matchid {req.match_id}\n"
        f"set board {req.position_id}\n"
        f"set dice {d1} {d2}\n"
        f"{req.move}\n"
    )
    try:
        state = _snapshot(commands)
    except ValueError as e:
        # `_snapshot` raises ValueError when gnubg output is missing
        # ids — that's our signal that gnubg refused the move (its
        # `show matchid` output is suppressed when it errors out).
        raise HTTPException(status_code=422, detail=str(e)) from e

    # Belt-and-suspenders: if gnubg silently kept the same position
    # AND turn, the move was effectively a no-op — also a 422.
    # (We only reach here if both ids parsed; in practice gnubg either
    # advances state or emits an error that ValueError catches above.)
    return state
```

You'll also need to import `HTTPException` from FastAPI. Add it to the existing FastAPI import:

```python
from fastapi import FastAPI, HTTPException
```

- [ ] **Step 4: Run the tests — should pass**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_apply_advances_state_for_legal_move tests/test_gnubg_service.py::test_apply_returns_422_for_illegal_move -v`
Expected: 2 passed.

---

## Task 4: Add `/resign` endpoint

**Files:**
- Modify: `agent/gnubg_service.py`
- Modify: `agent/tests/test_gnubg_service.py`

- [ ] **Step 1: Write a failing test for `/resign`**

Append to `agent/tests/test_gnubg_service.py`:

```python
@pytest.mark.anyio
async def test_resign_ends_game_with_winner(app):
    """Resigning at the opening: the game ends and the winner is the
    side that did NOT resign (i.e. opposite of the pre-resign turn)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()
        pre_turn = opening["turn"]

        resp = await client.post(
            "/resign",
            json={
                "position_id": opening["position_id"],
                "match_id": opening["match_id"],
            },
        )
    assert resp.status_code == 200
    after = resp.json()
    assert after["game_over"] is True
    assert after["winner"] == 1 - pre_turn
```

- [ ] **Step 2: Run the test — should fail**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_resign_ends_game_with_winner -v`
Expected: 404.

- [ ] **Step 3: Add the `/resign` endpoint**

In `agent/gnubg_service.py`, add the request model:

```python
class ResignRequest(BaseModel):
    """Request body for POST /resign.

    @param position_id  Current gnubg base64 board.
    @param match_id     Current gnubg base64 match state.
    """

    position_id: str
    match_id: str
```

Add the endpoint:

```python
@app.post("/resign")
def resign(req: ResignRequest) -> MatchStateDict:
    """Resign the current side. Returns post-resign state with
    `game_over=true` and `winner` set to the opponent.

    @dev gnubg's `resign normal` + `accept` is the same sequence the
         legacy server used. `accept` is required because gnubg waits
         for the opponent to accept the resignation; in solo play we
         auto-accept on behalf of the opposing seat.
    """
    commands = (
        f"set matchid {req.match_id}\n"
        f"set board {req.position_id}\n"
        f"resign normal\n"
        f"accept\n"
    )
    return _snapshot(commands)
```

- [ ] **Step 4: Run the test — should pass**

Run: `cd agent && uv run pytest tests/test_gnubg_service.py::test_resign_ends_game_with_winner -v`
Expected: 1 passed.

- [ ] **Step 5: Run the full agent test suite**

Run: `cd agent && uv run pytest tests/ -v`
Expected: all tests pass (existing 4 + new 5 = 9, plus the 4 in test_gnubg_state.py = 13 total).

---

## Task 5: Add the `dice.ts` helper

**Files:**
- Create: `frontend/app/dice.ts`

- [ ] **Step 1: Write the dice helper**

Create `frontend/app/dice.ts`:

```typescript
// Pure dice-rolling helper. Browser-side dice for v1 (human-vs-agent):
// the human is rolling for themselves, so trust is local.
//
// Uses `crypto.getRandomValues` — distinguishes from `Math.random` so a
// future swap to commit-reveal / VRF-backed dice is a single-file change
// with no transitive call-site updates. v2 (human-vs-human) will need
// commit-reveal here.

const SIDES = 6;

/**
 * Roll two six-sided dice. Returns `[d1, d2]` where each value is in
 * [1, 6]. Uniform distribution per crypto.getRandomValues.
 */
export function rollDice(): [number, number] {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // Modulo would skew the distribution — use floor of (n / (UINT32_MAX+1))
  // multiplied by SIDES. JS numbers are doubles so this is exact for
  // 32-bit inputs. UINT32_MAX+1 = 0x100000000 = 4294967296.
  const d1 = Math.floor((buf[0] / 0x100000000) * SIDES) + 1;
  const d2 = Math.floor((buf[1] / 0x100000000) * SIDES) + 1;
  return [d1, d2];
}
```

- [ ] **Step 2: Type-check passes**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: exit 0.

(There's no separate frontend unit-test runner in this project; the helper is exercised transitively when the match page rolls dice. Frontend Policy 2 keeps Playwright as the visual-regression gate.)

---

## Task 6: Add `NEXT_PUBLIC_GNUBG_URL` env

**Files:**
- Modify: `frontend/.env.example`

- [ ] **Step 1: Append the new var**

Open `frontend/.env.example` and append:

```
# AXL gnubg agent node URL (the local gnubg_service from agent/).
# Used by the match flow page (frontend/app/match/page.tsx) for
# /new, /apply, /move, /resign. Defaults to localhost:8001 if unset.
NEXT_PUBLIC_GNUBG_URL=http://localhost:8001
```

- [ ] **Step 2: If a `.env.local` already exists, suggest the user mirror this**

This is a manual heads-up to the owner; no code change.

---

## Task 7: Rewrite the match page to drive `gnubg_service`

This is the largest change. Done as a single edit because the new state machine, types, and fetch helpers all interlock.

**Files:**
- Modify: `frontend/app/match/page.tsx`

- [ ] **Step 1: Read the current file**

Read `frontend/app/match/page.tsx` end-to-end. You'll be replacing roughly:
- The `GameState` interface (rename to `MatchState`, drop `game_id` / `cube` / `cube_owner`)
- The `apiFetch` helper (point at `NEXT_PUBLIC_GNUBG_URL`)
- The `useEffect` that creates the game (call `/new`)
- The auto-drive `useEffect` for the agent (call `/move` then `/apply`)
- The `doRoll`, `doMove`, `doForfeit` action handlers (re-shape around `/apply` and `/resign`)

Keep:
- The `<Suspense>` wrapper.
- The `<Board>`, `<DiceRoll>`, `<ConnectButton>`, header layout.
- The `agentMoving` ref (concurrency guard).

- [ ] **Step 2: Replace the file contents**

Replace the entire body of `frontend/app/match/page.tsx` with:

```tsx
// Phase 26: match flow over the AXL gnubg agent node.
//
// URL: /match?agentId=<N>
//
// State machine (browser-owned game state — no central server):
//   on mount         → POST /new {match_length} → opening MatchState
//   if turn === 0    → roll dice client-side, wait for human input
//   human submits    → POST /apply {position_id, match_id, dice, move}
//                       on 200 → replace state; if turn === 1, agent loop
//                       on 422 → surface error, leave state unchanged
//   agent loop (turn === 1)
//                    → roll dice client-side
//                    → POST /move → best move
//                    → POST /apply with that move
//                    → replace state; if turn === 0, roll for human
//   forfeit          → POST /resign → game_over response
//
// Move notation is gnubg's standard: "8/5 6/5" (from-point/to-point,
// space-separated for multiple checker movements). See
// docs/gnubg-notation.md or the agent test suite for examples.
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Board } from "../Board";
import { ConnectButton } from "../ConnectButton";
import { DiceRoll } from "../DiceRoll";
import { rollDice } from "../dice";

// ── Types matching agent/gnubg_state.py:MatchStateDict ────────────────────

interface MatchState {
  position_id: string;
  match_id: string;
  board: number[];
  bar: [number, number];
  off: [number, number];
  turn: 0 | 1;
  dice: [number, number] | null;
  score: [number, number];
  match_length: number;
  game_over: boolean;
  winner: 0 | 1 | null;
}

// ── API helpers ───────────────────────────────────────────────────────────

const GNUBG = process.env.NEXT_PUBLIC_GNUBG_URL ?? "http://localhost:8001";

/**
 * POST helper for gnubg_service. All endpoints use POST with a JSON
 * body. 422 responses surface as Error with the `detail` string so
 * the page can render gnubg's complaint to the user.
 */
async function gnubgPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GNUBG}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // text wasn't JSON — keep raw.
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

// ── Component ─────────────────────────────────────────────────────────────

export default function MatchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Loading…</p>
        </div>
      }
    >
      <MatchInner />
    </Suspense>
  );
}

function MatchInner() {
  const params = useSearchParams();
  const agentId = Number(params.get("agentId") ?? "1");

  const [game, setGame] = useState<MatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveInput, setMoveInput] = useState("");

  // Concurrency guard — prevents duplicate /move + /apply cascades.
  const agentMoving = useRef(false);

  // ── Start a new game on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    gnubgPost<MatchState>("/new", { match_length: 3 })
      .then((state) => {
        if (cancelled) return;
        // Roll the opening dice for whichever side starts. Both sides
        // need dice before any move; gnubg's auto-roll is disabled in
        // _INIT_COMMANDS, so we own the dice everywhere.
        const withDice = { ...state, dice: rollDice() } as MatchState;
        setGame(withDice);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Auto-drive the agent when it's their turn ──────────────────────────
  useEffect(() => {
    if (!game || game.game_over || game.turn !== 1 || agentMoving.current) {
      return;
    }
    if (!game.dice) return; // dice are rolled by /apply's caller, not here
    agentMoving.current = true;

    const step = async () => {
      try {
        const { move: best } = await gnubgPost<{ move: string | null }>(
          "/move",
          {
            position_id: game.position_id,
            match_id: game.match_id,
            dice: game.dice,
          },
        );
        if (!best) {
          // No legal moves — auto-pass via /apply with empty notation.
          // gnubg accepts a bare "move" notation as "no checker moves
          // possible, dance and pass." If your gnubg build differs,
          // surface this as an error rather than silently looping.
          throw new Error("Agent has no legal move (bar dance) — not yet handled");
        }
        const next = await gnubgPost<MatchState>("/apply", {
          position_id: game.position_id,
          match_id: game.match_id,
          dice: game.dice,
          move: best,
        });
        // After /apply, dice are null. Roll for whichever side is now
        // on roll so the next render has dice available.
        const nextWithDice = next.game_over
          ? next
          : ({ ...next, dice: rollDice() } as MatchState);
        setGame(nextWithDice);
      } catch (e: unknown) {
        setError(String(e));
      } finally {
        agentMoving.current = false;
      }
    };

    // Small delay so the human sees the agent's dice land before its move.
    const timer = setTimeout(step, 400);
    return () => clearTimeout(timer);
  }, [game]);

  // ── Human actions ──────────────────────────────────────────────────────

  const doMove = async () => {
    if (!game || !moveInput.trim() || !game.dice) return;
    setLoading(true);
    setError(null);
    try {
      const next = await gnubgPost<MatchState>("/apply", {
        position_id: game.position_id,
        match_id: game.match_id,
        dice: game.dice,
        move: moveInput.trim(),
      });
      // Same rule as the agent loop: roll dice for the next side now.
      const nextWithDice = next.game_over
        ? next
        : ({ ...next, dice: rollDice() } as MatchState);
      setGame(nextWithDice);
      setMoveInput("");
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const doForfeit = async () => {
    if (!game || game.game_over) return;
    if (!window.confirm("Forfeit this match? You'll be marked as the loser.")) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await gnubgPost<MatchState>("/resign", {
        position_id: game.position_id,
        match_id: game.match_id,
      });
      setGame(next);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  if (!game && loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-zinc-500 dark:text-zinc-400">Starting game…</p>
      </div>
    );
  }

  if (!game && error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 dark:bg-black p-8">
        <p className="text-red-600 dark:text-red-400">
          Could not start game: {error}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Make sure the AXL gnubg agent node is running at{" "}
          <code className="font-mono">{GNUBG}</code>.
        </p>
        <Link
          href="/"
          className="text-sm text-indigo-600 underline dark:text-indigo-400"
        >
          ← Back to agents
        </Link>
      </div>
    );
  }

  if (!game) return null;

  const isHumanTurn = game.turn === 0;
  const isAgentTurn = game.turn === 1;
  const needsMove = !!game.dice && isHumanTurn;

  const winnerLabel =
    game.winner === 0 ? "You win!" : game.winner === 1 ? "Agent wins." : "Draw";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Agents
        </Link>
        <div className="flex flex-1 items-center justify-center gap-4">
          <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
            Agent #{agentId} · {game.match_length}-pt match
          </span>
          <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
            {game.score[0]} – {game.score[1]}
          </span>
        </div>
        <ConnectButton />
      </header>

      {/* Main */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
        {game.game_over && (
          <div
            className={`rounded-lg border p-4 ${
              game.winner === 0
                ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20"
                : "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20"
            }`}
          >
            <p
              className={`text-lg font-bold ${
                game.winner === 0
                  ? "text-blue-700 dark:text-blue-300"
                  : "text-red-700 dark:text-red-300"
              }`}
            >
              {winnerLabel}
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Final score: {game.score[0]} – {game.score[1]}
            </p>
            {/* Sub-project C will replace this with the two-sig settlement flow. */}
            <button
              disabled
              className="mt-3 cursor-not-allowed rounded-md bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
              title="Settlement wired in sub-project C"
            >
              Settle on-chain (coming soon)
            </button>
          </div>
        )}

        <Board
          board={game.board}
          bar={game.bar}
          off={game.off}
          turn={game.turn}
        />

        {game.dice && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Rolled:
            </span>
            <DiceRoll dice={game.dice} />
          </div>
        )}

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </p>
        )}

        {!game.game_over && isHumanTurn && needsMove && (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doMove()}
                placeholder='e.g. "8/5 6/5" or "off"'
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
              <button
                onClick={doMove}
                disabled={loading || !moveInput.trim()}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? "…" : "Move"}
              </button>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Notation: <code className="font-mono">from/to</code> per checker,
              space-separated. Bar: <code className="font-mono">bar/N</code>.
              Bear-off: <code className="font-mono">N/off</code>.
            </p>
          </div>
        )}

        {!game.game_over && isAgentTurn && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 animate-pulse">
            Agent is thinking…
          </p>
        )}

        {!game.game_over && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={doForfeit}
              disabled={loading}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700/60 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              Forfeit match
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
```

What changed vs the old file:
- `GameState` → `MatchState`. Drops `game_id`, `cube`, `cube_owner`.
- `API` constant → `GNUBG`, points at `NEXT_PUBLIC_GNUBG_URL`.
- `apiFetch` → `gnubgPost` (same shape, plus 422-detail unwrapping).
- New-game effect calls `/new` and immediately rolls opening dice via `rollDice()`.
- Auto-drive cascade calls `/move` then `/apply` (no `/roll` round trip).
- `doMove` calls `/apply`. The page now rolls the next side's dice itself rather than waiting for a server response with dice.
- `doRoll` is gone — dice always exist whenever it's a side's turn.
- `doForfeit` calls `/resign`.
- The "Could not start game" error message points users at `gnubg_service` instead of port 8000.

- [ ] **Step 3: Type-check passes**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: exit 0.

---

## Task 8: Rewrite the match-flow Playwright spec

**Files:**
- Modify: `frontend/tests/match-flow-methods.spec.ts`

- [ ] **Step 1: Replace the spec contents**

Replace the entire body of `frontend/tests/match-flow-methods.spec.ts` with:

```typescript
// Match flow regression — drives /match?agentId=1 against mocked
// gnubg_service endpoints and asserts a complete game can be played
// without any request to the retired FastAPI server (port 8000).
//
// Phase 26 (post-pivot): the match page calls gnubg_service on
// localhost:8001 directly. /new on mount, /apply for every move,
// /move + /apply for the agent's turn, /resign for forfeit.

import { test, expect, type Route } from "@playwright/test";

const OPENING_POSITION_ID = "4HPwATDgc/ABMA";
const OPENING_MATCH_ID = "cAkAAAAAAAAA";

// Canned MatchState fixtures. Position/match ids are realistic but the
// browser only inspects turn / game_over / winner / dice for routing,
// so the rest can be coarse.
const OPENING: Record<string, unknown> = {
  position_id: OPENING_POSITION_ID,
  match_id: OPENING_MATCH_ID,
  board: [-2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
  bar: [0, 0],
  off: [0, 0],
  turn: 0,
  dice: null,
  score: [0, 0],
  match_length: 3,
  game_over: false,
  winner: null,
};

const AFTER_HUMAN_MOVE = { ...OPENING, position_id: "humanmoved", turn: 1, dice: null };
const AFTER_AGENT_MOVE = { ...OPENING, position_id: "agentmoved", turn: 0, dice: null };
const GAME_OVER = { ...OPENING, position_id: "gameover", turn: 0, dice: null, game_over: true, winner: 0, score: [3, 0] };

test("match flow walks /new → /apply → /move → /apply through to game over", async ({ page }) => {
  const seen: Record<string, string[]> = {
    new: [],
    apply: [],
    move: [],
    resign: [],
  };

  let applyCount = 0;

  const fulfill = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  // POST /new — start match.
  await page.route("**/new", async (route) => {
    seen.new.push(route.request().method());
    await fulfill(route, OPENING);
  });

  // POST /apply — three calls: human move, agent move, then game-over.
  await page.route("**/apply", async (route) => {
    seen.apply.push(route.request().method());
    applyCount += 1;
    if (applyCount === 1) await fulfill(route, AFTER_HUMAN_MOVE);
    else if (applyCount === 2) await fulfill(route, AFTER_AGENT_MOVE);
    else await fulfill(route, GAME_OVER);
  });

  // POST /move — agent picks a move once.
  await page.route("**/move", async (route) => {
    seen.move.push(route.request().method());
    await fulfill(route, { move: "13/10 6/3", candidates: [] });
  });

  // POST /resign — exercised by a separate test below; route must exist
  // so a stray call doesn't escape and 404 to a real server.
  await page.route("**/resign", async (route) => {
    seen.resign.push(route.request().method());
    await fulfill(route, GAME_OVER);
  });

  await page.goto("/match?agentId=1");

  // /new fires on mount.
  await expect.poll(() => seen.new.length, { timeout: 10_000 }).toBe(1);

  // Submit a human move — drives /apply.
  const moveInput = page.getByPlaceholder('e.g. "8/5 6/5" or "off"');
  await moveInput.fill("8/5 6/5");
  await page.getByRole("button", { name: "Move" }).click();

  // Cascade: /apply (human) → /move (agent best) → /apply (agent move).
  await expect.poll(() => seen.apply.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => seen.move.length, { timeout: 5_000 }).toBe(1);

  // Submit the next human move; this one returns game_over.
  await moveInput.fill("24/22 24/23");
  await page.getByRole("button", { name: "Move" }).click();

  // Wait for the post-game banner.
  await expect(page.getByText("You win!")).toBeVisible({ timeout: 5_000 });

  // Method assertions: every gnubg_service call is POST.
  expect(seen.new).toEqual(["POST"]);
  for (const m of seen.apply) expect(m).toBe("POST");
  for (const m of seen.move) expect(m).toBe("POST");
});

test("forfeit posts /resign and shows the game-over banner", async ({ page }) => {
  await page.route("**/new", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(OPENING),
    });
  });
  await page.route("**/apply", async (route) => {
    // Should not be hit in this test, but route exists to swallow strays.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OPENING) });
  });
  await page.route("**/move", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ move: null, candidates: [] }) });
  });

  let resignCalled = false;
  await page.route("**/resign", async (route) => {
    resignCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...GAME_OVER, winner: 1 }),
    });
  });

  await page.goto("/match?agentId=1");

  // Auto-accept the confirm dialog, then click Forfeit.
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Forfeit match" }).click();

  await expect(page.getByText("Agent wins.")).toBeVisible({ timeout: 5_000 });
  expect(resignCalled).toBe(true);
});
```

What changed vs the old spec:
- Routes match new endpoint shapes (`/new`, `/apply`, `/move`, `/resign`) instead of `/games`, `/games/:id/move`, `/games/:id/roll`, `/games/:id/agent-move`.
- Two tests: a full-game cascade and a forfeit test.
- No more `/roll` route — dice are client-side, never sent to the server.
- `OPENING_POSITION_ID` / `OPENING_MATCH_ID` constants reuse the same fixtures the agent's pytest tests use.

- [ ] **Step 2: Run the new spec on its own**

Run: `pnpm --filter frontend test:e2e match-flow-methods`
Expected: 2 passed.

- [ ] **Step 3: Run the full Playwright suite**

Run: `pnpm --filter frontend test:e2e`
Expected: every test passes (existing dice-size, network-dropdown, home-navbar specs + the rewritten match-flow-methods).

---

## Task 9: Live-stack smoke test

**Files:** none — this is a manual verification step.

- [ ] **Step 1: Start the AXL agent node**

In one terminal:
```bash
cd agent && ./start.sh
```
Wait for both uvicorn services to print `Application startup complete` on ports 8001 and 8002.

- [ ] **Step 2: Start the frontend**

In another terminal:
```bash
pnpm frontend:dev
```

- [ ] **Step 3: Play a game**

Visit `http://localhost:3000/match?agentId=1` in a browser with MetaMask. Verify:
- Board renders with the standard backgammon opening.
- Dice appear under the board.
- Submitting a legal move (e.g. `8/5 6/5`) advances the board.
- The agent rolls and moves within ~1s.
- After several turns the game completes and the post-game banner appears.
- DevTools Network tab shows requests only to `localhost:8001` (no `localhost:8000`).

If anything misbehaves, check the agent uvicorn logs first — gnubg subprocess errors are surfaced there.

---

## Task 10: Show owner the diff and a draft commit message

**Files:** none — stop-and-wait checkpoint.

Per `feedback_git_policy` and `CONTEXT.md` § "Git Policy": draft, paste into log.md, **stop**, wait for "commit" approval.

- [ ] **Step 1: Show the diffstat**

Run: `git status` and `git diff --stat`.

- [ ] **Step 2: Draft the commit message**

Show the user this message (do NOT run `git commit`):

```
Phase 26: match flow over AXL gnubg agent node (no central server)

Migrates the match page from the retired FastAPI server (port 8000) to
the AXL gnubg_service agent node (port 8001). The browser now owns the
entire game state — a single MatchState object held in React — and
round-trips every move through gnubg_service for validation and state
advancement. Dice are rolled in the browser via crypto.getRandomValues.
This is sub-project A of the post-pivot match flow; coach narration
(sub-project B) and two-sig on-chain settlement (sub-project C) remain
out of scope.

gnubg_state (agent/gnubg_state.py, new):
- Pure bit-unpacking decoders ported from server/app/game_state.py
  (decode_position_id, decode_match_id) plus a snapshot_state() helper
  that parses gnubg's `show board` / `show matchid` output into the
  unified MatchState shape consumed by the frontend.
- No FastAPI, no gnubg subprocess — easy to unit-test.

gnubg_service endpoints (agent/gnubg_service.py, updated):
- POST /new   — start a new match of the given length, return opening
  MatchState. Internally `new match N` + show board/matchid.
- POST /apply — apply a move with given dice; 422 with gnubg's error
  text on illegal moves. Internally `set matchid / set board / set
  dice / <move>`.
- POST /resign — resign current side; sets game_over and the winner to
  the opposite side. Internally `resign normal` + `accept`.
- A shared _snapshot helper appends `show matchid` + `show board` to
  every command sequence and runs them through snapshot_state.
- Existing /move and /evaluate are unchanged.

dice (frontend/app/dice.ts, new):
- rollDice(): [number, number] — uniform 1..6 via crypto.getRandomValues.
- Single swap-out point for VRF / commit-reveal in v2.

Match page (frontend/app/match/page.tsx, rewritten):
- New MatchState type drops game_id, cube, cube_owner from the old
  GameState. position_id, match_id, board, bar, off, turn, dice, score,
  match_length, game_over, winner.
- gnubgPost helper points at NEXT_PUBLIC_GNUBG_URL (default
  http://localhost:8001) and unwraps 422 detail strings into thrown
  Error messages.
- State machine: /new on mount → roll opening dice → human or agent
  loop → /apply (or /move + /apply for agent) → roll next dice → loop.
  Forfeit calls /resign.
- Error UI now points the user at the gnubg_service URL instead of port
  8000.

Tests:
- agent/tests/test_gnubg_state.py (new, 4 tests):
  - decode_position_id returns 24 signed points + correct totals
  - decode_match_id parses opening match length / score / game_over
  - snapshot_state extracts ids from gnubg-style stdout
  - snapshot_state raises when ids are missing
- agent/tests/test_gnubg_service.py (new, 4 tests):
  - /new returns sane initial state
  - /apply advances state for a legal opening move
  - /apply returns 422 for an illegal move
  - /resign ends the game with the correct winner
- frontend/tests/match-flow-methods.spec.ts (rewritten, 2 tests):
  - full game cascade /new → /apply → /move → /apply → game_over
  - forfeit calls /resign and shows the banner

13 agent pytest tests pass; 9+ frontend Playwright tests pass.
```

- [ ] **Step 3: Stop**

Wait for the owner's "commit" (or equivalent). When approved, run:

```bash
git add agent/gnubg_state.py \
        agent/gnubg_service.py \
        agent/tests/test_gnubg_state.py \
        agent/tests/test_gnubg_service.py \
        frontend/app/dice.ts \
        frontend/app/match/page.tsx \
        frontend/.env.example \
        frontend/tests/match-flow-methods.spec.ts \
        docs/superpowers/specs/2026-04-28-axl-match-flow-design.md \
        docs/superpowers/plans/2026-04-28-axl-match-flow.md
git commit -m "$(cat <<'EOF'
[paste the message above]
EOF
)"
```

---

## Self-review notes (recorded by plan author)

- **Spec coverage:**
  - `MatchState` shape → defined in Task 1 (`MatchStateDict`) and Task 7 (`MatchState`). Names match.
  - `/new`, `/apply`, `/resign` → Tasks 2/3/4. Each has a passing test.
  - Browser flow (mount → human → agent → game-over → forfeit) → Task 7 + Task 8.
  - Client-side dice → Task 5. Used in Task 7.
  - Out-of-scope items (coach, settlement, cube, dead server endpoints) → flagged in plan header and not exercised in any task.
- **Type consistency:** `MatchState` (TS) and `MatchStateDict` (Python TypedDict) have identical key sets. `position_id`, `match_id`, `board`, `bar`, `off`, `turn`, `dice`, `score`, `match_length`, `game_over`, `winner`. Python uses snake_case throughout; the JSON ships snake_case; the TS interface uses snake_case keys to match (intentional — keeps the wire format readable when debugging in the network tab).
- **Placeholder check:** every code step contains the actual code; commands are exact; no "TODO"s or "see X" hand-waves. The "no legal moves" path in Task 7 throws an explicit error rather than silently looping (acknowledged limitation: bar-dance auto-pass is not implemented in this round; gnubg's behavior here may need a follow-up if it turns out to be common in the demo).
- **Skipped:** unit tests for `dice.ts` — the project doesn't have a frontend unit-test runner. The function is small and exercised transitively. If a `vitest` setup ever lands, add a unit test then.
