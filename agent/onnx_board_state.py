"""onnx_board_state.py — gnubg-free full-board training environment.

Drop-in replacement for the gnubg-backed FullBoardState path.  Uses:
  - rules_engine.Board + OPENING_BOARD for position representation
  - A pure-Python move generator (no subprocess required)
  - onnxruntime + backgammon_net.onnx as the frozen opponent evaluator

OnnxBoardState has the same public surface as FullBoardState so
sample_trainer's td_lambda_match/evaluate loops work unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import torch

from rules_engine import (
    OPENING_BOARD,
    Board,
    all_in_home,
    has_pieces_on_bar,
)

# ---------------------------------------------------------------------------
# Single-die move generation
# ---------------------------------------------------------------------------

# Sentinel values matching rules_engine conventions.
_BAR0 = 25   # bar source for side 0
_BAR1 = 0    # bar source for side 1
_OFF0 = 0    # bear-off destination for side 0
_OFF1 = 25   # bear-off destination for side 1


def _single_die_moves(
    board: Board, die: int, side: int
) -> list[tuple[int, int, bool]]:
    """All legal single-die moves as (src, dst, is_hit) triples.

    dst=0 / src=25  — side-0 bear-off / bar entry sentinel
    dst=25 / src=0  — side-1 bear-off / bar entry sentinel
    """
    results: list[tuple[int, int, bool]] = []

    if has_pieces_on_bar(board, side):
        # Must enter from the bar before any other move.
        if side == 0:
            dst = 25 - die        # point die places us on (25-die)
            if 1 <= dst <= 24:
                cnt = board.points[dst - 1]
                if cnt >= -1:     # not blocked
                    results.append((_BAR0, dst, cnt == -1))
        else:
            dst = die             # side 1 enters on point die
            if 1 <= dst <= 24:
                cnt = board.points[dst - 1]
                if cnt <= 1:
                    results.append((_BAR1, dst, cnt == 1))
        return results

    # Regular moves from the board.
    if side == 0:
        for i in range(24):
            if board.points[i] <= 0:
                continue
            src = i + 1           # 1-indexed
            dst = src - die
            if dst >= 1:
                cnt = board.points[dst - 1]
                if cnt >= -1:
                    results.append((src, dst, cnt == -1))
            else:
                # Bear-off attempt.
                if not all_in_home(board, 0):
                    continue
                if dst == 0:      # exact pip
                    results.append((src, _OFF0, False))
                else:             # overshoot: no checker on a higher point
                    if all(board.points[j] <= 0 for j in range(src, 24)):
                        results.append((src, _OFF0, False))
    else:
        for i in range(24):
            if board.points[i] >= 0:
                continue
            src = i + 1
            dst = src + die
            if dst <= 24:
                cnt = board.points[dst - 1]
                if cnt <= 1:
                    results.append((src, dst, cnt == 1))
            else:
                if not all_in_home(board, 1):
                    continue
                if dst == 25:
                    results.append((src, _OFF1, False))
                else:             # overshoot
                    if all(board.points[j] >= 0 for j in range(0, src - 1)):
                        results.append((src, _OFF1, False))

    return results


def _apply_single(board: Board, side: int, src: int, dst: int) -> Board:
    """Apply one checker movement and return the resulting board."""
    pts = list(board.points)
    bar = list(board.bar)
    off = list(board.off)

    # Lift.
    if side == 0:
        if src == _BAR0:
            bar[0] -= 1
        else:
            pts[src - 1] -= 1
    else:
        if src == _BAR1:
            bar[1] -= 1
        else:
            pts[src - 1] += 1   # remove one negative checker

    # Place.
    if side == 0:
        if dst == _OFF0:
            off[0] += 1
        else:
            if pts[dst - 1] == -1:   # hit
                pts[dst - 1] = 1
                bar[1] += 1
            else:
                pts[dst - 1] += 1
    else:
        if dst == _OFF1:
            off[1] += 1
        else:
            if pts[dst - 1] == 1:    # hit
                pts[dst - 1] = -1
                bar[0] += 1
            else:
                pts[dst - 1] -= 1

    return Board(points=tuple(pts), bar=tuple(bar), off=tuple(off))


# ---------------------------------------------------------------------------
# Full move-sequence enumeration
# ---------------------------------------------------------------------------

def _all_completions(
    board: Board,
    pool: list[int],
    side: int,
    pieces: list[tuple[int, int, bool, int]],
) -> list[tuple[Board, list[tuple[int, int, bool, int]]]]:
    """Recursively exhaust `pool`, returning (final_board, pieces_list).

    Each piece is (src, dst, is_hit, die_used).
    """
    if not pool:
        return [(board, pieces)]

    found_any = False
    results: list[tuple[Board, list[tuple[int, int, bool, int]]]] = []
    tried_dice: set[int] = set()

    for i, die in enumerate(pool):
        if die in tried_dice:
            continue
        tried_dice.add(die)
        singles = _single_die_moves(board, die, side)
        if not singles:
            continue
        found_any = True
        remaining = pool[:i] + pool[i + 1:]
        for src, dst, is_hit in singles:
            new_board = _apply_single(board, side, src, dst)
            sub = _all_completions(new_board, remaining, side, pieces + [(src, dst, is_hit, die)])
            results.extend(sub)

    if not found_any:
        return [(board, pieces)]

    return results


def _piece_str(src: int, dst: int, is_hit: bool, side: int) -> str:
    if side == 0:
        s = "bar" if src == _BAR0 else str(src)
        d = "off" if dst == _OFF0 else str(dst)
    else:
        s = "bar" if src == _BAR1 else str(src)
        d = "off" if dst == _OFF1 else str(dst)
    return f"{s}/{d}{'*' if is_hit else ''}"


def generate_legal_moves(
    board: Board, dice: tuple[int, int], side: int
) -> list[tuple[Board, str]]:
    """All distinct legal complete moves as (resulting_board, move_str) pairs.

    Enforces:
    - Must use the maximum number of dice possible.
    - When only one die can be used and the two dice differ, must use the higher.
    """
    d1, d2 = dice
    pool = [d1, d1, d1, d1] if d1 == d2 else [d1, d2]

    completions = _all_completions(board, pool, side, [])

    # Prune to max dice used.
    if not completions:
        return []
    max_used = max(len(p) for _, p in completions)
    completions = [(b, p) for b, p in completions if len(p) == max_used]

    # If only one die used and dice differ, must use the higher.
    if max_used == 1 and d1 != d2:
        higher = max(d1, d2)
        completions = [(b, p) for b, p in completions if p[0][3] == higher]

    # De-duplicate by resulting board position.
    seen: set[tuple] = set()
    result: list[tuple[Board, str]] = []
    for final_board, pieces in completions:
        key = (final_board.points, final_board.bar, final_board.off)
        if key in seen:
            continue
        seen.add(key)
        move_str = " ".join(_piece_str(s, d, h, side) for s, d, h, _ in pieces)
        result.append((final_board, move_str))

    return result


# ---------------------------------------------------------------------------
# Board state
# ---------------------------------------------------------------------------

@dataclass
class OnnxBoardState:
    """Full-board game state driven by pure Python (no gnubg subprocess).

    Public surface matches FullBoardState so td_lambda_match and
    evaluate work without modification.
    """
    _board: Board
    turn: int
    n_turns: int = 0
    dice: Optional[tuple[int, int]] = None

    # Accessors that match FullBoardState's attribute names so encode_state
    # (which reads state.board / state.bar / state.off) works unchanged.
    @property
    def board(self) -> list[int]:
        return list(self._board.points)

    @property
    def bar(self) -> list[int]:
        return list(self._board.bar)

    @property
    def off(self) -> list[int]:
        return list(self._board.off)

    def terminal(self) -> bool:
        return (
            self._board.off[0] == 15
            or self._board.off[1] == 15
            or self.n_turns >= 200
        )

    def winner(self) -> Optional[int]:
        if self._board.off[0] == 15:
            return 0
        if self._board.off[1] == 15:
            return 1
        return None

    @classmethod
    def initial(cls) -> "OnnxBoardState":
        return cls(_board=OPENING_BOARD, turn=0, n_turns=0)


def legal_successors_onnx(
    state: OnnxBoardState, dice: tuple[int, int]
) -> list[OnnxBoardState]:
    """Enumerate successor states for `state` rolling `dice`."""
    moves = generate_legal_moves(state._board, dice, state.turn)
    if not moves:
        # Forced pass (e.g. no entry from bar).
        return [OnnxBoardState(
            _board=state._board,
            turn=1 - state.turn,
            n_turns=state.n_turns + 1,
        )]
    return [
        OnnxBoardState(
            _board=new_board,
            turn=1 - state.turn,
            n_turns=state.n_turns + 1,
        )
        for new_board, _ in moves
    ]


# ---------------------------------------------------------------------------
# ONNX opponent
# ---------------------------------------------------------------------------

_DEFAULT_ONNX_MODEL = (
    Path(__file__).resolve().parent.parent
    / "frontend" / "public" / "backgammon_net.onnx"
)


class OnnxOpponent:
    """Pre-trained ONNX evaluator used as the frozen opponent.

    Implements the same callable interface as BackgammonNet so
    pick_move can route evaluations through it transparently.
    """

    extras = None   # tells pick_move not to pass extras

    def __init__(self, model_path: Path | str | None = None) -> None:
        import onnxruntime as ort
        path = str(model_path or _DEFAULT_ONNX_MODEL)
        self.session = ort.InferenceSession(
            path, providers=["CPUExecutionProvider"]
        )

    def __call__(self, feats: torch.Tensor, ext=None) -> torch.Tensor:
        arr = feats.detach().numpy().astype("float32")
        out = self.session.run(None, {"board": arr})[0]
        t = torch.tensor(out, dtype=torch.float32)
        return t.squeeze(-1) if t.ndim > 1 else t

    def parameters(self):  # no learnable params
        return iter([])

    def eval(self):
        return self

    def train(self, mode: bool = True):
        return self
