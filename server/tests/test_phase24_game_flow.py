"""
Phase 24: end-to-end game-flow integration test against the real gnubg
subprocess.

Catches the class of bug behind "I press Move and nothing happens" — i.e.
a `/move` POST that doesn't actually advance the position, or a roll
that doesn't surface dice. Skipped if gnubg isn't installed at
`/usr/bin/gnubg`, so CI without the binary stays green.

Distinct from the legacy `test_phase1_game.py`, which was written
against an older route shape (`{"agent_id": "gnubg-1"}`, nested
`state.state`) and no longer matches the current server contract.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

# Make `app` importable when running pytest from server/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# `gnubg_client` invokes the binary as `gnubg` (PATH lookup), so honour
# the same convention here. Common locations: /usr/games/gnubg (Debian
# / Ubuntu), /usr/bin/gnubg (Fedora). Falls back to PATH search.
pytestmark = pytest.mark.skipif(
    shutil.which("gnubg") is None,
    reason="gnubg not on PATH; skipping live game flow test",
)


def _client() -> TestClient:
    # Import inside the helper so the import doesn't fail at collection
    # time when the gnubg binary is missing (the skipif is per-test).
    from app.main import app  # noqa: WPS433

    return TestClient(app)


def test_create_game_returns_initial_state_with_both_players_on_board():
    client = _client()
    resp = client.post("/games", json={"agent_id": 1, "match_length": 1})
    assert resp.status_code == 200, resp.text
    state = resp.json()

    # Game id + ids surfaced in the response so the caller can drive the flow.
    assert state["game_id"], "game_id should be set"
    assert state["position_id"], "position_id should be set"
    assert state["match_id"], "match_id should be set"

    # The decoded board must show BOTH players' checkers — this is the
    # regression we just fixed in decode_position_id. Player 0 = positive
    # counts, player 1 = negative counts.
    board = state["board"]
    assert any(c > 0 for c in board), "player 0 must have checkers on the board"
    assert any(c < 0 for c in board), "player 1 must have checkers on the board"

    # Match shouldn't be over before any move is played.
    assert state["game_over"] is False
    assert state["match_length"] == 1


# In our codebase Alice = human (X / blue / `turn=0` in our convention)
# and Bob = agent (O / red / `turn=1`). The fundamental phase-1
# invariant of any backgammon engine: during one player's turn, only
# *their* pieces can change. The other player's pieces can only ever
# lose checkers to the bar via a hit — they cannot appear at new
# points and they cannot move between points. The two tests below
# pin both directions of that invariant.

def _legal_opening_move(dice: list[int]) -> list[str]:
    """Build a few candidate legal-looking opening moves for `dice`.

    The caller submits each in turn until one is accepted (gnubg
    returns 400 for illegal notations). If none works, fall back to
    /agent-move which auto-plays whoever's on roll.
    """
    return [
        f"24/{24 - dice[0]} 13/{13 - dice[1]}",
        f"24/{24 - dice[1]} 13/{13 - dice[0]}",
        f"13/{13 - dice[0]} 13/{13 - dice[1]}",
        f"24/{24 - sum(dice)}",
        "8/3 6/3",
    ]


def _drive_to_alices_turn(client: TestClient, gid: str, state: dict) -> dict:
    """Helper: walk the game forward until it's Alice's (human's)
    turn AND she has dice. With the External Player protocol auto-roll
    is off, so we explicitly roll if dice are missing. If the opening
    rolled Bob first, /roll → /agent-move plays his opening move."""
    if state["turn"] != 0:
        if state["dice"] is None:
            state = client.post(f"/games/{gid}/roll").json()
        state = client.post(f"/games/{gid}/agent-move").json()
    assert state["turn"] == 0, (
        f"setup: could not reach Alice's turn; got turn={state['turn']}"
    )
    if state["dice"] is None:
        state = client.post(f"/games/{gid}/roll").json()
    return state


def _agent_play(client: TestClient, gid: str, state: dict) -> dict:
    """Helper: have Bob (the agent) take a turn — roll if needed,
    then /agent-move. Mirrors the frontend auto-drive: with auto-roll
    off, dice must be rolled explicitly before agent-move."""
    if state["dice"] is None:
        state = client.post(f"/games/{gid}/roll").json()
    return client.post(f"/games/{gid}/agent-move").json()


def test_bob_pieces_do_not_change_while_alice_plays():
    """During Alice's turn, Bob's checkers (negative values in the
    decoded board, agent on the UI) must not change at all — neither
    in count, nor in position. Alice can only move her own checkers
    and at most send one of Bob's blots to the bar (which would also
    have to be reflected in `bar[1]`, not just shuffled to a different
    point).

    Symptom this catches: "my pieces are in the wrong place after I
    move" / "the agent's pieces moved while it was my turn" — both
    show up as a non-zero diff between Bob's pre-move and post-move
    layout (with the bar bookkeeping accounting for any hits).
    """
    client = _client()
    state = client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    gid = state["game_id"]
    state = _drive_to_alices_turn(client, gid, state)

    # Snapshot Bob's layout (negatives = Bob in our convention).
    bob_before = [-c if c < 0 else 0 for c in state["board"]]
    bar_bob_before = state["bar"][1]
    off_bob_before = state["off"][1]

    # Drive Alice's move. If no typed notation works for these dice,
    # use /agent-move to auto-play her — either way the state advances
    # past Alice's turn so we can compare.
    dice = state["dice"]
    pos_before = state["position_id"]
    for note in _legal_opening_move(dice):
        r = client.post(f"/games/{gid}/move", json={"move": note})
        if r.status_code == 200 and r.json()["position_id"] != pos_before:
            state = r.json()
            break
        assert r.status_code in (200, 400), r.text
    else:
        state = _agent_play(client, gid, state)

    bob_after = [-c if c < 0 else 0 for c in state["board"]]
    bar_bob_after = state["bar"][1]
    off_bob_after = state["off"][1]

    # ── Invariant 1: Bob can't gain checkers at any point during ───
    # Alice's turn. Hits remove Bob's checkers; nothing puts new ones
    # on the board.
    gained = [
        (i, bob_before[i], bob_after[i])
        for i in range(24)
        if bob_after[i] > bob_before[i]
    ]
    assert not gained, (
        "Bob (the agent) gained checkers at board points during Alice's "
        "(the human's) turn — impossible in real backgammon, but the "
        "exact symptom of a perspective / encoding bug in "
        "`_build_game_state` or `gnubg_client.submit_move`. "
        f"Gained at {gained} (format: [(board_index, before, after), …])."
    )

    # ── Invariant 2: any Bob checker that left the board went to the bar.
    lost_from_board = sum(bob_before) - sum(bob_after)
    delta_bar = bar_bob_after - bar_bob_before
    delta_off = off_bob_after - off_bob_before
    assert delta_off == 0, (
        f"Bob's `off` count changed during Alice's turn (delta={delta_off}); "
        "only Bob can bear his own checkers off."
    )
    assert lost_from_board == delta_bar, (
        "Bob-checker accounting failed across Alice's turn: "
        f"{lost_from_board} disappeared from the board but only "
        f"{delta_bar} appeared on Bob's bar. Likely a decode bug — "
        "checkers should be conserved across hit transitions."
    )

    # ── Invariant 3: total Bob checkers = 15 across board + bar + off. ─
    total_after = sum(bob_after) + bar_bob_after + off_bob_after
    assert total_after == 15, (
        f"Bob's checker conservation broken across Alice's turn: "
        f"{total_after} total (expected 15)."
    )


def test_alice_pieces_do_not_change_while_bob_plays():
    """The symmetric invariant: during Bob's (agent's) turn, Alice's
    checkers (positive values in the decoded board, human on the UI)
    must not change at all — only Bob's can.

    This is the test that originally failed with `Gained at
    [(2, 0, 2), (12, 4, 6)]` against a pre-fix server, exactly
    reproducing the user's reported "my pieces are in the wrong
    place after the agent moves" symptom.
    """
    client = _client()
    state = client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    gid = state["game_id"]
    state = _drive_to_alices_turn(client, gid, state)

    # Drive Alice's move first so we have a state that's mid-game and
    # it's Bob's turn next.
    dice = state["dice"]
    pos_before = state["position_id"]
    for note in _legal_opening_move(dice):
        r = client.post(f"/games/{gid}/move", json={"move": note})
        if r.status_code == 200 and r.json()["position_id"] != pos_before:
            state = r.json()
            break
        assert r.status_code in (200, 400), r.text
    else:
        state = _agent_play(client, gid, state)

    if state["game_over"]:
        return

    # Snapshot Alice's layout right before Bob moves.
    alice_before = [c if c > 0 else 0 for c in state["board"]]
    bar_alice_before = state["bar"][0]
    off_alice_before = state["off"][0]

    # Drive Bob's turn: roll if needed, then play.
    if state["dice"] is None:
        state = client.post(f"/games/{gid}/roll").json()
    state = client.post(f"/games/{gid}/agent-move").json()

    alice_after = [c if c > 0 else 0 for c in state["board"]]
    bar_alice_after = state["bar"][0]
    off_alice_after = state["off"][0]

    gained = [
        (i, alice_before[i], alice_after[i])
        for i in range(24)
        if alice_after[i] > alice_before[i]
    ]
    assert not gained, (
        "Alice (the human) gained checkers at board points during Bob's "
        "(the agent's) turn — impossible in real backgammon, exactly the "
        "user-visible \"my pieces are in the wrong place after the agent "
        "moves\" symptom. "
        f"Gained at {gained} (format: [(board_index, before, after), …])."
    )

    lost_from_board = sum(alice_before) - sum(alice_after)
    delta_bar = bar_alice_after - bar_alice_before
    delta_off = off_alice_after - off_alice_before
    assert delta_off == 0, (
        f"Alice's `off` count changed during Bob's turn (delta={delta_off}); "
        "only Alice can bear her own checkers off."
    )
    assert lost_from_board == delta_bar, (
        "Alice-checker accounting failed across Bob's turn: "
        f"{lost_from_board} disappeared from the board but only "
        f"{delta_bar} appeared on Alice's bar."
    )

    total_after = sum(alice_after) + bar_alice_after + off_alice_after
    assert total_after == 15, (
        f"Alice's checker conservation broken across Bob's turn: "
        f"{total_after} total (expected 15)."
    )


def test_turn_convention_matches_human_zero_agent_one():
    """gnubg's match-id bit 11 encodes whose turn it is, but with the
    convention 0=O / 1=X. In our codebase X is the user (the human) and
    O is gnubg (the agent), and we want turn=0=human / turn=1=agent —
    which is the opposite. This test pins the inversion in
    `decode_match_id`.

    Regression symptom: every Move / Roll was applied to the wrong
    color, so the user's pieces ended up "in the wrong place" after
    each agent reply. The opening is non-deterministic (whoever rolls
    higher plays first), so we don't assert on the initial state. We
    drive the game until after the agent has played, and assert that
    control returns to the human (turn=0).
    """
    client = _client()
    state = client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    gid = state["game_id"]

    # We deliberately drive the SECOND player from each starting state
    # (whichever it happens to be) rather than the opening-roll player —
    # so the test doesn't care who gnubg picks to start. Specifically:
    #   - If the opening rolled human first, we let gnubg auto-play
    #     human's opening move via /agent-move (it works for any side
    #     that's currently on roll), then assert the agent is up next.
    #   - If the opening rolled agent first, /agent-move plays the
    #     agent immediately and we assert the human is up next.
    # /agent-move is more reliable than typed move notation because we
    # don't have to guess legal moves for arbitrary dice.
    starting_turn = state["turn"]
    pos_before = state["position_id"]
    state = _agent_play(client, gid, state)
    assert state["position_id"] != pos_before, (
        "agent-move did not advance position_id; cannot trust the new turn"
    )

    expected_turn_after = 1 - starting_turn
    assert state["turn"] == expected_turn_after, (
        f"after one player moved (started as turn={starting_turn}), expected "
        f"turn={expected_turn_after}; got {state['turn']} — gnubg's "
        "match-id turn bit (0=O / 1=X) needs to be inverted in "
        "decode_match_id to match our 0=human / 1=agent convention."
    )


def test_roll_then_move_advances_position_id():
    """The full /games → /roll → /move chain must produce a different
    position_id after the move. If /move silently does nothing (e.g. an
    invalid notation that the server fails to flag), the position_id
    won't change and the frontend shows the move button as a no-op —
    exactly the symptom that motivated this test."""
    client = _client()

    create = client.post("/games", json={"agent_id": 1, "match_length": 1}).json()
    game_id = create["game_id"]
    position_before_roll = create["position_id"]

    roll = client.post(f"/games/{game_id}/roll").json()
    dice = roll["dice"] or []
    assert len(dice) == 2, f"roll should produce two dice, got {dice}"
    # Rolling alone shouldn't move checkers — only dice should change.
    assert roll["position_id"] == position_before_roll, (
        "roll mutated the board; expected only dice to change"
    )

    # The legal-move set depends on the random roll. Try a roll-derived
    # opening move; if it's illegal for this specific roll, fall back to
    # any legal move via the agent-move helper. Either way, the
    # post-condition is the same: position_id must change after the move
    # is committed (or, in the worst case, after the agent auto-plays it
    # because the human side has no legal options).
    d = sorted(set(dice), reverse=True)
    candidates = []
    if 6 in d and 5 in d:
        candidates.append("24/18 13/8")
    if 6 in d and 4 in d:
        candidates.append("24/18 13/9")
    if 6 in d and 3 in d:
        candidates.append("24/18 13/10")
    if 6 in d and 2 in d:
        candidates.append("13/11 24/18")
    # Always-safe-to-attempt fallbacks; gnubg will reject if illegal.
    candidates.extend([f"13/{13 - dice[0]} 24/{24 - dice[1]}", "8/3 6/3"])

    moved = None
    for note in candidates:
        resp = client.post(f"/games/{game_id}/move", json={"move": note})
        if resp.status_code == 200:
            moved = resp.json()
            assert moved["position_id"] != position_before_roll, (
                f"/move accepted notation {note!r} but position_id didn't change"
            )
            break
        # 400 means gnubg rejected the move for this roll — try the next.
        assert resp.status_code == 400, (
            f"/move returned unexpected status {resp.status_code}: {resp.text}"
        )

    if moved is None:
        # No human move worked for this roll — let the agent auto-play
        # from this position to confirm the underlying mechanics still
        # advance state.
        agent = client.post(f"/games/{game_id}/agent-move")
        assert agent.status_code == 200, agent.text
        assert agent.json()["position_id"] != position_before_roll
