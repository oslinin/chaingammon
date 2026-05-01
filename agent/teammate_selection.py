"""teammate_selection.py — minimum viable teammate-preference scoring.

The trainer's value network already takes a 16-d `extras` vector that
encodes career-mode context, including a teammate-style sub-vector
(`career_features.encode_career_context` slots [6:12]). The trainer
samples that sub-vector during `--career-mode` self-play, so the
extras head learns to condition equity on teammate style — but the
agent has no way to *act* on that conditioning at inference time.

This module is the smallest extraction of "teammate preference" from
the existing trained network: for each candidate teammate, build the
career-context with that candidate's style projected into slots [6:12],
run a forward pass over a fixed battery of reference board positions,
and pick the candidate whose mean equity is highest.

Honest scope:
  - The signal is a byproduct of training, not a directly trained
    objective. The net learned "play differently given teammate style
    X"; recommending teammates reads off "given a fixed reference
    position, which teammate-style input do I think wins more?" That
    has *some* discriminative power but isn't calibrated.
  - Two teammates with identical style profiles look identical to the
    net — only style is in the input, not identity.
  - Reference states are deterministic random vectors, not real
    backgammon positions. Equity differences across teammate styles
    average out to a small but stable spread; that's the floor.

This module is pure (no IO) and depends only on `torch`,
`career_features`, and (typing) the `BackgammonNet` class signature.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional, Sequence, Tuple

import torch
from torch import nn

from career_features import CareerContext, encode_career_context


# Width of the gnubg board-feature input the net consumes. Mirrors
# `sample_trainer.GNUBG_FEAT_DIM` so this module doesn't import the
# trainer (avoids pulling in optimizer / argparse / IO at import time).
_BOARD_DIM = 198

# Reference-state battery: deterministic random feature vectors, drawn
# once at import via a fixed-seed generator. The exact distribution
# doesn't matter — what matters is that the same boards are reused
# across all candidates so equity differences come from the teammate
# slot, not from board variance.
_REFERENCE_SEED = 0xC4FE
_DEFAULT_N_REFERENCE = 8


@dataclass(frozen=True)
class Recommendation:
    """Result of scoring a list of teammate candidates."""

    best_teammate_id: int
    equities: dict[int, float]
    spread: float
    """Max - min equity across candidates. Small spread = the net has
    little teammate-style preference at this reference battery; treat
    the recommendation as low-confidence."""


def _reference_boards(n: int, seed: int) -> torch.Tensor:
    """Deterministic battery of (n, 198) random board-feature vectors.

    Uses a fresh `torch.Generator` so the global seed isn't disturbed.
    """
    g = torch.Generator().manual_seed(seed)
    return torch.randn(n, _BOARD_DIM, generator=g)


def _build_extras(
    teammate_style: Mapping[str, float],
    *,
    extras_dim: int,
    opponent_style: Optional[Mapping[str, float]] = None,
    stake_wei: int = 0,
    tournament_position: float = 0.0,
) -> torch.Tensor:
    """Project a teammate style into the 16-d extras vector via the
    same encoder the trainer uses, with all other context slots
    neutral. Returns a (extras_dim,) tensor."""
    ctx = CareerContext(
        opponent_style=dict(opponent_style or {}),
        teammate_style=dict(teammate_style),
        stake_wei=stake_wei,
        tournament_position=tournament_position,
        is_team_match=True,
    )
    return encode_career_context(ctx, dim=extras_dim)


def recommend_teammate(
    net: nn.Module,
    candidates: Sequence[Tuple[int, Mapping[str, float]]],
    *,
    extras_dim: int = 16,
    n_reference_states: int = _DEFAULT_N_REFERENCE,
    seed: int = _REFERENCE_SEED,
) -> Recommendation:
    """Pick the teammate whose style maximises the agent's mean equity
    across a fixed battery of reference board positions.

    @param net  A `BackgammonNet` (or any module with the same signature
                `forward(board: (B, 198), extras: (B, extras_dim))
                 -> (B,)` returning equity in [0, 1]). Not mutated.
    @param candidates  List of `(agent_id, style_dict)` tuples. Style
                       dicts are projected onto the 6 STYLE_AXES the
                       extras encoder honours; unknown keys are
                       ignored, missing keys default to 0.
    @param extras_dim  Width of the extras input the net consumes.
                       Must match `net.extras.in_features`.
    @param n_reference_states  How many reference boards to average
                               equity over. More = lower variance,
                               diminishing returns past ~16.
    @param seed  Reference-battery seed. Override only for tests.
    @return  `Recommendation(best_teammate_id, equities, spread)`.
    @raises  ValueError if `candidates` is empty.
    """
    if not candidates:
        raise ValueError("candidates must be non-empty")

    boards = _reference_boards(n_reference_states, seed)

    equities: dict[int, float] = {}
    net_was_training = net.training
    net.eval()
    try:
        with torch.no_grad():
            for agent_id, style in candidates:
                extras = _build_extras(style, extras_dim=extras_dim)
                # Broadcast the same extras row across the reference battery.
                extras_batch = extras.unsqueeze(0).expand(n_reference_states, -1)
                equity = net(boards, extras_batch).mean().item()
                equities[int(agent_id)] = float(equity)
    finally:
        if net_was_training:
            net.train()

    best = max(equities, key=equities.__getitem__)
    spread = max(equities.values()) - min(equities.values())
    return Recommendation(
        best_teammate_id=best,
        equities=equities,
        spread=spread,
    )


# ─── CLI ────────────────────────────────────────────────────────────────────
#
# Demonstration entry-point. Loads a trainer checkpoint and prints
# recommendations for a list of candidates parsed from the command
# line. Useful for end-to-end demos:
#
#   python -m teammate_selection --checkpoint runs/career-1234/agent.pt \
#       --candidate '7:hits_blot=0.8,phase_prime_building=-0.3' \
#       --candidate '11:bearoff_efficient=0.6' \
#       --candidate '13:phase_holding_game=0.4,opening_slot=-0.2'
#
# Output is one line per candidate (equity) plus a final "Best: #N".
# Designed to be invoked from `cd agent && uv run python -m teammate_selection`.

def _parse_candidate(spec: str) -> Tuple[int, dict[str, float]]:
    """Parse "AGENT_ID:axis1=v1,axis2=v2,..." into (id, {axis: val})."""
    if ":" not in spec:
        raise ValueError(
            f"candidate spec must be 'AGENT_ID:axis=val,...' — got {spec!r}"
        )
    head, body = spec.split(":", 1)
    agent_id = int(head)
    style: dict[str, float] = {}
    for pair in body.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            raise ValueError(f"style pair must be 'axis=val' — got {pair!r}")
        axis, val = pair.split("=", 1)
        style[axis.strip()] = float(val.strip())
    return agent_id, style


def _main() -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Pick a teammate from candidates using a trained BackgammonNet.",
    )
    parser.add_argument(
        "--checkpoint",
        type=str,
        default=None,
        help="Path to a checkpoint saved by sample_trainer.save_checkpoint. "
             "When omitted, uses a freshly-initialized BackgammonNet "
             "(deterministic but untrained — equities reflect random "
             "weights, not learned preferences).",
    )
    parser.add_argument(
        "--candidate",
        action="append",
        required=True,
        metavar="AGENT_ID:axis=val,...",
        help="Candidate teammate. Repeat for each candidate.",
    )
    parser.add_argument(
        "--extras-dim",
        type=int,
        default=16,
        help="Extras-input dim. Must match the checkpoint.",
    )
    parser.add_argument(
        "--n-reference-states",
        type=int,
        default=_DEFAULT_N_REFERENCE,
        help="How many random reference boards to average over.",
    )
    args = parser.parse_args()

    candidates = [_parse_candidate(s) for s in args.candidate]

    if args.checkpoint:
        from sample_trainer import load_checkpoint
        net, match_count = load_checkpoint(args.checkpoint)
        print(f"# Loaded checkpoint after {match_count} matches: {args.checkpoint}")
    else:
        from sample_trainer import BackgammonNet
        net = BackgammonNet(extras_dim=args.extras_dim, core_seed=0xBACC, extras_seed=0)
        print("# WARNING: no --checkpoint supplied; using a freshly-initialized net.")

    rec = recommend_teammate(
        net,
        candidates,
        extras_dim=args.extras_dim,
        n_reference_states=args.n_reference_states,
    )
    for aid, eq in sorted(rec.equities.items(), key=lambda kv: -kv[1]):
        marker = "←" if aid == rec.best_teammate_id else " "
        print(f"  agent #{aid:<4} equity {eq:+.4f} {marker}")
    print(f"Best: #{rec.best_teammate_id}  (spread {rec.spread:.4f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
