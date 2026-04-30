"""Tests for gnubg_service.py — run with: cd agent && python -m pytest tests/test_gnubg_service.py -v"""
import shutil
import pytest
from httpx import AsyncClient, ASGITransport

# Import lazily so the test file itself can be collected even without gnubg_service on the path.
# Each test body imports what it needs.
OPENING_POSITION_ID = "4HPwATDgc/ABMA"
OPENING_MATCH_ID = "cAkAAAAAAAAA"


@pytest.fixture
def app():
    """Import gnubg_service.app inside the fixture so collection doesn't fail before the
    module is created (TDD: tests are written before the implementation file exists)."""
    from gnubg_service import app as _app
    return _app


@pytest.mark.anyio
async def test_move_returns_candidates(app):
    """/move must return a list of candidates with move + equity."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/move", json={
            "position_id": OPENING_POSITION_ID,
            "match_id": OPENING_MATCH_ID,
            "dice": [3, 1],
            "agent_weights_hash": "",
        })
    assert resp.status_code == 200
    body = resp.json()
    assert "move" in body
    assert "candidates" in body
    assert len(body["candidates"]) >= 1
    assert "equity" in body["candidates"][0]


@pytest.mark.anyio
async def test_move_bad_position_returns_422(app):
    """/move with missing required field returns 422."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/move", json={"dice": [1, 2]})
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_new_returns_initial_state(app):
    """/new returns the opening MatchState for a 3-point match."""
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


@pytest.mark.anyio
async def test_apply_advances_state_for_legal_move(app):
    """Apply a legal opening move and confirm state advances:
    the position id changes and the turn flips. dice in the post-move
    state are gnubg's; the frontend ignores them and rolls its own."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()
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
    assert after["position_id"] != opening["position_id"]
    assert after["turn"] != opening["turn"]


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


@pytest.mark.anyio
async def test_play_to_end_finishes_the_match(app):
    """/play_to_end runs to match-point in one gnubg subprocess.

    Sanity-check the server-side fast-forward path: starting from the
    opening position of a 1-point match (so completion only requires
    one game), the response is `game_over=true` with a winner set and
    a non-zero score for the winning side.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1-point match keeps the test fast — only one game needs to finish.
        new_resp = await client.post("/new", json={"match_length": 1})
        opening = new_resp.json()
        resp = await client.post(
            "/play_to_end",
            json={
                "position_id": opening["position_id"],
                "match_id": opening["match_id"],
            },
        )
    assert resp.status_code == 200
    after = resp.json()
    assert after["game_over"] is True, "fast-forward should produce a finished match"
    assert after["winner"] in (0, 1)
    # Whichever side won should have a non-zero score; the loser stays at 0.
    assert after["score"][after["winner"]] >= 1


@pytest.mark.anyio
async def test_skip_flips_the_turn(app):
    """/skip on the opening position with current_turn=0 must hand the
    turn over to the agent. Board is unchanged; match_id encodes the
    new turn so the next move applies correctly to the right side."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()
        # Force `current_turn` to whichever side the opening seeded so the
        # skip flips to the OTHER side. The opening dice are decoded from
        # gnubg and the on-roll side comes from match_id; we rely on
        # /skip's `current_turn` parameter (which the frontend always
        # passes from its own state) rather than re-deriving it here.
        from_turn = opening["turn"]
        resp = await client.post(
            "/skip",
            json={
                "position_id": opening["position_id"],
                "match_id": opening["match_id"],
                "current_turn": from_turn,
            },
        )
    assert resp.status_code == 200
    after = resp.json()
    assert after["turn"] != from_turn, "skip should flip the turn"
    assert after["board"] == opening["board"], "skip must leave the board untouched"
    assert after["game_over"] is False


@pytest.mark.anyio
async def test_resign_ends_game_with_winner(app):
    """Human forfeit at the opening: game ends with agent (winner=1)
    regardless of which side gnubg seeded as on-roll."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        new_resp = await client.post("/new", json={"match_length": 3})
        opening = new_resp.json()
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
    # /resign is "human forfeits" — agent always wins.
    assert after["winner"] == 1
    assert after["score"][1] >= 1
    assert after["score"][0] == 0
