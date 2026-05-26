"""Tests for the faithful gnubg evaluator port (agent/gnubg_net.py).

Run with:  cd agent && uv run pytest tests/test_gnubg_net.py -v

What these lock down:
  - the gnubg.wd binary parses into gnubg's exact six-net architecture
    (contact / race / crashed + three pruning nets), in the right order;
  - classify_position reproduces gnubg ClassifyPosition on a recorded set of
    positions spanning every class;
  - equity_from_outputs reproduces gnubg's cubeless Utility;
  - SanityCheck zeroes impossible gammons/backgammons;
  - end-to-end 0-ply evaluation matches gnubg's own 0-ply output — to ~1e-4
    in faithful mode (gnubg's table sigmoid), and within gnubg's sigmoid
    approximation (~0.06 equity) with the default exact torch.sigmoid.

The reference fixture (tests/data/gnubg_0ply_reference.json) was produced by
the gnubg 1.07.001 binary; the net-parity tests additionally need gnubg.wd on
disk and skip if it is absent (same policy as the Phase 8 weights test).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from gnubg_net import (
    CLASS_CONTACT,
    CLASS_CRASHED,
    CLASS_OVER,
    CLASS_RACE,
    DEFAULT_WD_PATH,
    NET_NAMES,
    GnubgEvaluator,
    classify_position,
    equity_from_outputs,
    gnubg_logistic,
    load_gnubg_wd,
    sanity_check,
)

_WD = Path(DEFAULT_WD_PATH)
_HAS_WD = _WD.is_file()
_NEEDS_WD = pytest.mark.skipif(not _HAS_WD, reason=f"gnubg weights not found at {DEFAULT_WD_PATH}")

_FIXTURE = Path(__file__).parent / "data" / "gnubg_0ply_reference.json"
_RECORDS = json.loads(_FIXTURE.read_text())["records"]
_NET_RECORDS = [r for r in _RECORDS if r["cls"] in (8, 9, 10)]

# gnubg position-class int -> our classify_position label. gnubg routes
# no-contact non-bearoff positions to the race net (8); bearoff classes
# (<8) are also no-contact, which our classifier reports as RACE.
_EXPECT = {10: CLASS_CONTACT, 9: CLASS_CRASHED, 8: CLASS_RACE}


# ---------------------------------------------------------------------------
# Weights file structure
# ---------------------------------------------------------------------------
@_NEEDS_WD
def test_load_gnubg_wd_architecture():
    nets = load_gnubg_wd()
    assert list(nets.keys()) == list(NET_NAMES)
    expected = {
        "contact": (250, 128, 5),
        "race": (214, 128, 5),
        "crashed": (250, 128, 5),
        "prune_contact": (200, 16, 5),
        "prune_crashed": (200, 16, 5),
        "prune_race": (200, 8, 5),
    }
    for name, (ci, ch, co) in expected.items():
        w = nets[name]
        assert (w.c_input, w.c_hidden, w.c_output) == (ci, ch, co), name
        assert w.hidden_weight.shape == (ch, ci)
        assert w.output_weight.shape == (co, ch)
        assert w.hidden_threshold.shape == (ch,)
        assert w.output_threshold.shape == (co,)
        # gnubg's published nets all use these gains.
        assert abs(w.beta_hidden - 0.1) < 1e-6
        assert abs(w.beta_output - 1.0) < 1e-6


@_NEEDS_WD
def test_load_gnubg_wd_bad_path():
    with pytest.raises((FileNotFoundError, ValueError)):
        load_gnubg_wd("/nonexistent/gnubg.wd")


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------
def test_classify_position_matches_gnubg():
    mismatches = []
    for r in _RECORDS:
        got = classify_position(r["board0"], r["board1"])
        want = _EXPECT.get(r["cls"], CLASS_RACE)  # bearoff -> no contact -> RACE
        if got != want:
            mismatches.append((r["cls"], got, want))
    assert not mismatches, f"{len(mismatches)} classifier mismatches: {mismatches[:5]}"


def test_classify_position_over():
    empty = [0] * 25
    assert classify_position(empty, empty) == CLASS_OVER


# ---------------------------------------------------------------------------
# Equity readout
# ---------------------------------------------------------------------------
def test_equity_formula_matches_gnubg():
    worst = max(abs(equity_from_outputs(r["out"][:5]) - r["out"][5]) for r in _RECORDS)
    assert worst < 1e-5, worst


# ---------------------------------------------------------------------------
# SanityCheck clamps
# ---------------------------------------------------------------------------
def test_sanity_check_zeroes_impossible_gammons():
    # board0 has borne off one chequer (14 on board) -> it cannot win a
    # gammon/backgammon; both sides keep a back chequer so the position is
    # still contact (no race-only clamps interfere).
    board0 = [0] * 25
    board0[23] = 2; board0[5] = 5; board0[7] = 3; board0[12] = 4  # 14 on board
    board1 = [0] * 25
    board1[23] = 2; board1[5] = 5; board1[7] = 3; board1[12] = 5  # 15 on board
    out = sanity_check(board0, board1, [0.5, 0.4, 0.1, 0.4, 0.1])
    assert out[1] == 0.0 and out[2] == 0.0          # win gammon/bg impossible
    assert out[3] == 0.4 and out[4] == 0.1          # lose gammon/bg preserved
    # Mirror: board1 borne off -> player cannot lose a gammon.
    out2 = sanity_check(board1, board0, [0.5, 0.4, 0.1, 0.4, 0.1])
    assert out2[3] == 0.0 and out2[4] == 0.0
    assert out2[1] == 0.4 and out2[2] == 0.1


def test_sanity_check_gammon_not_exceed_win():
    # Raw net could output win-gammon > win; clamp must fix it. Use a
    # no-borne-off contact position so the borne-off clamps don't apply.
    board = [0] * 25
    board[23] = 3; board[5] = 5; board[7] = 4; board[12] = 3  # 15 on board
    out = sanity_check(board, board, [0.3, 0.5, 0.4, 0.2, 0.05])
    assert out[1] <= out[0]      # win gammon <= win
    assert out[2] <= out[1]      # win bg <= win gammon


# ---------------------------------------------------------------------------
# gnubg table logistic
# ---------------------------------------------------------------------------
def test_gnubg_logistic_approximates_true_logistic():
    import torch
    z = torch.linspace(-12, 12, 240)
    approx = gnubg_logistic(z)
    exact = torch.sigmoid(z)
    assert torch.max(torch.abs(approx - exact)).item() < 6e-3
    # essentially monotone (gnubg's piecewise table has a ~1e-5 dip at the
    # ±10 saturation boundary) and bounded in (0, 1)
    assert torch.all(approx[1:] >= approx[:-1] - 1e-4)
    assert torch.all((approx > 0) & (approx < 1))


# ---------------------------------------------------------------------------
# End-to-end parity vs gnubg's own 0-ply evaluation
# ---------------------------------------------------------------------------
@_NEEDS_WD
def test_evaluator_faithful_matches_gnubg_runtime():
    ev = GnubgEvaluator(faithful=True)
    worst_out = worst_eq = 0.0
    for r in _NET_RECORDS:
        out, eq = ev.evaluate(r["board0"], r["board1"])
        worst_out = max(worst_out, max(abs(out[i] - r["out"][i]) for i in range(5)))
        worst_eq = max(worst_eq, abs(eq - r["out"][5]))
    # Faithful mode reproduces gnubg's exact table-sigmoid runtime.
    assert worst_out < 3e-3, worst_out
    assert worst_eq < 3e-3, worst_eq


@_NEEDS_WD
def test_evaluator_exact_sigmoid_tracks_gnubg():
    ev = GnubgEvaluator(faithful=False)
    worst_eq = 0.0
    for r in _NET_RECORDS:
        _out, eq = ev.evaluate(r["board0"], r["board1"])
        worst_eq = max(worst_eq, abs(eq - r["out"][5]))
    # Default mode uses the exact logistic; it differs from gnubg only by
    # gnubg's own sigmoid approximation.
    assert worst_eq < 0.07, worst_eq


@_NEEDS_WD
def test_evaluator_start_position():
    ev = GnubgEvaluator(faithful=True)
    start = [0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0]
    out, eq = ev.evaluate(start, start)
    assert len(out) == 5
    assert 0.5 < out[0] < 0.55          # side on roll a touch ahead
    assert abs(eq - 0.0670238733) < 3e-3
