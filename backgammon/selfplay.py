"""
backgammon/selfplay.py — Self-play game runner and TD(λ) updater.

play_game        Run one complete game; return a Trajectory.
td_lambda_update  Apply one TD(λ) gradient step from the trajectory.
"""

from __future__ import annotations

import random as _random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, List

import numpy as np
import torch
import torch.nn.functional as F

from backgammon.encode import encode_state
from backgammon.env import (
    GameState,
    game_outcome,
    is_terminal,
    legal_move_sequences,
    starting_state,
)

if TYPE_CHECKING:
    from backgammon.agent import NetAgent, RandomAgent
    from backgammon.net import BackgammonNet

_MAX_HALF_MOVES = 3000   # safety cap to prevent infinite loops


@dataclass
class Trajectory:
    """Sequence of encoded board states visited during one game."""

    states: List[torch.Tensor] = field(default_factory=list)
    target: torch.Tensor = field(default_factory=lambda: torch.zeros(4))
    total_moves: int = 0


def play_game(
    white_agent: "NetAgent | RandomAgent",
    black_agent: "NetAgent | RandomAgent",
    rng_py: _random.Random,
    rng_np: np.random.Generator,
) -> Trajectory:
    """Play one full game and return the trajectory of encoded states.

    Opening roll: re-roll until non-doubles; higher die plays first.
    States are encoded from White's perspective (turn flag set correctly).
    """
    state = starting_state()

    # Opening roll — no doubles.
    while True:
        d_w = rng_py.randint(1, 6)
        d_b = rng_py.randint(1, 6)
        if d_w != d_b:
            break

    state.turn = 0 if d_w > d_b else 1
    first_dice = (max(d_w, d_b), min(d_w, d_b))

    agents = [white_agent, black_agent]
    traj = Trajectory()

    def _step(dice: tuple) -> None:
        seqs = legal_move_sequences(state, dice)
        traj.states.append(encode_state(state))
        if seqs and seqs[0][1]:               # has real moves (not forced pass)
            result, _ = agents[state.turn].pick_move(state, seqs)
            # Copy fields back in-place so the outer reference stays valid.
            state.board[:] = result.board
            state.bar[:] = result.bar
            state.off[:] = result.off
        state.turn = 1 - state.turn
        traj.total_moves += 1

    _step(first_dice)

    while not is_terminal(state) and traj.total_moves < _MAX_HALF_MOVES:
        d1 = int(rng_np.integers(1, 7))
        d2 = int(rng_np.integers(1, 7))
        _step((d1, d2))

    # Build terminal target vector (White's perspective).
    if is_terminal(state):
        winner, mult = game_outcome(state)
    else:
        winner, mult = 0, 1     # hit safety cap — treat as White single win

    if winner == 0:
        target = [1.0, float(mult >= 2), 0.0, 0.0]
    else:
        target = [0.0, 0.0, 1.0, float(mult >= 2)]

    traj.target = torch.tensor(target, dtype=torch.float32)
    return traj


def td_lambda_update(
    net: "BackgammonNet",
    optimizer: torch.optim.Optimizer,
    traj: Trajectory,
    lam: float = 0.7,
) -> float:
    """One TD(λ) gradient step.

    Backward sweep computes λ-returns toward the terminal target,
    then minimises MSE with a single optimizer step.

    Returns the scalar loss value.
    """
    states = traj.states
    T = len(states)
    if T == 0:
        return 0.0

    state_batch = torch.stack(states)   # [T, 198]

    # Detached predictions for λ-return computation.
    with torch.no_grad():
        preds_detached = net(state_batch)  # [T, 4]

    # Backward sweep: G[T-1] = z, G[t] = (1-λ)·V(s_{t+1}) + λ·G[t+1]
    targets = torch.zeros(T, 4)
    G = traj.target.clone()
    for t in range(T - 1, -1, -1):
        targets[t] = G
        if t > 0:
            G = (1.0 - lam) * preds_detached[t] + lam * G

    # Single forward pass + optimizer step.
    preds = net(state_batch)
    loss = F.mse_loss(preds, targets)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()

    return loss.item()
