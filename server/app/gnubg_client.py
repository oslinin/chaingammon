import pexpect
import re
from typing import List, Optional, Tuple
from app.game_state import GameState

class GNUBGClient:
    def __init__(self):
        self.process = None
        self.gnubg_turn = False
        self._is_game_over = False
        self._winner = None

    def start(self):
        self.process = pexpect.spawn('gnubg -t', encoding='utf-8', timeout=5)
        # GNUBG prompt usually looks like "(No game) " or "(jules) " or "(gnubg) "
        self.process.expect(r'\) ')
        self.process.sendline('set sound enable no')
        self.process.expect(r'\) ')
        self.process.sendline('set player jules human')
        self.process.expect(r'\) ')

    def stop(self):
        if self.process:
            self.process.sendline('quit')
            self.process.close()

    def new_match(self, length: int):
        self.process.sendline(f'new match {length}')
        self._is_game_over = False
        self._winner = None
        self.process.expect(r'\) ')

    def get_agent_move(self, board_state: GameState, dice: List[int]) -> Optional[str]:
        # To avoid desync, we can use position ID to set board state directly if needed,
        # but for now we just assume gnubg is tracking correctly.
        self.process.sendline(f'set dice {dice[0]} {dice[1]}')
        self.process.expect(r'\) ')
        self.process.sendline('play')
        self.process.expect(r'\) ')
        output = self.process.before

        # Parse move from output
        # e.g., "gnubg moves 8/4 6/4."
        match = re.search(r'gnubg moves (.*?)\.', output)
        if match:
            # check for win
            if 'wins a' in output or 'wins the game' in output or 'wins the match' in output:
                self._is_game_over = True
                self._winner = 1 # gnubg is player 2 (index 1)
            return match.group(1).strip()
        return None

    def submit_move(self, board_state: GameState, dice: List[int], move: str):
        self.process.sendline(f'set dice {dice[0]} {dice[1]}')
        self.process.expect(r'\) ')
        self.process.sendline(f'move {move}')
        self.process.expect(r'\) ')
        output = self.process.before
        if 'wins a' in output or 'wins the game' in output or 'wins the match' in output:
            self._is_game_over = True
            self._winner = 0 # human is player 1 (index 0)

    def is_game_over(self) -> bool:
        return self._is_game_over

    def winner(self) -> Optional[int]:
        return self._winner
