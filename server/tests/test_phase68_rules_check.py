"""
Phase 68 tests: pure-Python backgammon rules validation step in the
KeeperHub settlement workflow.

Run with:  cd server && uv run pytest tests/test_phase68_rules_check.py -v

Covers:
  - Happy path: valid game record passes rules check
  - Illegal move detection: step fails and names the offending move
  - Auto-played moves are skipped without error
  - Missing dice field raises RuntimeError (malformed record)
  - Empty move list succeeds (nothing to validate)
  - No game_record in context raises RuntimeError
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import keeper_workflow as kw  # noqa: E402


# ─── fixtures ───────────────────────────────────────────────────────────────


def _ctx_with_record(moves: list[dict]) -> kw.WorkflowContext:
    record = {
        "match_length": 1,
        "moves": moves,
        "final_position_id": "FINAL",
    }
    return kw.WorkflowContext(match_id="42", game_record=record)


def _step() -> kw.WorkflowStep:
    return kw.WorkflowStep(id="rules_check", name="Backgammon rules validation (pure-Python)")


# ─── happy path ─────────────────────────────────────────────────────────────


def test_rules_check_valid_opening_move():
    """Classic opening 3-1: 8/5 6/5 is legal from the starting position."""
    ctx = _ctx_with_record([
        {"turn": 0, "dice": [3, 1], "move": "8/5 6/5"},
    ])
    step = _step()
    kw.step_rules_check(ctx, step)
    assert "validated" in step.detail
    assert "1 move" in step.detail


def test_rules_check_two_valid_moves():
    """Two moves in sequence both pass; board state advances correctly.
    Player 1 (side=1) moves 1→24 so src < dst in gnubg notation."""
    ctx = _ctx_with_record([
        {"turn": 0, "dice": [3, 1], "move": "8/5 6/5"},
        {"turn": 1, "dice": [4, 2], "move": "12/16 12/14"},
    ])
    step = _step()
    kw.step_rules_check(ctx, step)
    assert "2 move" in step.detail


def test_rules_check_empty_move_list_passes():
    """A game record with no moves is trivially valid."""
    ctx = _ctx_with_record([])
    step = _step()
    kw.step_rules_check(ctx, step)
    assert "0 move" in step.detail


# ─── auto-played skips ───────────────────────────────────────────────────────


def test_rules_check_skips_auto_played():
    """(auto-played) entries are skipped, not validated."""
    ctx = _ctx_with_record([
        {"turn": 0, "dice": [3, 1], "move": "(auto-played)"},
        # Player 1 (side=1) moves 1→24 so valid notation has src < dst.
        {"turn": 1, "dice": [4, 2], "move": "12/16 12/14"},
    ])
    step = _step()
    kw.step_rules_check(ctx, step)
    assert "1 auto-played skip" in step.detail
    assert "1 move" in step.detail


def test_rules_check_skips_empty_move_string():
    """Entries with an empty move string are also skipped."""
    ctx = _ctx_with_record([
        {"turn": 0, "dice": [3, 1], "move": ""},
        {"turn": 1, "dice": [4, 2], "move": "12/16 12/14"},
    ])
    step = _step()
    kw.step_rules_check(ctx, step)
    assert "1 auto-played skip" in step.detail


# ─── illegal move detection ──────────────────────────────────────────────────


def test_rules_check_illegal_move_fails():
    """A move that uses a pip not in the dice fails the step."""
    ctx = _ctx_with_record([
        # 8/3 requires 5 pips; dice are (3, 1) — illegal.
        {"turn": 0, "dice": [3, 1], "move": "8/3"},
    ])
    step = _step()
    with pytest.raises(RuntimeError, match="violates backgammon rules"):
        kw.step_rules_check(ctx, step)


def test_rules_check_blocked_destination_fails():
    """Player 0 cannot land on a point held by 2+ opponent checkers."""
    ctx = _ctx_with_record([
        # From opening, point 19 has 5 player-1 checkers — blocked for player 0.
        {"turn": 0, "dice": [5, 5], "move": "24/19 24/19"},
    ])
    step = _step()
    with pytest.raises(RuntimeError, match="violates backgammon rules"):
        kw.step_rules_check(ctx, step)


def test_rules_check_names_the_offending_move():
    """Error message includes the move index and notation."""
    ctx = _ctx_with_record([
        {"turn": 0, "dice": [3, 1], "move": "8/5 6/5"},  # ok
        {"turn": 1, "dice": [4, 2], "move": "8/1"},       # illegal (wrong pip)
    ])
    step = _step()
    with pytest.raises(RuntimeError) as exc_info:
        kw.step_rules_check(ctx, step)
    assert "move #1" in str(exc_info.value)
    assert "8/1" in str(exc_info.value)


# ─── malformed record ────────────────────────────────────────────────────────


def test_rules_check_missing_dice_raises():
    """A move entry without a dice field is malformed — fail the step."""
    ctx = _ctx_with_record([
        {"turn": 0, "move": "8/5 6/5"},   # no 'dice' key
    ])
    step = _step()
    with pytest.raises(RuntimeError, match="no dice"):
        kw.step_rules_check(ctx, step)


def test_rules_check_no_game_record_raises():
    """step_rules_check requires ctx.game_record to be populated."""
    ctx = kw.WorkflowContext(match_id="42")   # game_record not set
    step = _step()
    with pytest.raises(RuntimeError, match="game_record not loaded"):
        kw.step_rules_check(ctx, step)


# ─── workflow integration ────────────────────────────────────────────────────


def test_rules_check_step_in_workflow_happy_path():
    """End-to-end: rules_check step passes in a run_workflow call where all
    other steps are stubbed out."""
    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    runners["audit_append"] = lambda ctx, step, *, workflow: None

    # Inject a game_record so rules_check has something to validate.
    def _inject_record(ctx, step):
        ctx.game_record = {
            "match_length": 1,
            "moves": [{"turn": 0, "dice": [3, 1], "move": "8/5 6/5"}],
            "final_position_id": "FINAL",
        }

    runners["og_storage_fetch"] = _inject_record
    # Use the real rules_check runner.
    del runners["rules_check"]

    wf = kw.run_workflow("99", runners=runners)
    rules_step = next(s for s in wf.steps if s.id == "rules_check")
    assert rules_step.status == "ok"
    assert "validated" in rules_step.detail


def test_rules_check_step_fails_workflow_on_illegal_move():
    """If rules_check detects an illegal move, the workflow status is 'failed'
    and steps after rules_check stay pending."""
    runners = {sid: lambda ctx, step: None for sid in kw.STEP_IDS}
    runners["audit_append"] = lambda ctx, step, *, workflow: None

    def _inject_bad_record(ctx, step):
        ctx.game_record = {
            "match_length": 1,
            # 8/3 is not legal on dice (3, 1).
            "moves": [{"turn": 0, "dice": [3, 1], "move": "8/3"}],
            "final_position_id": "FINAL",
        }

    runners["og_storage_fetch"] = _inject_bad_record
    del runners["rules_check"]

    wf = kw.run_workflow("99", runners=runners)
    assert wf.status == "failed"
    rules_step = next(s for s in wf.steps if s.id == "rules_check")
    assert rules_step.status == "failed"
    assert "violates backgammon rules" in (rules_step.error or "")
    # gnubg_replay and later steps must still be pending.
    subsequent = [s for s in wf.steps
                  if list(kw.STEP_IDS).index(s.id) > list(kw.STEP_IDS).index("rules_check")]
    assert all(s.status == "pending" for s in subsequent)
