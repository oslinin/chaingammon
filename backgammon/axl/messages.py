"""
backgammon/axl/messages.py — AXL wire message dataclasses.

All messages serialise to/from plain dicts for transport over AXL's
HTTP proxy layer.  Each class carries a ``type`` discriminator so the
receiving HTTP handler can dispatch without inspecting the endpoint path.

Message flow:
  ANNOUNCE     → broadcast checkpoint hash + ELO after each training cycle
  CHALLENGE    → request a match series against a peer
  MATCH_RESULT → report the outcome of a completed match series
  WEIGHTS_REQ  → ask a peer for the 0G Storage URI of a checkpoint
  WEIGHTS_RESP → reply with the URI (bytes live on 0G Storage)
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


def _require(d: dict, *keys: str) -> None:
    for k in keys:
        if k not in d:
            raise ValueError(f"Missing field '{k}' in {d}")


@dataclass
class Announce:
    """Broadcast: I exist, here is my current checkpoint and ELO."""

    type: str = "ANNOUNCE"
    agent_id: str = ""
    checkpoint_hash: str = ""
    elo: float = 1500.0
    generation: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Announce":
        _require(d, "agent_id", "checkpoint_hash", "elo", "generation")
        return cls(
            agent_id=d["agent_id"],
            checkpoint_hash=d["checkpoint_hash"],
            elo=float(d["elo"]),
            generation=int(d["generation"]),
        )


@dataclass
class Challenge:
    """Ask a peer to play n_games seeded by *seed*."""

    type: str = "CHALLENGE"
    from_id: str = ""
    n_games: int = 20
    seed: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Challenge":
        _require(d, "from_id", "n_games", "seed")
        return cls(from_id=d["from_id"], n_games=int(d["n_games"]), seed=int(d["seed"]))


@dataclass
class MatchResult:
    """Outcome of a completed match series."""

    type: str = "MATCH_RESULT"
    agent_a: str = ""
    agent_b: str = ""
    score_a: int = 0
    score_b: int = 0
    n_games: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "MatchResult":
        _require(d, "agent_a", "agent_b", "score_a", "score_b", "n_games")
        return cls(
            agent_a=d["agent_a"],
            agent_b=d["agent_b"],
            score_a=int(d["score_a"]),
            score_b=int(d["score_b"]),
            n_games=int(d["n_games"]),
        )


@dataclass
class WeightsReq:
    """Ask a peer for the 0G Storage URI of a specific checkpoint."""

    type: str = "WEIGHTS_REQ"
    checkpoint_hash: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "WeightsReq":
        _require(d, "checkpoint_hash")
        return cls(checkpoint_hash=d["checkpoint_hash"])


@dataclass
class WeightsResp:
    """Reply to WEIGHTS_REQ: the 0G Storage URI for the checkpoint bytes."""

    type: str = "WEIGHTS_RESP"
    checkpoint_hash: str = ""
    storage_uri: str = ""   # e.g. "0g://0x<rootHash>"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "WeightsResp":
        _require(d, "checkpoint_hash", "storage_uri")
        return cls(checkpoint_hash=d["checkpoint_hash"], storage_uri=d["storage_uri"])


# Dispatch helper

_TYPES: dict[str, Any] = {
    "ANNOUNCE":     Announce,
    "CHALLENGE":    Challenge,
    "MATCH_RESULT": MatchResult,
    "WEIGHTS_REQ":  WeightsReq,
    "WEIGHTS_RESP": WeightsResp,
}


def from_dict(d: dict) -> Any:
    """Deserialise an arbitrary AXL message dict to the matching dataclass."""
    msg_type = d.get("type", "")
    cls = _TYPES.get(msg_type)
    if cls is None:
        raise ValueError(f"Unknown message type: {msg_type!r}")
    return cls.from_dict(d)
