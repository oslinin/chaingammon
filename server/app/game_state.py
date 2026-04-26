"""
game_state.py

Defines the Pydantic data models used to represent the state of a backgammon match.
This module is used to keep track of the board position, dice rolls, turns, and match status.
"""
from pydantic import BaseModel, Field
from typing import List, Optional

class GameState(BaseModel):
    """
    Represents the complete state of a backgammon game at a specific point in time.
    """

    # Standard backgammon board from points 1 to 24.
    # Player 1 (positive integers) moves towards point 1.
    # Player 2 (negative integers) moves towards point 24.
    # The default factory provides the standard starting configuration.
    board: List[int] = Field(
        default_factory=lambda: [
            2, 0, 0, 0, 0, -5,    # points 1-6
            0, -3, 0, 0, 0, 5,    # points 7-12
            -5, 0, 0, 0, 3, 0,    # points 13-18
            5, 0, 0, 0, 0, -2     # points 19-24
        ],
        description="Array of 24 ints representing checkers on points 1-24. Positive values belong to Player 1, negative to Player 2."
    )

    # Track checkers that have been hit and are waiting to re-enter.
    bar: List[int] = Field(default_factory=lambda: [0, 0], description="Checkers on the bar: index 0 is player 1, index 1 is player 2.")

    # Track checkers that have been successfully borne off the board.
    off: List[int] = Field(default_factory=lambda: [0, 0], description="Checkers borne off: index 0 is player 1, index 1 is player 2.")

    # Which player's turn it currently is.
    turn: int = Field(default=0, description="0 for player 1 (human), 1 for player 2 (agent).")

    # The dice rolled for the current turn, if any.
    dice: Optional[List[int]] = Field(default=None, description="The rolled dice for the current turn.")

    # The target score to win the match.
    match_length: int = Field(default=1, description="Length of the match in points.")

    # Current score of the match.
    score: List[int] = Field(default_factory=lambda: [0, 0], description="Current score of the match: index 0 is player 1, index 1 is player 2.")

    # Whether the game has concluded.
    game_over: bool = Field(default=False, description="True if the game has ended, False otherwise.")

    # The index of the winning player (0 for human, 1 for agent).
    winner: Optional[int] = Field(default=None, description="The winning player index, or None if the game is not over.")

    @classmethod
    def initial_state(cls, match_length: int = 1):
        """
        Creates and returns a new GameState instance with the standard initial backgammon setup.

        Args:
            match_length (int): The number of points required to win the match.

        Returns:
            GameState: The newly initialized game state.
        """
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

        # Set up Player 2 (gnubg) using negative values
        board[0] = -2   # point 1
        board[11] = -5  # point 12
        board[16] = -3  # point 17
        board[18] = -5  # point 19

        # Set up Player 1 (human) using positive values
        board[23] = 2   # point 24
        board[12] = 5   # point 13
        board[7] = 3    # point 8
        board[5] = 5    # point 6

        return cls(board=board, match_length=match_length)
