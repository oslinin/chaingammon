"""search.py — expectiminimax search for backgammon agents.

Provides search_2ply, which implements depth-2 expectiminimax: for each
legal move, averages over all 21 opponent dice combinations and takes the
opponent's best response, then picks the move with the highest expected
equity. Used by td_lambda_match when search_depth >= 2.
"""
from __future__ import annotations

from typing import Any, Callable

import torch

# All 21 unique (d1, d2) pairs with d1 <= d2 and their roll probabilities.
ALL_DICE_COMBOS: list[tuple[tuple[int, int], float]] = [
    ((d1, d2), 1 / 36 if d1 == d2 else 2 / 36)
    for d1 in range(1, 7)
    for d2 in range(d1, 7)
]


def search_2ply(
    state: Any,
    dice: tuple[int, int],
    eval_fn: Callable[[torch.Tensor], torch.Tensor],
    perspective: int = 0,
) -> tuple[Any, float]:
    """Pick the best move via 2-ply expectiminimax.

    eval_fn(feats) -> equities
      feats:    float32 Tensor[N, 198]
      equities: float32 Tensor[N] — equity from `perspective`'s point of view.

    Returns (chosen_successor_state, 2ply_value).
    Opponent minimises `perspective`'s equity; dice combos are weighted by
    their probability (doubles 1/36, non-doubles 2/36).
    """
    from sample_trainer import encode_state, legal_successors

    my_successors = legal_successors(state, dice)
    best_state = my_successors[0]
    best_value = -1.0

    for s in my_successors:
        if s.terminal():
            v = 1.0 if s.winner() == perspective else 0.0
        else:
            v = 0.0
            for (od1, od2), prob in ALL_DICE_COMBOS:
                opp_succs = legal_successors(s, (od1, od2))
                feats = torch.stack([encode_state(L, perspective) for L in opp_succs])
                with torch.no_grad():
                    leaf_eq = eval_fn(feats)
                # Override terminal leaves with exact rewards.
                for i, L in enumerate(opp_succs):
                    if L.terminal():
                        leaf_eq = leaf_eq.clone()
                        leaf_eq[i] = 1.0 if L.winner() == perspective else 0.0
                v += prob * leaf_eq.min().item()

        if v > best_value:
            best_value = v
            best_state = s

    return best_state, best_value
