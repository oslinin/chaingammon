import subprocess
import re

class GnubgClient:
    def __init__(self):
        self.cmd_base = ["gnubg", "-t", "-q"]

    def _run_commands(self, commands: str) -> dict:
        # Prepend commands to disable auto-play
        init_cmds = "set player 0 human\nset player 1 human\n"
        full_cmds = init_cmds + commands
        
        proc = subprocess.Popen(self.cmd_base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = proc.communicate(full_cmds)
        
        pos_matches = re.findall(r"Position ID:\s*([A-Za-z0-9+/]+={0,2})", stdout)
        match_matches = re.findall(r"Match ID\s*:\s*([A-Za-z0-9+/]+={0,2})", stdout)
        
        pos_id = pos_matches[-1] if pos_matches else None
        match_id = match_matches[-1] if match_matches else None
        
        return {"position_id": pos_id, "match_id": match_id, "output": stdout}

    def new_match(self, length: int) -> dict:
        cmds = f"new match {length}\nshow board\n"
        return self._run_commands(cmds)

    def submit_move(self, position_id: str, match_id: str, move: str) -> dict:
        # We assume the move is in standard notation, e.g. "13/11 6/5"
        cmds = f"set matchid {match_id}\nset board {position_id}\nmove {move}\nshow board\n"
        return self._run_commands(cmds)

    def get_agent_move(self, position_id: str, match_id: str) -> dict:
        # Ask for a hint to get the best move
        cmds = f"set matchid {match_id}\nset board {position_id}\nhint\n"
        proc = subprocess.Popen(self.cmd_base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = proc.communicate(cmds)

        # The best move is usually prefixed with "1. Cubeful " or "1. Cubefree "
        move_match = re.search(r"1\.\s+[\w-]+\s+[0-9]+-ply\s+([\d/a-zA-Z*\(\)\s]+?)\s*Eq\.:", stdout)
        if not move_match:
            # No legal moves, or other special state. We decode the match_id to find whose turn it is
            import base64
            b = base64.b64decode(match_id + "==")
            turn = (b[1] >> 3) & 1 # Bit 11 is turn

            # Temporarily set the active player to gnubg to let it auto-play (pass or end game)
            cmds = f"set matchid {match_id}\nset board {position_id}\nset player {turn} gnubg\nplay\nshow board\n"
            result = self._run_commands(cmds)
            result["best_move"] = None  # auto-played; no single move to record
            return result

        best_move = move_match.group(1).strip()
        # Now apply the best move and surface what was played so the
        # server can record it in the match's GameRecord.
        result = self.submit_move(position_id, match_id, best_move)
        result["best_move"] = best_move
        return result
        
    def roll_dice(self, position_id: str, match_id: str) -> dict:
        cmds = f"set matchid {match_id}\nset board {position_id}\nroll\nshow board\n"
        return self._run_commands(cmds)
        
    def resign(self, position_id: str, match_id: str) -> dict:
        # To resign, we can just "resign" or maybe the client resigns
        cmds = f"set matchid {match_id}\nset board {position_id}\nresign normal\naccept\nshow board\n"
        return self._run_commands(cmds)
