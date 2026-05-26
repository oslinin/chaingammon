"""gnubg_search.py — n-ply expectiminimax over the gnubg evaluator.

The search core of mint-helper request #2: a full-gnubg agent that looks
ahead instead of trusting only the static 0-ply position. Move generation
reuses the pure-Python generator in onnx_board_state.py (over
rules_engine.Board); leaf positions are scored by the gnubg evaluator from
agent/gnubg_net.py. No gnubg subprocess is involved.

Plies follow gnubg's checker-play convention. "Evaluating a position at
n-ply" means: 0-ply is the static net; n-ply averages, over the on-roll
side's 21 dice rolls, that side's best move evaluated at (n-1)-ply. Choosing
a move at n-ply (find_best_move) scores each candidate by the opponent's
n-ply equity of the resulting position and takes the move that minimises it
(negamax). So plies=0 is "best static equity after the move" (gnubg's
0-ply), plies=1 is gnubg's 1-ply, and plies=2 is gnubg's default 2-ply.

The evaluator is injected as `eval_fn(board0, board1) -> float` returning the
cubeless equity for the side on roll (board0); `gnubg_eval_fn` wraps a
GnubgEvaluator. This module is the offline reference/validation harness for the
distilled net (see agent/gnubg_distill.py), not the served inference path.
"""
from __future__ import annotations

from typing import Callable

from onnx_board_state import generate_legal_moves
from rules_engine import Board

# The 21 unique dice rolls (d1 <= d2) and their probabilities.
DICE_COMBOS: list[tuple[tuple[int, int], float]] = [
    ((d1, d2), 1 / 36 if d1 == d2 else 2 / 36)
    for d1 in range(1, 7)
    for d2 in range(d1, 7)
]

EvalFn = Callable[[list[int], list[int]], float]


def board_to_tanboard(b: Board, on_roll: int) -> tuple[list[int], list[int]]:
    """Convert a rules_engine.Board to a gnubg TanBoard pair (board0, board1).

    Each side's array is 25 ints from *its own* perspective: index i is that
    side's (i+1)-point (1-point = closest to bearing off), index 24 is the bar.
    board0 is the side on roll. Matches agent/gnubg_net.py's convention.

    rules_engine stores points in side-0's frame (index 0 = the 1-point,
    positive = side 0, negative = side 1) and side 1 moves 1->24, so side 1's
    n-point is board point (25-n) -> array index 23-i.
    """
    side0 = [max(0, b.points[i]) for i in range(24)] + [b.bar[0]]
    side1 = [max(0, -b.points[23 - i]) for i in range(24)] + [b.bar[1]]
    return (side0, side1) if on_roll == 0 else (side1, side0)


def gnubg_eval_fn(evaluator) -> EvalFn:
    """Adapt a GnubgEvaluator to the `eval_fn(board0, board1) -> equity` shape."""
    return lambda board0, board1: evaluator.evaluate(board0, board1)[1]


def static_equity(b: Board, to_move: int, eval_fn: EvalFn) -> float:
    """gnubg's 0-ply cubeless equity for `to_move` in position `b`."""
    if b.off[to_move] >= 15:
        return 1.0
    if b.off[1 - to_move] >= 15:
        return -1.0
    board0, board1 = board_to_tanboard(b, to_move)
    return eval_fn(board0, board1)


def _move_value(child: Board, mover: int, plies: int, eval_fn: EvalFn,
                max_candidates: int | None) -> float:
    """Value to `mover` of having just moved into `child` (opponent on roll),
    evaluating the resulting position at `plies`. Negamax: the opponent's
    equity, negated."""
    if child.off[mover] >= 15:
        return 1.0
    return -eval_position(child, 1 - mover, plies, eval_fn, max_candidates=max_candidates)


def eval_position(b: Board, side: int, plies: int, eval_fn: EvalFn, *,
                  max_candidates: int | None = None) -> float:
    """Expected equity for `side`, who is about to roll, looking `plies` deep.

    plies=0 returns the static 0-ply equity. Otherwise averages over `side`'s
    21 rolls of `side`'s best reply (each evaluated at plies-1)."""
    if b.off[side] >= 15:
        return 1.0
    if b.off[1 - side] >= 15:
        return -1.0
    if plies <= 0:
        return static_equity(b, side, eval_fn)
    total = 0.0
    for dice, prob in DICE_COMBOS:
        succ = generate_legal_moves(b, dice, side)
        if not succ:  # forced pass: opponent to move, one ply consumed
            best = -eval_position(b, 1 - side, plies - 1, eval_fn,
                                  max_candidates=max_candidates)
        else:
            best = max(
                _move_value(child, side, plies - 1, eval_fn, max_candidates)
                for child in _candidates(succ, side, plies - 1, eval_fn, max_candidates)
            )
        total += prob * best
    return total


def _candidates(succ: list[tuple[Board, str]], side: int, child_plies: int,
                eval_fn: EvalFn, max_candidates: int | None) -> list[Board]:
    """The resulting boards to explore. When a deep (plies>=1) search would
    otherwise branch wide, optionally keep only the `max_candidates` boards
    with the best 0-ply value — gnubg's move filter. A heuristic: a move that
    is poor at 0-ply but strong deeper can be pruned, so callers wanting an
    exact search leave max_candidates=None (the default)."""
    boards = [child for child, _ in succ]
    if max_candidates is None or child_plies < 1 or len(boards) <= max_candidates:
        return boards
    boards.sort(key=lambda c: _move_value(c, side, 0, eval_fn, None), reverse=True)
    return boards[:max_candidates]


def find_best_move(b: Board, side: int, dice: tuple[int, int], eval_fn: EvalFn, *,
                   plies: int = 2, max_candidates: int | None = None
                   ) -> tuple[Board | None, str, float]:
    """Pick `side`'s best move for `dice` at `plies` lookahead.

    Returns (resulting_board, gnubg_move_string, equity_for_side). On a forced
    pass returns (None, "", value). `plies` is the gnubg ply count applied to
    the position after the move: 0 = best static equity, 2 = gnubg's default.
    """
    succ = generate_legal_moves(b, dice, side)
    if not succ:
        return None, "", -eval_position(b, 1 - side, plies, eval_fn,
                                        max_candidates=max_candidates)
    cand = succ
    if max_candidates is not None and plies >= 1 and len(succ) > max_candidates:
        cand = sorted(
            succ, key=lambda c: _move_value(c[0], side, 0, eval_fn, None), reverse=True
        )[:max_candidates]

    best_board: Board | None = None
    best_move = ""
    best_val = float("-inf")
    for child, move_str in cand:
        v = _move_value(child, side, plies, eval_fn, max_candidates)
        if v > best_val:
            best_val, best_board, best_move = v, child, move_str
    return best_board, best_move, best_val
