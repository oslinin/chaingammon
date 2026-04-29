"""
backgammon/agent.py — Agent implementations.

NetAgent   one-ply lookahead using BackgammonNet; ε-greedy exploration.
RandomAgent  uniform random move selection (baseline).
"""

from __future__ import annotations

import random
from typing import List, Tuple

import torch

from backgammon.encode import encode_state
from backgammon.env import GameState, MoveSeq
from backgammon.net import BackgammonNet

_Seq = Tuple[GameState, MoveSeq]


class NetAgent:
    """Value-network agent with ε-greedy exploration."""

    def __init__(self, net: BackgammonNet, epsilon: float = 0.05) -> None:
        self.net = net
        self.epsilon = epsilon

    def pick_move(self, state: GameState, sequences: List[_Seq]) -> _Seq:
        """Return the highest-scoring move sequence (ε-random for exploration).

        Score is White equity for White to move, negated for Black to move.
        """
        if not sequences:
            raise ValueError("No sequences provided")

        if random.random() < self.epsilon:
            return random.choice(sequences)

        best_score = float("-inf")
        best = sequences[0]
        with torch.no_grad():
            for result_state, seq in sequences:
                enc = encode_state(result_state).unsqueeze(0)
                out = self.net(enc).squeeze(0)
                eq = BackgammonNet.equity(out).item()
                score = eq if state.turn == 0 else -eq
                if score > best_score:
                    best_score = score
                    best = (result_state, seq)

        return best


class RandomAgent:
    """Uniform random baseline — picks any legal sequence with equal probability."""

    def pick_move(self, state: GameState, sequences: List[_Seq]) -> _Seq:  # noqa: ARG002
        return random.choice(sequences)
