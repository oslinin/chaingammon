"""
gnubg_service.py — AXL agent node: gnubg move evaluation.

@notice Exposed via AXL (Gensyn Agent eXchange Layer) as an A2A
        (agent-to-agent) service. The AXL binary proxies HTTP traffic from
        remote peers to this service running on localhost. Run alongside AXL:

          axl start --config axl-config.json &
          uvicorn gnubg_service:app --port 8001

@dev    Endpoints:
          POST /move     — pick the best legal move for the given position/dice
          POST /evaluate — rank all legal moves without picking one (coach use)

        position_id:         gnubg base64-encoded position identifier.
        match_id:            gnubg base64-encoded match-state identifier
                             (encodes turn, scores, cube state, etc.).
        agent_weights_hash:  0G Storage root hash of the agent's experience
                             overlay blob; reserved for future overlay biasing
                             — currently not applied (gnubg equity only).
"""

from __future__ import annotations
import re
import subprocess
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from gnubg_state import MatchStateDict, snapshot_state

app = FastAPI(title="Chaingammon gnubg Agent")

# ─── gnubg subprocess helpers ────────────────────────────────────────────────

_GNUBG_BINARY = ["gnubg", "-t", "-q"]

# Sent once at session start to disable all auto-play behaviour so gnubg
# waits for explicit commands and doesn't silently consume moves.
_INIT_COMMANDS = (
    "set automatic roll off\n"
    "set automatic game off\n"
    "set automatic move off\n"
    "set automatic bearoff off\n"
    "set player 0 human\n"
    "set player 1 human\n"
)


