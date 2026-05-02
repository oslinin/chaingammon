"""teammate_advisor.py — per-turn advisor signal scoring (Phase K.3).

Each non-captain teammate produces one AdvisorSignal per turn:

  AdvisorSignal{
    teammate_id   : "agent:N" or 0xaddr
    proposed_move : gnubg move string
    confidence    : float in [0, 1]
    message       : optional rationale
  }

Scoring path branches on the teammate's resolved AgentProfile:

  OverlayProfile          — re-rank gnubg's candidates via apply_overlay,
                            pick the top; confidence = |bias_gain| /
                            equity_spread, clamped to [0, 1].

  ModelProfile (race)     — race-only checkpoint can't score full-board
                            positions. Returns confidence=0 with a clear
                            message so the captain knows the advisor
                            is silent on this turn. Phase J unblocks
                            this — once gnubg_full encoder ships, the
                            model can score real positions.

  ModelProfile (gnubg_full) — Phase J: full-board NN scoring per
                              candidate's successor position; argmax
                              over batched equities. Today the branch
                              is reachable but the encoder isn't, so
                              we route to the race fallback.

  NullProfile / unresolvable — return None; the caller drops this
                               teammate's signal from the bundle.

The scoring function is pure (no I/O); the caller resolves the
teammate's profile via the existing `agent_profile.load_profile`
content-sniff path (which handles 0G Storage fetch, decryption,
zip-magic content sniff).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

from .agent_overlay import Overlay, apply_overlay
from .game_record import AdvisorSignal, PlayerRef


@dataclass(frozen=True)
class AdvisorScoring:
    """Inputs to score_advisor_move. Bundled to keep the function's
    parameter list manageable + tests legible."""

    teammate: PlayerRef
    candidates: list[Mapping]            # gnubg's candidate move list
    overlay: Optional[Overlay] = None    # OverlayProfile path; None disables overlay scoring
    profile_kind: str = "null"           # "overlay" | "model" | "null"
    model_encoder: str = ""              # "race" | "gnubg_full" | "" — set when profile_kind=="model"


def _player_ref_id(p: PlayerRef) -> str:
    """Match the AdvisorSignal.teammate_id wire format used by
    docs/team-mode.md: 'agent:N' for agent refs, lowercased 0x address
    for human refs."""
    if p.kind == "agent":
        return f"agent:{p.agent_id}"
    if p.kind == "human" and p.address:
        return p.address.lower()
    return "agent:0"   # shouldn't happen; PlayerRef validates these


def score_advisor_move(s: AdvisorScoring) -> Optional[AdvisorSignal]:
    """Produce one AdvisorSignal for the teammate, or None if the
    teammate has nothing meaningful to contribute (e.g. NullProfile)."""
    if not s.candidates:
        return None

    if s.profile_kind == "null":
        # No weights, no overlay — silent advisor.
        return None

    if s.profile_kind == "overlay":
        return _score_via_overlay(s)

    if s.profile_kind == "model":
        if s.model_encoder == "gnubg_full":
            # Phase J's full-board NN path. Reaches here only after J.5
            # ships; until then this branch isn't taken because
            # ModelProfile.metrics()["feature_encoder"] returns "race"
            # for all existing checkpoints.
            return _score_via_full_board_nn(s)
        # Race-only model: explicitly silent on full-board positions.
        # Captain can read the message + skip this advisor's vote.
        return AdvisorSignal(
            teammate_id=_player_ref_id(s.teammate),
            proposed_move=s.candidates[0].get("move", "(unknown)"),
            confidence=0.0,
            message=(
                "race-only model can't score this position; advisor abstains"
            ),
        )

    return None


def _score_via_overlay(s: AdvisorScoring) -> AdvisorSignal:
    """OverlayProfile path. Re-rank candidates via apply_overlay; the
    top of the re-rank is the advisor's pick. Confidence reflects how
    far the overlay shifted the choice from gnubg's natural top."""
    assert s.overlay is not None
    ranked = apply_overlay(s.candidates, s.overlay)
    if not ranked:
        return AdvisorSignal(
            teammate_id=_player_ref_id(s.teammate),
            proposed_move=s.candidates[0].get("move", "(unknown)"),
            confidence=0.0,
            message="no candidates available",
        )
    top = ranked[0]
    proposed_move = top.get("move", "(unknown)")
    natural_top = s.candidates[0].get("move")  # gnubg's order = natural rank
    natural_top_equity = float(s.candidates[0].get("equity", 0.0))
    advisor_top_equity = float(top.get("equity", 0.0))

    # Confidence proxy: 1.0 when advisor strongly disagrees with gnubg
    # on the top pick AND the equity spread is meaningful; 0.0 when
    # advisor agrees with gnubg's natural pick (no signal) or the
    # spread is trivial.
    if proposed_move == natural_top:
        # Advisor agrees with gnubg — useful endorsement, modest confidence.
        confidence = 0.4
        msg = "endorses gnubg's natural top pick"
    else:
        equity_spread = abs(natural_top_equity - advisor_top_equity)
        # Normalize: 0.05 equity is "moderate" disagreement; cap at 1.0.
        confidence = min(1.0, max(0.3, equity_spread / 0.05))
        msg = (
            f"prefers {proposed_move} over gnubg's {natural_top} "
            f"(equity Δ {equity_spread:.3f})"
        )

    return AdvisorSignal(
        teammate_id=_player_ref_id(s.teammate),
        proposed_move=proposed_move,
        confidence=confidence,
        message=msg,
    )


def _score_via_full_board_nn(s: AdvisorScoring) -> AdvisorSignal:
    """Phase J placeholder. Real implementation: encode each
    candidate's successor position to 198-dim features, run
    net(features, extras), pick argmax, normalize. For now this is a
    no-op — the route is unreachable until J.5 ships the encoder."""
    return AdvisorSignal(
        teammate_id=_player_ref_id(s.teammate),
        proposed_move=s.candidates[0].get("move", "(unknown)"),
        confidence=0.0,
        message="gnubg_full NN scoring not yet wired; advisor abstains",
    )
