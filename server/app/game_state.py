from pydantic import BaseModel, Field
from typing import List, Optional
import base64

class GameState(BaseModel):
    game_id: str
    match_id: str
    position_id: str
    board: List[int] = Field(description="Checkers on points 1-24. Positive for player 0, negative for player 1.")
    bar: List[int] = Field(description="[player0_checkers, player1_checkers] on the bar")
    off: List[int] = Field(description="[player0_checkers, player1_checkers] borne off")
    turn: int = Field(description="0 for player 0, 1 for player 1")
    dice: Optional[List[int]] = None
    cube: int = 1
    cube_owner: int = -1
    match_length: int = 0
    score: List[int] = [0, 0]
    game_over: bool = False
    winner: Optional[int] = None

def decode_position_id(pos_id: str):
    b = base64.b64decode(pos_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))
    
    def parse_player(bits_iter):
        points = []
        count = 0
        for _ in range(25):
            while next(bits_iter) == '1':
                count += 1
            points.append(count)
            count = 0
        return points

    bits_iter = iter(bits)
    player0 = parse_player(bits_iter)
    player1 = parse_player(bits_iter)
    
    # Calculate how many checkers are off the board (each player starts with 15)
    p0_on_board = sum(player0)
    p1_on_board = sum(player1)
    
    board = [0] * 24
    for i in range(24):
        # player 0's point (i+1) lives at board index `i`.
        if player0[i] > 0:
            board[i] = player0[i]
        # player 1's point (i+1) is mirrored: it lives at board index
        # `23 - i` from player 0's perspective. This must be a separate
        # `if` (not `elif`) — player0[i] and player1[i] describe two
        # different physical points, so a checker at one doesn't preclude
        # a checker at the other. Using `elif` here was the cause of
        # player 1's checkers vanishing in the UI (Phase 24 regression).
        if player1[i] > 0:
            board[23 - i] = -player1[i]
            
    bar = [player0[24], player1[24]]
    off = [15 - p0_on_board, 15 - p1_on_board]
    
    return board, bar, off

def decode_match_id(match_id: str):
    b = base64.b64decode(match_id + "==")
    bits = ""
    for byte in b:
        bits += "".join(str((byte >> i) & 1) for i in range(8))
    
    # match ID layout:
    # 0-3: cube value (log2)
    # 4-5: cube owner (0=p0, 1=p1, 3=center) -> 2 bits
    # 6: player on roll (0=p0, 1=p1)
    # 7: crawford flag
    # 8-10: game state (0=playing, 1=over, 2=resigned, 3=dropped)
    # 11: turn (0=p0, 1=p1)
    # 12: double offered
    # 13: resign offered (0=none, 1=single, 2=gammon, 3=backgammon) -> 2 bits
    # 15-17: dice 1
    # 18-20: dice 2
    # 21-35: match length
    # 36-50: player 0 score
    # 51-65: player 1 score
    
    # Let's extract safely
    def get_int(start, length):
        sub = bits[start:start+length]
        # Little-endian bits! wait, the bits themselves are little-endian per byte,
        # but the fields are just concatenated in the bitstream.
        # Actually, in gnubg, the bitstream is assembled by pushing bits.
        # Let's just read the value by treating the sub-string as little-endian binary
        val = 0
        for i, bit in enumerate(sub):
            if bit == '1':
                val += (1 << i)
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

    # gnubg's match-id encodes the turn bit as 0=O / 1=X. In our app
    # convention X is the user (the human, displayed in blue) and O is
    # gnubg (the agent, red), and we want turn=0=human / turn=1=agent —
    # the opposite. Invert before exposing. Symptom of leaving this raw:
    # every Move/Roll was applied to the wrong side in gnubg, so the
    # user's pieces ended up "in the wrong place" after each agent
    # reply (Phase 24 regression).
    turn = 1 - raw_turn
    player_on_roll = 1 - raw_player_on_roll

    dice = None
    if dice1 > 0 and dice2 > 0:
        dice = [dice1, dice2]

    game_over = game_state > 1

    return {
        "cube": 1 << log_cube if log_cube > 0 else 1,
        "cube_owner": cube_owner_raw if cube_owner_raw < 3 else -1,
        "turn": turn,
        "player_on_roll": player_on_roll,
        "dice": dice,
        "match_length": match_length,
        "score": [p0_score, p1_score],
        "game_over": game_over
    }
