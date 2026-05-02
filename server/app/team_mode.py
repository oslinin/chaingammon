"""team_mode.py — captain rotation + advisor enumeration for Phase K.

Pure logic; no I/O, no FastAPI, no chain. The /agent-move endpoint
(server/app/main.py) calls these helpers to decide who's captain on
the current turn and which teammates produce AdvisorSignal[].

Captain rotation policies (game_record.py:60 captain_rotation field):

  alternating    — captain index = move_count % len(members)
                   Each team member takes the captain seat in turn.
  fixed_first    — captain index always 0
                   The first roster entry stays captain forever.
  per_turn_vote  — out of scope for the K MVP; degrades to alternating
                   with a one-time logged warning. A future phase
                   adds an HTTP-mediated vote tally.
"""
from __future__ import annotations

import logging
from typing import Sequence

from .game_record import PlayerRef, Team


log = logging.getLogger(__name__)
_per_turn_vote_warned = False


def captain_index(team: Team, move_count: int) -> int:
    """Return the index into `team.members` of the captain for this turn.

    @param team        The Team whose roster + rotation policy we're applying.
    @param move_count  The number of moves this team has played so far
                       (0 for the first move). NOT the global game move
                       count — each team rotates independently.
    """
    n = len(team.members)
    if n < 1:
        raise ValueError("Team has no members")

    policy = team.captain_rotation
    if policy == "alternating":
        return move_count % n
    if policy == "fixed_first":
        return 0
    if policy == "per_turn_vote":
        # K MVP: per_turn_vote requires a vote-tally subsystem we
        # haven't built yet. Degrade to alternating + warn once so
        # the operator knows the configured policy isn't fully
        # respected.
        global _per_turn_vote_warned
        if not _per_turn_vote_warned:
            log.warning(
                "team_mode: per_turn_vote captain rotation requested but "
                "vote tally is not implemented; falling back to alternating"
            )
            _per_turn_vote_warned = True
        return move_count % n

    raise ValueError(f"unknown captain_rotation: {policy!r}")


def non_captain_members(
    team: Team, move_count: int
) -> Sequence[PlayerRef]:
    """Return the team members who are NOT captain on this turn — i.e.
    the advisors who will produce AdvisorSignal[]. Order is preserved
    from `team.members` so the frontend can render advisors in roster
    order regardless of which slot is captain."""
    cap = captain_index(team, move_count)
    return [m for i, m in enumerate(team.members) if i != cap]


def captain_member(team: Team, move_count: int) -> PlayerRef:
    """Return the captain PlayerRef for this turn."""
    return team.members[captain_index(team, move_count)]


def reset_warnings_for_tests() -> None:
    """Test-only: clear the once-only per_turn_vote warning flag."""
    global _per_turn_vote_warned
    _per_turn_vote_warned = False
