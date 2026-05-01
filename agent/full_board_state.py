"""
full_board_state.py — drop-in replacement for RaceState that drives
self-play through real gnubg subprocesses.

Phase J.2. Same shape as `agent/sample_trainer.RaceState` (terminal,
winner, n_turns, turn) so `td_lambda_match` can train against full-
board positions without code changes — only the encoder + state
class swap.

Usage in the trainer:
    from full_board_state import FullBoardState, legal_successors_full
    from gnubg_encoder import encode_full_board

    state = FullBoardState.initial(gnubg_client)
    while not state.terminal():
        d1, d2 = roll_dice(...)
        cands = legal_successors_full(state, (d1, d2), gnubg_client)
        ...

Latency note: every `legal_successors_full` call shells out to gnubg
once per candidate enumeration + once per submit_move per successor.
A 60-ply game with ~5 candidates per turn = ~300-600 subprocess
invocations. Acceptable for an off-line training run; heavy for
interactive demos. A future iteration could keep gnubg alive across
calls (long-running engine) to amortize startup cost.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FullBoardState:
    """Mirrors `RaceState`'s public surface so td_lambda_match works
    without changes. The position itself is identified by gnubg's
    canonical (position_id, match_id) pair; the human-readable board
    fields are caches populated by gnubg.decode_board for the encoder."""

    position_id: str
    match_id: str
    board: list[int]
    bar: list[int]
    off: list[int]
    turn: int
    dice: Optional[tuple[int, int]] = None
    n_turns: int = 0
    game_over: bool = False
    winner_idx: Optional[int] = None

    def terminal(self) -> bool:
        """True when gnubg's match_id encodes game-over OR we exceed
        a sanity-check turn cap. The cap is generous (200 turns) —
        real backgammon games end in ~50-80 turns; the cap only fires
        on degenerate self-play loops."""
        return bool(self.game_over) or self.n_turns >= 200

    def winner(self) -> Optional[int]:
        return self.winner_idx

    @classmethod
    def initial(cls, gnubg_client) -> "FullBoardState":
        """Spawn a fresh match at the canonical opening position."""
        res = gnubg_client.new_match(length=1)
        if not res.get("position_id") or not res.get("match_id"):
            raise RuntimeError(f"gnubg.new_match failed: {res}")
        return _state_from_gnubg(
            gnubg_client, res["position_id"], res["match_id"], n_turns=0,
        )


def _state_from_gnubg(
    gnubg_client,
    position_id: str,
    match_id: str,
    *,
    n_turns: int,
) -> FullBoardState:
    """Decode gnubg's authoritative board from (pos, match) and
    construct a FullBoardState. Keeps the conversion in one place so
    callers don't have to reach into gnubg_client semantics."""
    decoded = gnubg_client.decode_board(position_id, match_id)
    board = list(decoded["points"])
    bar = list(decoded["bar"])
    p0_total = sum(c for c in board if c > 0) + bar[0]
    p1_total = -sum(c for c in board if c < 0) + bar[1]
    off = [15 - p0_total, 15 - p1_total]

    # Decode match_id for turn / game_over / winner. Late import to
    # avoid pulling server.app into tests that just exercise FullBoardState.
    from gnubg_state import decode_match_id

    info = decode_match_id(match_id)
    game_over = bool(info.get("game_over", False))
    turn = int(info.get("turn", 0))
    winner: Optional[int] = None
    if game_over:
        score = info.get("score", [0, 0])
        winner = 1 if score[1] > score[0] else 0
    return FullBoardState(
        position_id=position_id,
        match_id=match_id,
        board=board,
        bar=bar,
        off=off,
        turn=turn,
        dice=info.get("dice"),
        n_turns=n_turns,
        game_over=game_over,
        winner_idx=winner,
    )


def legal_successors_full(
    state: FullBoardState,
    dice: tuple[int, int],
    gnubg_client,
) -> list[FullBoardState]:
    """Enumerate every legal successor state for `state` rolling `dice`.

    Drops to gnubg twice per candidate: once to enumerate (via
    get_candidate_moves), once to submit each move (via submit_move)
    and read the resulting board back. The submit_move call is what
    makes the operation expensive — there's currently no `apply_move`
    that returns the post-position without committing it.
    """
    candidates = gnubg_client.get_candidate_moves(state.position_id, state.match_id)
    if not candidates:
        # No legal moves (bar dance) — gnubg's own turn-skip is the
        # successor. Submit an empty move to advance the turn.
        skip = gnubg_client.submit_move(state.position_id, state.match_id, "")
        return [_state_from_gnubg(
            gnubg_client,
            skip.get("position_id", state.position_id),
            skip.get("match_id", state.match_id),
            n_turns=state.n_turns + 1,
        )]

    successors: list[FullBoardState] = []
    for cand in candidates:
        move_str = cand.get("move", "")
        if not move_str:
            continue
        res = gnubg_client.submit_move(state.position_id, state.match_id, move_str)
        if not res.get("position_id") or not res.get("match_id"):
            # Skip moves gnubg refuses — the candidate list shouldn't
            # contain any but defend in depth.
            continue
        successors.append(_state_from_gnubg(
            gnubg_client,
            res["position_id"],
            res["match_id"],
            n_turns=state.n_turns + 1,
        ))
    return successors