def _run_gnubg(commands: str) -> str:
    """Run a gnubg session with the given commands and return combined
    stdout + stderr.

    @dev   Spawns a fresh gnubg subprocess per call (stateless). The init
           commands are prepended to every session to keep gnubg passive.
           gnubg writes some error messages — notably "Illegal or
           unparsable move." — to stderr, so we merge stderr into stdout
           with `subprocess.STDOUT` to keep `apply_move`'s illegal-move
           detection consistent regardless of which stream gnubg used.
    @param commands  Newline-separated gnubg CLI commands to execute after init.
    @return          Combined stdout+stderr from gnubg, including all
                     prompt and hint output.
    """
    proc = subprocess.Popen(
        _GNUBG_BINARY,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    stdout, _ = proc.communicate(_INIT_COMMANDS + commands)
    return stdout


def _snapshot(commands: str) -> MatchStateDict:
    """Run gnubg with `commands`, append `show board` to print the
    final state, and parse the result. gnubg's `show board` output
    contains BOTH `Position ID:` and `Match ID:` lines, so one
    command suffices.

    @raises ValueError when gnubg's output is missing either id (e.g.
            the engine refused the command sequence). Callers turn this
            into HTTPException(422 or 500) as appropriate.
    """
    full = commands + "show board\n"
    stdout = _run_gnubg(full)
    return snapshot_state(stdout)


def _evaluate(position_id: str, match_id: str, dice: list[int]) -> list[dict]:
    """Return gnubg's ranked candidate moves with equity scores.

    @notice gnubg's `hint` command only shows move candidates when dice are
            set; without them it shows cube analysis instead. We supply the
            dice via `set dice D1 D2` before calling `hint`.
    @dev    Output line format (one per candidate):
              1. Cubeful 0-ply    8/5 6/5    Eq.: +0.200
            We capture rank, move string, and equity from each numbered line.
            Lines that don't match the pattern (headers, blank lines) are
            silently skipped.
    @param  position_id  gnubg base64 position identifier for the current board.
    @param  match_id     gnubg base64 match-state identifier (turn, scores, cube).
    @param  dice         Two-element list [d1, d2] representing the current roll.
    @return              List of {"move": str, "equity": float} dicts, ordered
                         best-first as returned by gnubg.
    """
    d1, d2 = dice[0], dice[1]
    cmds = (
        f"set matchid {match_id}\n"
        f"set board {position_id}\n"
        f"set dice {d1} {d2}\n"
        f"hint\n"
    )
    stdout = _run_gnubg(cmds)
    rows = re.findall(
        r"(\d+)\.\s+[\w-]+\s+[0-9]+-ply\s+([\w/*()\s]+?)\s+Eq\.:\s*([+\-]?[0-9.]+)",
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


# ─── request / response models ───────────────────────────────────────────────

class MoveRequest(BaseModel):
    """Request body for POST /move.

    @param position_id         gnubg base64 position identifier.
    @param match_id            gnubg base64 match-state identifier.
    @param dice                Two-element list [d1, d2] for the current roll.
    @param agent_weights_hash  0G Storage root hash of the agent's experience
                               overlay; reserved for future biasing, ignored now.
    """

    position_id: str
    match_id: str
    dice: list[int]
    agent_weights_hash: str = ""


class NewMatchRequest(BaseModel):
    """Request body for POST /new.

    @param match_length  Match-point target (1, 3, 5, 7, …). gnubg
                         supports anything; the frontend uses 3.
    """

    match_length: int = 3


class ResignRequest(BaseModel):
    """Request body for POST /resign.

    @param position_id  Current gnubg base64 board.
    @param match_id     Current gnubg base64 match state.
    """

    position_id: str
    match_id: str


class ApplyRequest(BaseModel):
    """Request body for POST /apply.

    @param position_id  Current gnubg base64 board.
    @param match_id     Current gnubg base64 match state.
    @param dice         Two-element list [d1, d2] — the browser-rolled
                        dice for the current turn. The browser is the
                        source of truth for dice (rolled via
                        crypto.getRandomValues).
    @param move         gnubg move notation. "from/to" per checker,
                        space-separated. Examples: "8/5 6/5", "bar/22",
                        "6/off". Send the move string literally — do
                        NOT prefix it with the word `move`, which gnubg
                        interprets as "let the AI pick a move."
    """

    position_id: str
    match_id: str
    dice: list[int]
    move: str


class EvaluateRequest(BaseModel):
    """Request body for POST /evaluate.

    @param position_id  gnubg base64 position identifier.
    @param match_id     gnubg base64 match-state identifier.
    @param dice         Two-element list [d1, d2] for the current roll.
    """

    position_id: str
    match_id: str
    dice: list[int]


# ─── endpoints ───────────────────────────────────────────────────────────────

@app.post("/move")
def get_move(req: MoveRequest) -> dict:
    """Evaluate position and return the best move plus up to 3 candidates.

    @notice Called by the frontend once per agent turn. The returned `move`
            string uses gnubg's standard point/bar notation (e.g. "8/5 6/5").
    @dev    Returns {"move": None, "candidates": []} when gnubg reports no
            legal moves — e.g. all checkers are on the bar and the rolled pips
            are blocked.
    @param  req  MoveRequest with position, match state, dice, and optional
                 overlay hash.
    @return      {"move": str | None, "candidates": [{"move": str, "equity": float}]}
    """
    candidates = _evaluate(req.position_id, req.match_id, req.dice)
    if not candidates:
        return {"move": None, "candidates": []}
    best = max(candidates, key=lambda c: c["equity"])
    return {"move": best["move"], "candidates": candidates[:3]}


@app.post("/new")
def new_match(req: NewMatchRequest) -> MatchStateDict:
    """Start a new match and return the opening state.

    @notice Called by the frontend on mount of /match?agentId=N. The
            opening dice (if any) are decoded from gnubg's output; the
            frontend ignores them and rolls its own (see dice.ts).
    @return Full MatchState for the opening position.
    """
    return _snapshot(f"new match {req.match_length}\n")


_ILLEGAL_RE = re.compile(r"Illegal|Unparsable|invalid", re.IGNORECASE)


@app.post("/apply")
def apply_move(req: ApplyRequest) -> MatchStateDict:
    """Apply a move and return the post-move state.

    @notice gnubg validates the move against position + match + dice. An
            illegal move surfaces as HTTP 422 with the gnubg error text
            in `detail`. gnubg keeps prior state on failure (so
            `show board` still produces a parseable Position ID), so
            we detect illegal moves by scanning stdout for gnubg's
            error keywords ("Illegal or unparsable move." etc.) BEFORE
            returning the snapshot.
    @dev    The move string is sent as a plain notation line (NOT
            prefixed with `move`, which gnubg interprets as "let the AI
            pick"). Same convention the legacy server's `submit_move`
            used.
    @return Full MatchState after the move.
    """
    d1, d2 = req.dice[0], req.dice[1]
    commands = (
        f"set matchid {req.match_id}\n"
        f"set board {req.position_id}\n"
        f"set dice {d1} {d2}\n"
        f"{req.move}\n"
        "show board\n"
    )
    stdout = _run_gnubg(commands)
    illegal = _ILLEGAL_RE.search(stdout)
    if illegal:
        # Capture the line that triggered the match so the user gets a
        # useful error rather than just "illegal".
        for line in stdout.splitlines():
            if _ILLEGAL_RE.search(line):
                raise HTTPException(status_code=422, detail=line.strip())
        raise HTTPException(status_code=422, detail="Illegal move")
    try:
        return snapshot_state(stdout)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/resign")
def resign(req: ResignRequest) -> MatchStateDict:
    """Human forfeits the match. Returns post-resign state with
    `game_over=true` and `winner=1` (agent).

    @dev gnubg's CLI semantics for `resign normal` + `accept` are
         counter-intuitive: `resign normal` is the player-on-roll
         OFFERING their opponent a 1-point loss, and `accept` is the
         opponent agreeing to that offer — so the player on roll wins
         the offered point. To make the human always lose on forfeit,
         we first force the agent (gnubg's "O" seat) to be on roll via
         `set turn O`, then run resign + accept. Agent wins
         deterministically, regardless of pre-resign turn.

         v1 supports human-vs-agent only, so /resign always means
         "human forfeits." Sub-project C (two-sig settlement) will
         broaden this to either side resigning.
    """
    commands = (
        f"set matchid {req.match_id}\n"
        f"set board {req.position_id}\n"
        "set turn O\n"
        "resign normal\n"
        "accept\n"
    )
    return _snapshot(commands)


@app.post("/evaluate")
def evaluate_only(req: EvaluateRequest) -> dict:
    """Return ranked candidates without selecting a move.

    @notice Used by coach_service so it can present all options to the LLM
            without committing to one — the coach formats its hint around the
            full ranked list.
    @dev    Returns at most 3 candidates to keep the coach prompt concise.
    @param  req  EvaluateRequest with position, match state, and dice.
    @return      {"candidates": [{"move": str, "equity": float}]}
    """
    candidates = _evaluate(req.position_id, req.match_id, req.dice)
    return {"candidates": candidates[:3]}
