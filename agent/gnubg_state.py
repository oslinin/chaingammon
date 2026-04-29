"""gnubg_state.py — pure bit-unpacking decoders for gnubg ids.

Ported from `server/app/game_state.py` so the AXL agent node is fully
self-contained. NO gnubg subprocess, NO FastAPI here — these helpers
exist so HTTP endpoints can hand back the unified `MatchState` shape
without each one shelling out twice.

The encoding is gnubg's documented bitstream layout (see gnubg manual
§ "Position ID" / "Match ID"). Bits within each byte are little-endian.
"""

from __future__ import annotations

import base64
import re
from typing import TypedDict


class MatchStateDict(TypedDict):
    """Mirrors the frontend `MatchState` interface (see README §
    "Match flow"). Keys are snake_case to match FastAPI defaults; the
    frontend type uses snake_case keys too so the JSON can be consumed
    directly without a renaming pass."""

    position_id: str
    match_id: str
    board: list[int]
    bar: list[int]
    off: list[int]
    turn: int
    dice: list[int] | None
    score: list[int]
    match_length: int
    game_over: bool
    winner: int | None


def decode_position_id(pos_id: str) -> tuple[list[int], list[int], list[int]]:
    """Decode gnubg's base64 position id into a 24-point board with bar
    and off-board counts. Positive integers are player 0 (human / X);
    negative are player 1 (agent / O).

    Returns (board, bar, off) where:
      - board is 24 signed counts in player-0 perspective
      - bar  is [player0_count, player1_count]
      - off  is [player0_count, player1_count]
    """
    b = base64.b64decode(pos_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))

    def parse_player(bits_iter):
        points: list[int] = []
        count = 0
        for _ in range(25):
            while next(bits_iter) == "1":
                count += 1
            points.append(count)
            count = 0
        return points

    bits_iter = iter(bits)
    player0 = parse_player(bits_iter)
    player1 = parse_player(bits_iter)

    board = [0] * 24
    for i in range(24):
        if player0[i] > 0:
            board[i] = player0[i]
        # Player 1's points are mirrored in the player-0 perspective.
        # Must be a separate `if`, not `elif`, since both players can
        # have checkers on different physical points that happen to
        # share an index.
        if player1[i] > 0:
            board[23 - i] = -player1[i]

    p0_on_board = sum(player0)
    p1_on_board = sum(player1)
    bar = [player0[24], player1[24]]
    off = [15 - p0_on_board, 15 - p1_on_board]

    return board, bar, off


def decode_match_id(match_id: str) -> dict:
    """Decode gnubg's base64 match id into a dict of turn/score/cube/
    game-over fields. See gnubg manual for the bit layout; mirrors the
    decoder in server/app/game_state.py with the same human=0 / agent=1
    convention applied (gnubg's raw turn bit is 0=O / 1=X — we invert)."""
    b = base64.b64decode(match_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))

    def get_int(start: int, length: int) -> int:
        sub = bits[start : start + length]
        val = 0
        for i, bit in enumerate(sub):
            if bit == "1":
                val += 1 << i
        return val

    log_cube = get_int(0, 4)
    cube_owner_raw = get_int(4, 2)
    raw_player_on_roll = get_int(6, 1)
    game_state = get_int(8, 3)
    raw_turn = get_int(11, 1)
    dice1 = get_int(15, 3)
    dice2 = get_int(18, 3)
    match_length = get_int(21, 15)
    p0_score = get_int(36, 15)
    p1_score = get_int(51, 15)

    # Invert gnubg's raw turn bit so human=0, agent=1.
    turn = 1 - raw_turn
    player_on_roll = 1 - raw_player_on_roll

    dice = [dice1, dice2] if dice1 > 0 and dice2 > 0 else None
    game_over = game_state > 1

    return {
        "cube": 1 << log_cube if log_cube > 0 else 1,
        "cube_owner": cube_owner_raw if cube_owner_raw < 3 else -1,
        "turn": turn,
        "player_on_roll": player_on_roll,
        "dice": dice,
        "match_length": match_length,
        "score": [p0_score, p1_score],
        "game_over": game_over,
    }


# Regex matches gnubg's `show board` / `show matchid` output. The ids
# appear in lines like `GNU Backgammon  Position ID: <base64>` and
# `                 Match ID   : <base64>` — there's an arbitrary
# leading prefix and variable whitespace before the colon. Match
# anywhere on the line (no ^ anchor) so the leading prefix is ignored.
_POSITION_ID_RE = re.compile(r"Position ID\s*:\s*(\S+)")
_MATCH_ID_RE = re.compile(r"Match ID\s*:\s*(\S+)")


def snapshot_state(stdout: str) -> MatchStateDict:
    """Parse gnubg subprocess stdout into a MatchStateDict.

    `stdout` is expected to contain at least one `Position ID:` and
    `Match ID:` line. gnubg auto-prints the board after `set board`
    AND again after `show board`, so the same stdout often contains
    multiple Position ID lines — we take the LAST occurrence, which
    reflects the post-command state. Raises ValueError if either id
    is missing — that's a gnubg subprocess failure and the caller
    should surface it as an HTTP 500 (or 422 for /apply, where missing
    ids signal an illegal move that gnubg silently rejected).
    """
    pos_matches = _POSITION_ID_RE.findall(stdout)
    if not pos_matches:
        raise ValueError("gnubg output missing position id")
    mid_matches = _MATCH_ID_RE.findall(stdout)
    if not mid_matches:
        raise ValueError("gnubg output missing match id")

    position_id = pos_matches[-1]
    match_id = mid_matches[-1]

    board, bar, off = decode_position_id(position_id)
    info = decode_match_id(match_id)

    winner: int | None = None
    if info["game_over"]:
        winner = 1 if info["score"][1] > info["score"][0] else 0

    return MatchStateDict(
        position_id=position_id,
        match_id=match_id,
        board=board,
        bar=bar,
        off=off,
        turn=info["turn"],
        dice=info["dice"],
        score=info["score"],
        match_length=info["match_length"],
        game_over=info["game_over"],
        winner=winner,
    )
