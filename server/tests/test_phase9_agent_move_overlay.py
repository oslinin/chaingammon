"""
Phase 9 wiring tests — confirm that `/agent-move` actually consults the
agent's experience overlay when picking a move from gnubg's candidate
list.

The keystone property: same gnubg base + same position + different
overlays → different chosen move. That's what makes the iNFT meaningful
as an asset rather than a label, and it's what these tests pin down at
the runtime layer.

No network. gnubg is mocked so the tests stay fast and deterministic.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app.agent_overlay import Overlay  # noqa: E402
from app.game_state import GameState  # noqa: E402


# Three structurally-different candidates with explicit equity ordering
# so we can read the test results: gnubg ranks A first, but the overlay
# can promote B or C.
CANDIDATE_A = {"move": "8/5 6/5", "equity": 0.10}     # build_5_point
CANDIDATE_B = {"move": "24/22 24/20", "equity": 0.08}  # runs_back_checker
CANDIDATE_C = {"move": "13/8 13/9", "equity": 0.09}   # neutral middle-game


def _state(*, game_id: str, pos: str = "POS", mid: str = "MID", turn: int = 1, dice=(3, 1)) -> GameState:
    return GameState(
        game_id=game_id,
        match_id=mid,
        position_id=pos,
        board=[0] * 24,
        bar=[0, 0],
        off=[0, 0],
        turn=turn,
        dice=list(dice),
        cube=1,
        cube_owner=-1,
        match_length=1,
        score=[0, 0],
        game_over=False,
    )


@pytest.fixture(autouse=True)
def _reset_in_memory_state():
    main_module.games.clear()
    main_module._game_started_at.clear()
    main_module._move_history.clear()
    main_module._game_agent_id.clear()
    main_module._game_overlays.clear()
    yield
    main_module.games.clear()
    main_module._game_started_at.clear()
    main_module._move_history.clear()
    main_module._game_agent_id.clear()
    main_module._game_overlays.clear()


@pytest.fixture
def client(monkeypatch):
    """Mock gnubg so tests don't depend on the binary, and stub
    `_build_game_state` so we can hand-build state from arbitrary mock
    responses without real position/match-id decoding."""
    mock_gnubg = MagicMock()
    mock_gnubg.new_match.return_value = {
        "position_id": "POS_INIT",
        "match_id": "MATCH_INIT",
        "output": "",
    }
    mock_gnubg.roll_dice.return_value = {
        "position_id": "POS_AFTER_ROLL",
        "match_id": "MATCH_AFTER_ROLL",
        "output": "",
    }
    mock_gnubg.submit_move.return_value = {
        "position_id": "POS_AFTER_AGENT",
        "match_id": "MATCH_AFTER_AGENT",
        "output": "",
    }
    mock_gnubg.get_candidate_moves.return_value = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C]
    monkeypatch.setattr(main_module, "gnubg", mock_gnubg)

    # State builder pretends every gnubg response decodes to a plain
    # in-progress GameState; we don't need real backgammon state here.
    def _fake_build(game_id, pos, mid):
        return _state(game_id=game_id, pos=pos, mid=mid, turn=1, dice=(3, 1))

    monkeypatch.setattr(main_module, "_build_game_state", _fake_build)

    return TestClient(main_module.app), mock_gnubg


# --- zero overlay → gnubg's top equity wins ---------------------------------


def test_zero_overlay_picks_gnubg_top_equity_move(client):
    test_client, mock_gnubg = client
    # Fresh agent, agent_id=0 means "no on-chain lookup", overlay defaults to zero.
    game = test_client.post("/games", json={"agent_id": 0, "match_length": 1}).json()
    game_id = game["game_id"]
    test_client.post(f"/games/{game_id}/roll")

    test_client.post(f"/games/{game_id}/agent-move")

    submitted = mock_gnubg.submit_move.call_args.args[2]
    assert submitted == CANDIDATE_A["move"], (
        f"zero overlay should pick the top-equity candidate ({CANDIDATE_A['move']}); "
        f"got {submitted!r}"
    )


# --- biased overlay → biased pick wins -------------------------------------


def test_overlay_biased_for_back_checkers_picks_running_move(client):
    test_client, mock_gnubg = client
    game = test_client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    game_id = game["game_id"]

    # Inject a strong learned bias toward runs_back_checker BEFORE the
    # agent moves. This stand-in for "an agent that's played 50 matches
    # and learned to favour the running game."
    overlay = Overlay.default()
    overlay = Overlay(
        version=overlay.version,
        values={**overlay.values, "runs_back_checker": 1.0},
        match_count=overlay.match_count,
    )
    main_module._game_overlays[game_id] = overlay

    test_client.post(f"/games/{game_id}/roll")
    test_client.post(f"/games/{game_id}/agent-move")

    submitted = mock_gnubg.submit_move.call_args.args[2]
    assert submitted == CANDIDATE_B["move"], (
        f"agent with runs_back_checker=1 should pick {CANDIDATE_B['move']}; "
        f"got {submitted!r}"
    )


def test_two_agents_with_different_overlays_pick_different_moves(client):
    """Same gnubg candidate set, two different overlays → two different
    submitted moves. This is the property that makes the iNFT meaningful."""
    test_client, mock_gnubg = client

    # Agent 1: heavy build_5_point bias.
    g1 = test_client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    g1_id = g1["game_id"]
    o1 = Overlay.default()
    main_module._game_overlays[g1_id] = Overlay(
        version=o1.version,
        values={**o1.values, "build_5_point": 0.9},
        match_count=o1.match_count,
    )

    # Agent 2: heavy runs_back_checker bias.
    g2 = test_client.post("/games", json={"agent_id": 2, "match_length": 1}).json()
    g2_id = g2["game_id"]
    o2 = Overlay.default()
    main_module._game_overlays[g2_id] = Overlay(
        version=o2.version,
        values={**o2.values, "runs_back_checker": 0.9},
        match_count=o2.match_count,
    )

    test_client.post(f"/games/{g1_id}/roll")
    test_client.post(f"/games/{g1_id}/agent-move")
    pick_1 = mock_gnubg.submit_move.call_args.args[2]

    test_client.post(f"/games/{g2_id}/roll")
    test_client.post(f"/games/{g2_id}/agent-move")
    pick_2 = mock_gnubg.submit_move.call_args.args[2]

    assert pick_1 != pick_2, (
        f"different overlays should produce different picks; both picked {pick_1!r}"
    )


# --- auto-play fallback (no candidates) ------------------------------------


def test_no_candidates_falls_back_to_get_agent_move(client):
    """If gnubg returns no candidates (e.g. dance from the bar), there's
    nothing to bias; the endpoint should auto-play via gnubg's existing
    fallback path."""
    test_client, mock_gnubg = client
    mock_gnubg.get_candidate_moves.return_value = []
    mock_gnubg.get_agent_move.return_value = {
        "position_id": "POS_AUTO",
        "match_id": "MID_AUTO",
        "output": "",
        "best_move": None,  # auto-played
    }

    game = test_client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    game_id = game["game_id"]
    test_client.post(f"/games/{game_id}/roll")
    test_client.post(f"/games/{game_id}/agent-move")

    # submit_move should NOT have been called for auto-play.
    assert not mock_gnubg.submit_move.called, (
        "auto-play fallback should not call submit_move; it lets gnubg play through"
    )
    mock_gnubg.get_agent_move.assert_called_once()


# --- overlay is cached per game --------------------------------------------


def test_overlay_loaded_once_per_game(client):
    """Subsequent /agent-move calls in the same game should reuse the
    cached overlay rather than re-loading from 0G Storage every move."""
    test_client, _ = client
    game = test_client.post("/games", json={"agent_id": 0, "match_length": 1}).json()
    game_id = game["game_id"]

    # First /agent-move populates the cache (agent_id=0 → default zero
    # overlay, no chain hit).
    test_client.post(f"/games/{game_id}/roll")
    test_client.post(f"/games/{game_id}/agent-move")
    assert game_id in main_module._game_overlays

    cached = main_module._game_overlays[game_id]

    # Second move: cached identity should be the same object.
    test_client.post(f"/games/{game_id}/roll")
    test_client.post(f"/games/{game_id}/agent-move")
    assert main_module._game_overlays[game_id] is cached


# --- agent_id is recorded at game creation ---------------------------------


def test_create_game_records_agent_id(client):
    test_client, _ = client
    game = test_client.post("/games", json={"agent_id": 7, "match_length": 1}).json()
    game_id = game["game_id"]
    assert main_module._game_agent_id[game_id] == 7
