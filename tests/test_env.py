"""tests/test_env.py — Unit tests for backgammon/env.py."""

import random

import pytest

from backgammon.env import (
    BAR,
    GameState,
    game_outcome,
    is_terminal,
    legal_move_sequences,
    starting_state,
)


def _total_checkers(state: GameState, player: int) -> int:
    sign = 1 if player == 0 else -1
    on_board = sum(abs(state.board[p]) for p in range(24) if state.board[p] * sign > 0)
    return on_board + state.bar[player] + state.off[player]


# ── Fixture tests ─────────────────────────────────────────────────────────────

def test_starting_checker_counts():
    state = starting_state()
    assert _total_checkers(state, 0) == 15, "White must have 15 checkers"
    assert _total_checkers(state, 1) == 15, "Black must have 15 checkers"


def test_starting_position_sum():
    """Sum of all board values: positive = White lead (2+5+3+5=15), neg = Black."""
    state = starting_state()
    total = sum(state.board)
    assert total == 0, "Board should be symmetric (sum zero) at start"


# ── Checker conservation ───────────────────────────────────────────────────────

def _play_random_game(seed: int) -> list[GameState]:
    """Play a game with random moves; return all states visited."""
    rng = random.Random(seed)
    state = starting_state()

    while True:
        d1 = rng.randint(1, 6)
        d2 = rng.randint(1, 6)
        state.turn = 0  # alternate later
        break

    states = [state.copy()]
    rng2 = random.Random(seed + 1)
    state.turn = 0

    moves = 0
    while not is_terminal(state) and moves < 3000:
        d1 = rng2.randint(1, 6)
        d2 = rng2.randint(1, 6)
        seqs = legal_move_sequences(state, (d1, d2))
        chosen_state, _ = rng2.choice(seqs)
        state = chosen_state
        state.turn = 1 - state.turn
        states.append(state.copy())
        moves += 1

    return states


def test_checker_conservation_across_rollouts():
    """50 random games: checker counts stay at 15+15 throughout."""
    for seed in range(50):
        visited = _play_random_game(seed)
        for s in visited:
            assert _total_checkers(s, 0) == 15, f"seed={seed} White lost a checker"
            assert _total_checkers(s, 1) == 15, f"seed={seed} Black lost a checker"


def test_all_rollouts_terminate():
    """50 random games all reach a terminal state (is_terminal returns True)."""
    for seed in range(50):
        visited = _play_random_game(seed)
        assert is_terminal(visited[-1]), f"seed={seed} game did not terminate"


# ── Move generation ────────────────────────────────────────────────────────────

def test_roll_31_from_start_gives_at_least_10_sequences():
    state = starting_state()
    state.turn = 0  # White to move
    seqs = legal_move_sequences(state, (3, 1))
    assert len(seqs) >= 10, (
        f"Expected ≥10 candidate sequences for (3,1) from start, got {len(seqs)}"
    )


def test_no_move_from_blocked_board():
    """If every White entry point is blocked by Black, return a pass (empty seq)."""
    state = starting_state()
    state.board = [0] * 24
    state.bar = [1, 0]   # White on bar
    state.turn = 0
    # Block entry points 0..5 with Black (die 1→0, die 2→1, ..., die 6→5)
    for p in range(6):
        state.board[p] = -2
    seqs = legal_move_sequences(state, (1, 2))
    # All sequences should be passes (empty move list)
    assert all(len(seq) == 0 for _, seq in seqs)


def test_bear_off_exact():
    """White can bear off with an exact die roll."""
    state = GameState(board=[0] * 24, bar=[0, 0], off=[14, 15], turn=0)
    state.board[23] = 1   # Last White checker on point 23
    seqs = legal_move_sequences(state, (1, 3))
    # Must bear off (only legal move) and win
    final_states = [s for s, _ in seqs if is_terminal(s)]
    assert final_states, "White should be able to bear off the last checker"


def test_game_outcome_gammon():
    state = GameState(board=[0] * 24, bar=[0, 0], off=[15, 0], turn=0)
    winner, mult = game_outcome(state)
    assert winner == 0
    assert mult == 2  # Black has 0 borne off → gammon


def test_game_outcome_backgammon():
    state = GameState(board=[0] * 24, bar=[0, 1], off=[15, 0], turn=0)
    winner, mult = game_outcome(state)
    assert winner == 0
    assert mult == 3  # Black on bar → backgammon
