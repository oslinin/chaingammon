"""
backgammon/env.py — Board state and rules engine.

Coordinate system
-----------------
Points 0–23.  White moves 0→23; home board 18–23; bears off past 23.
              Black moves 23→0; home board 0–5;  bears off past 0 (to -1).
board[p] > 0  White checkers on point p.
board[p] < 0  Black checkers on point p.
bar[0]/off[0] White.  bar[1]/off[1] Black.
turn          0=White, 1=Black.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

# Sentinel for "entering from bar"
BAR: int = -1

# (source_point_or_BAR, die_used)
Move = Tuple[int, int]
MoveSeq = List[Move]


@dataclass
class GameState:
    """Full backgammon position."""

    board: List[int]  # 24 ints; +White / -Black
    bar: List[int]    # [white_on_bar, black_on_bar]
    off: List[int]    # [white_borne_off, black_borne_off]
    turn: int         # 0=White, 1=Black

    def copy(self) -> "GameState":
        return GameState(
            board=self.board[:],
            bar=self.bar[:],
            off=self.off[:],
            turn=self.turn,
        )


# ── Starting position ────────────────────────────────────────────────────────

def starting_state() -> GameState:
    """Standard opening: White 2@0, 5@11, 3@16, 5@18; Black mirrored."""
    board = [0] * 24
    board[0] = 2;  board[11] = 5;  board[16] = 3;  board[18] = 5
    board[23] = -2; board[12] = -5; board[7]  = -3; board[5]  = -5
    return GameState(board=board, bar=[0, 0], off=[0, 0], turn=0)


# ── Internal helpers ─────────────────────────────────────────────────────────

def _all_in_home(state: GameState, player: int) -> bool:
    """True iff every checker for *player* is in their home board (not on bar)."""
    if state.bar[player] > 0:
        return False
    if player == 0:          # White home: 18–23
        return not any(state.board[p] > 0 for p in range(18))
    else:                    # Black home: 0–5
        return not any(state.board[p] < 0 for p in range(6, 24))


def _can_land(board: List[int], dst: int, player: int) -> bool:
    """True iff *player* can land on *dst* (opponent has ≤1 checker there)."""
    # sign is +1 for White, -1 for Black
    sign = 1 if player == 0 else -1
    return board[dst] * sign >= -1


def _can_bearoff(state: GameState, src: int, die: int, player: int) -> bool:
    """True iff *player* may bear a checker off from *src* using *die*."""
    if player == 0:
        dst = src + die
        if dst == 24:
            return True                      # exact
        if dst > 24:                         # overshoot: no White checker farther back
            return not any(state.board[p] > 0 for p in range(18, src))
    else:
        dst = src - die
        if dst == -1:
            return True                      # exact
        if dst < -1:                         # overshoot: no Black checker farther back
            return not any(state.board[p] < 0 for p in range(src + 1, 6))
    return False


def _apply_single(state: GameState, src: int, die: int) -> GameState:
    """Return a new GameState after one checker move (src=BAR to enter)."""
    s = state.copy()
    p = s.turn
    sign = 1 if p == 0 else -1

    if src == BAR:
        s.bar[p] -= 1
        dst = die - 1 if p == 0 else 24 - die
    else:
        s.board[src] -= sign
        dst = src + die if p == 0 else src - die

    if 0 <= dst <= 23:
        if s.board[dst] * sign == -1:       # hit a blot
            s.board[dst] = 0
            s.bar[1 - p] += 1
        s.board[dst] += sign
    else:
        s.off[p] += 1                        # bore off
    return s


def _enumerate(
    state: GameState,
    dice: List[int],
    used: MoveSeq,
) -> List[Tuple[GameState, MoveSeq]]:
    """Recursively enumerate all ways to spend *dice* from *state*."""
    if not dice:
        return [(state, used)]

    p = state.turn
    sign = 1 if p == 0 else -1
    results: List[Tuple[GameState, MoveSeq]] = []
    tried: set = set()
    has_bar = state.bar[p] > 0
    all_home = _all_in_home(state, p)

    for i, die in enumerate(dice):
        if die in tried:
            continue
        tried.add(die)
        remaining = dice[:i] + dice[i + 1:]

        if has_bar:
            dst = die - 1 if p == 0 else 24 - die
            if 0 <= dst <= 23 and _can_land(state.board, dst, p):
                ns = _apply_single(state, BAR, die)
                results.extend(_enumerate(ns, remaining, used + [(BAR, die)]))
        else:
            for src in range(24):
                if state.board[src] * sign <= 0:
                    continue
                dst = src + die if p == 0 else src - die

                if 0 <= dst <= 23:
                    if _can_land(state.board, dst, p):
                        ns = _apply_single(state, src, die)
                        results.extend(_enumerate(ns, remaining, used + [(src, die)]))
                elif all_home and _can_bearoff(state, src, die, p):
                    ns = _apply_single(state, src, die)
                    results.extend(_enumerate(ns, remaining, used + [(src, die)]))

    return results or [(state, used)]   # empty → forced pass


# ── Public API ───────────────────────────────────────────────────────────────

def legal_move_sequences(
    state: GameState,
    dice: Tuple[int, int],
) -> List[Tuple[GameState, MoveSeq]]:
    """All legal move sequences for the current player.

    Returns a deduplicated list of (resulting_state, [(src, die), ...]).
    Applies the maximum-dice and larger-die-when-one rules.
    """
    dice_list = [dice[0]] * 4 if dice[0] == dice[1] else list(dice)
    seqs = _enumerate(state, dice_list, [])

    # Keep only max-length sequences.
    max_len = max(len(seq) for _, seq in seqs)
    seqs = [(s, seq) for s, seq in seqs if len(seq) == max_len]

    # When only one die is playable (non-double), prefer the larger die.
    if max_len == 1 and len(dice_list) == 2:
        larger = max(dice_list)
        bigger = [(s, seq) for s, seq in seqs if seq[0][1] == larger]
        if bigger:
            seqs = bigger

    # Deduplicate by resulting board position.
    seen: set = set()
    unique: List[Tuple[GameState, MoveSeq]] = []
    for s, seq in seqs:
        key = (tuple(s.board), s.bar[0], s.bar[1], s.off[0], s.off[1])
        if key not in seen:
            seen.add(key)
            unique.append((s, seq))

    return unique


def is_terminal(state: GameState) -> bool:
    """True iff one side has borne off all 15 checkers."""
    return state.off[0] == 15 or state.off[1] == 15


def game_outcome(state: GameState) -> Tuple[int, int]:
    """Return (winner, multiplier) — call only when is_terminal is True.

    winner     0=White, 1=Black.
    multiplier 1=single, 2=gammon, 3=backgammon.
    """
    winner, loser = (0, 1) if state.off[0] == 15 else (1, 0)

    if state.off[loser] > 0:
        return winner, 1

    # Loser borne off zero → at least gammon.
    if state.bar[loser] > 0:
        return winner, 3      # loser on bar → backgammon

    # Backgammon if loser still in winner's home board.
    if winner == 0:
        if any(state.board[p] < 0 for p in range(18, 24)):
            return winner, 3
    else:
        if any(state.board[p] > 0 for p in range(0, 6)):
            return winner, 3

    return winner, 2
