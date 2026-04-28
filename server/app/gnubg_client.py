"""
gnubg subprocess wrapper using a *deterministic* command protocol.

Unlike a naive "type the move and read the position back" approach, this
client carefully disables every gnubg auto-behavior that would otherwise
silently advance the game beyond the single action we requested:

  - `set automatic roll off`     — don't auto-roll dice for the next player
  - `set automatic game off`     — don't auto-start a new game on game-end
  - `set automatic move off`     — don't auto-make forced moves
  - `set automatic bearoff off`  — don't auto-bearoff non-contact positions
  - `set player 0 human`         — gnubg won't pick its own moves
  - `set player 1 human`         — neither will the other side

Without these guards, applying X's move would:
  1. Apply the move (correct)
  2. Auto-roll dice for O (silent state change)
  3. Auto-play O's response (silent state change)
  4. Auto-roll for X (yet another state change)
  ...all before the position_id we read is captured. The Phase-24 user
  symptom ("my pieces are in the wrong place after the agent moves")
  came directly from this — the client was stitching together state
  from several moves' worth of gnubg auto-action.

Board state is read in two passes per command sequence:
  - With `set output rawboard on`, gnubg emits an unambiguous
    colon-separated record of all 24 points + bars. We parse this for
    point counts.
  - With rawboard off, gnubg emits "Position ID: ..." / "Match ID: ..."
    strings, which we extract by regex.

This is gnubg's intended way to drive it programmatically; it's just
not very visible in the docs.
"""

from __future__ import annotations

import re
import subprocess
from typing import Optional


