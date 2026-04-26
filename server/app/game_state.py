from pydantic import BaseModel, Field
from typing import List, Optional, Tuple

class GameState(BaseModel):
    # Standard backgammon board from points 1 to 24.
    # Player 1 (positive integers) moves towards point 1.
    # Player 2 (negative integers) moves towards point 24.
    board: List[int] = Field(
        default_factory=lambda: [
            2, 0, 0, 0, 0, -5,    # points 1-6
            0, -3, 0, 0, 0, 5,    # points 7-12
            -5, 0, 0, 0, 3, 0,    # points 13-18
            5, 0, 0, 0, 0, -2     # points 19-24
        ],
        description="Array of 24 ints representing checkers on points 1-24."
    )
    bar: List[int] = Field(default_factory=lambda: [0, 0], description="Checkers on the bar: index 0 is player 1, index 1 is player 2.")
    off: List[int] = Field(default_factory=lambda: [0, 0], description="Checkers borne off: index 0 is player 1, index 1 is player 2.")
    turn: int = Field(default=0, description="0 for player 1, 1 for player 2.")
    dice: Optional[List[int]] = Field(default=None, description="The rolled dice for the current turn.")
    match_length: int = Field(default=1, description="Length of the match in points.")
    score: List[int] = Field(default_factory=lambda: [0, 0], description="Current score of the match: index 0 is player 1, index 1 is player 2.")
    game_over: bool = Field(default=False)
    winner: Optional[int] = Field(default=None)

    @classmethod
    def initial_state(cls, match_length: int = 1):
        # The default_factory already provides the standard starting position.
        # Player 1 (human) uses positive numbers, starts at 24 and moves to 1.
        # Player 2 (gnubg) uses negative numbers, starts at 1 and moves to 24.

        # Point 24: 2 checkers for Player 1
        # Point 13: 5 checkers for Player 1
        # Point 8: 3 checkers for Player 1
        # Point 6: 5 checkers for Player 1

        # Point 1: 2 checkers for Player 2
        # Point 12: 5 checkers for Player 2
        # Point 17: 3 checkers for Player 2
        # Point 19: 5 checkers for Player 2

        # To match standard representation:
        # index 0 is point 1
        # index 23 is point 24
        board = [0] * 24
        # Player 2 (negative)
        board[0] = -2   # point 1
        board[11] = -5  # point 12
        board[16] = -3  # point 17
        board[18] = -5  # point 19

        # Player 1 (positive)
        board[23] = 2   # point 24
        board[12] = 5   # point 13
        board[7] = 3    # point 8
        board[5] = 5    # point 6

        return cls(board=board, match_length=match_length)