class GnubgClient:
    BINARY = ["gnubg", "-t", "-q"]

    # Commands prepended to every session. Order matters: disable
    # auto-behaviour first, then set both players to human, then turn
    # on rawboard for structured board reads.
    INIT_COMMANDS = (
        "set automatic roll off\n"
        "set automatic game off\n"
        "set automatic move off\n"
        "set automatic bearoff off\n"
        "set player 0 human\n"
        "set player 1 human\n"
    )

    def _run(self, commands: str) -> str:
        """Spawn gnubg, prepend the init commands, run `commands`,
        return raw stdout. Each invocation is hermetic — no shared
        state between calls."""
        proc = subprocess.Popen(
            self.BINARY,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, _stderr = proc.communicate(self.INIT_COMMANDS + commands)
        return stdout

    # ─── parsing helpers ───────────────────────────────────────────

    # Captures everything after `board:<me>:<them>:<match_length>:` —
    # i.e. the actual data fields. Skipping match_length is critical:
    # values[0] = our bar, values[1] = their bar, values[2] = pt 0 padding,
    # values[3..26] = pts 1..24.
    _RAWBOARD_RE = re.compile(r"^board:[^:]+:[^:]+:[^:]+:(.+)$", re.MULTILINE)
    _POSITION_RE = re.compile(r"Position ID:\s*([A-Za-z0-9+/]+={0,2})")
    _MATCH_ID_RE = re.compile(r"Match ID\s*:\s*([A-Za-z0-9+/]+={0,2})")

    def _last_rawboard(self, output: str) -> Optional[dict]:
        """Parse the LAST `board:` line gnubg emitted in rawboard mode.

        Layout (verified empirically against gnubg 1.07 by sweeping
        `set board simple <26 values>`):
          - values[2]      = O (agent) bar count, NEGATED (i.e. -count)
          - values[3..26]  = signed point counts for pts 1..24
                             (positive = X / human, negative = O / agent)
          - values[27]     = X (human) bar count, positive

        The opening (no bar checkers) has values[2] = values[27] = 0,
        which is why an earlier "values[1]/values[2]" guess looked
        right at first — both happen to be 0 in any state without
        bars. Hits expose the off-by-N indexing.
        """
        matches = list(self._RAWBOARD_RE.finditer(output))
        if not matches:
            return None
        body = matches[-1].group(1)
        try:
            values = [int(x) for x in body.split(":")]
        except ValueError:
            return None
        if len(values) < 28:
            return None
        return {
            "points": values[3:27],
            # values[27] is X bar (positive), values[2] is -O_bar (negated).
            "bar": [values[27], -values[2]],
        }

    def _last_position_id(self, output: str) -> Optional[str]:
        m = self._POSITION_RE.findall(output)
        return m[-1] if m else None

    def _last_match_id(self, output: str) -> Optional[str]:
        m = self._MATCH_ID_RE.findall(output)
        return m[-1] if m else None

    # ─── core: run-and-snapshot ────────────────────────────────────

    def _snapshot(self, prelude: str) -> dict:
        """Run `prelude` then take a full state snapshot.

        Calls `show board` twice — once with rawboard on (for the
        structured points + bar) and once with rawboard off (for the
        Position ID / Match ID strings, which rawboard mode suppresses).
        """
        cmds = (
            prelude
            + "set output rawboard on\nshow board\n"
            + "set output rawboard off\nshow board\n"
        )
        out = self._run(cmds)
        raw = self._last_rawboard(out)
        pos = self._last_position_id(out)
        mid = self._last_match_id(out)
        return {
            "position_id": pos,
            "match_id": mid,
            "points": raw["points"] if raw else [0] * 24,
            "bar": raw["bar"] if raw else [0, 0],
            "output": out,
        }

    # ─── public game operations ────────────────────────────────────

    def new_match(self, length: int) -> dict:
        """Start a new match of `length` points and snapshot the
        opening state. The opener's dice are auto-rolled by gnubg
        (this is the only auto-roll we want)."""
        return self._snapshot(f"new match {length}\n")

    def submit_move(self, position_id: str, match_id: str, move: str) -> dict:
        """Apply `move` (e.g. "24/18 13/8") in the state described by
        `(position_id, match_id)`. The move is sent as a plain notation
        line — NOT prefixed with the `move` command, which gnubg
        sometimes interprets as "let the AI pick a move" — and applies
        to whichever side fTurn says is on roll."""
        prelude = (
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
            f"{move}\n"
        )
        return self._snapshot(prelude)

    def roll_dice(self, position_id: str, match_id: str) -> dict:
        """Explicitly roll dice for the player on roll. With
        `automatic roll off` set, this is the ONLY way fresh dice
        appear in the match-id."""
        prelude = (
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
            f"roll\n"
        )
        return self._snapshot(prelude)

    def resign(self, position_id: str, match_id: str) -> dict:
        prelude = (
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
            f"resign normal\n"
            f"accept\n"
        )
        return self._snapshot(prelude)

    def decode_board(self, position_id: str, match_id: str) -> dict:
        """Read the structured (points + bar) view of a position
        using gnubg's authoritative rawboard output.

        IMPORTANT: gnubg's position_id encoding is player-on-roll
        relative — the encoding's "player 0" is whichever side has
        fTurn at the time the id was generated. Passing match_id
        restores fTurn to the correct value, so `set board` interprets
        the position_id in the same perspective it was encoded in,
        and the rawboard output (which always shows X=oleg=human as
        positive) is consistent across calls. Without match_id, the
        opener's fTurn is randomized by `new match 1`, and the same
        position_id decodes to mirrored boards on different calls.
        """
        return self._snapshot(
            f"new match 1\n"
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
        )

    # ─── agent move selection ──────────────────────────────────────

    _HINT_RE = re.compile(
        r"1\.\s+[\w-]+\s+[0-9]+-ply\s+([\d/a-zA-Z*\(\)\s]+?)\s*Eq\.:"
    )

    def get_candidate_moves(self, position_id: str, match_id: str) -> list[dict]:
        """Return all candidate moves gnubg's `hint` ranked, with
        equities. Empty if no legal moves (e.g. dance from the bar) —
        caller should fall back to auto-play."""
        cmds = (
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
            f"hint\n"
        )
        stdout = self._run(cmds)

        rows = re.findall(
            r"(\d+)\.\s+[\w-]+\s+[0-9]+-ply\s+([\d/a-zA-Z*\(\)\s]+?)\s*Eq\.:\s*([+\-]?[0-9.]+)",
            stdout,
        )
        candidates = []
        for _rank, move_str, eq_str in rows:
            try:
                equity = float(eq_str)
            except ValueError:
                continue
            candidates.append({"move": move_str.strip(), "equity": equity})
        return candidates

    def get_agent_move(self, position_id: str, match_id: str) -> dict:
        """Pick gnubg's best move for the player on roll and apply it.
        Falls back to a `play` command when gnubg has no legal moves
        (e.g. dance from the bar)."""
        cmds = (
            f"set matchid {match_id}\n"
            f"set board {position_id}\n"
            f"hint\n"
        )
        out = self._run(cmds)

        match = self._HINT_RE.search(out)
        if not match:
            # No legal moves — the player must be auto-played by gnubg
            # via `play` (which works for unforced no-move cases too).
            # We have to flip the on-roll player to gnubg first because
            # `play` doesn't act when both players are human.
            import base64

            try:
                b = base64.b64decode(match_id + "==")
                turn_bit = (b[1] >> 3) & 1  # bit 11 in match-id
            except Exception:
                turn_bit = 0
            prelude = (
                f"set matchid {match_id}\n"
                f"set board {position_id}\n"
                f"set player {turn_bit} gnubg\n"
                f"play\n"
            )
            result = self._snapshot(prelude)
            result["best_move"] = None
            return result

        best_move = match.group(1).strip()
        result = self.submit_move(position_id, match_id, best_move)
        result["best_move"] = best_move
        return result
