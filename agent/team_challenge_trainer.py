"""team_challenge_trainer.py — 2v2 marketplace training with TD-λ and REINFORCE.

Teams of two agents challenge other teams. The captain (first member) uses
ChallengePolicy to propose/accept via Kelly criterion. Accepted matches use
ensemble move selection (equity averaged across both team nets); both team
members get independent TD-lambda updates. The captain's challenge policy is
updated via REINFORCE on team win/loss.

Teams are formed in order from agent_ids: [(ids[0], ids[1]), (ids[2], ids[3]), ...].
At least 4 agent_ids (2 teams) are required.

Usage (CLI):

    cd agent && uv run python team_challenge_trainer.py \\
        --agent-ids 1,2,3,4 --epochs 20 \\
        --status-file /tmp/run.jsonl \\
        --checkpoint-dir /tmp/ckpt --upload-to-0g

    # With TensorBoard (optional):
    cd agent && uv run python team_challenge_trainer.py \\
        --agent-ids 1,2,3,4 --epochs 50 \\
        --logdir /tmp/tb_team
    # In another terminal:
    cd agent && uv run tensorboard --logdir /tmp/tb_team

TensorBoard scalars written per epoch (when --logdir is set):
    match/plies               — game length in plies
    win/team_<idx>            — 1.0 on each team win
    market/accept_rate        — fraction of challenges accepted
    market/avg_stake_wei      — mean stake per accepted match
    market/proposed           — challenges proposed in this epoch
    market/accepted           — challenges accepted in this epoch
    weights/core_l2_agent_<id>   — L2 norm of core network weights
    weights/extras_l2_agent_<id> — L2 norm of extras head (if present)
"""

from __future__ import annotations

import argparse
import json
import random
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional, TextIO

import torch
import torch.optim as optim

try:
    from torch.utils.tensorboard import SummaryWriter as _SummaryWriter
    _TB_AVAILABLE = True
except ImportError:
    _TB_AVAILABLE = False

from dotenv import load_dotenv
_env_path = Path(__file__).resolve().parents[1] / "server" / ".env"
load_dotenv(_env_path, override=False)

from agent_state_io import AgentState, load_or_seed, save_and_upload_checkpoint
from sample_trainer import (
    DEFAULT_EXTRAS_DIM,
    RaceState,
    encode_state,
    legal_successors,
)
from career_features import encode_career_context, CareerContext
from challenge_policy import ChallengePolicy
from round_robin_trainer import (
    _resolve_weights_hash,
    _resolve_agent_style,
    _maybe_build_0g_infer_fn,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _emit(fh: Optional[TextIO], event: str, **fields) -> None:
    if fh is None:
        return
    fields["event"] = event
    fields.setdefault("ts", time.time())
    fh.write(json.dumps(fields) + "\n")
    fh.flush()


@contextmanager
def _maybe_open_status_file(path: Optional[str]):
    if not path:
        yield None
        return
    fh = open(path, "a", buffering=1)
    try:
        yield fh
    finally:
        fh.close()


def _install_sigterm_handler() -> None:
    def _handler(signum, frame):
        sys.exit(0)
    signal.signal(signal.SIGTERM, _handler)


def _l2(module) -> float:
    return sum(p.norm().item() for p in module.parameters())


def _avg_styles(a: dict, b: dict) -> dict:
    """Average two style dicts key-by-key; keys absent from either default to 0."""
    keys = set(a) | set(b)
    return {k: (a.get(k, 0.0) + b.get(k, 0.0)) / 2.0 for k in keys}


# ── Core: 2v2 match ──────────────────────────────────────────────────────────

def _ensemble_pick(nets, extras_list, cands, perspective):
    """Pick the candidate with highest average equity across all nets (frozen)."""
    feats = torch.stack([encode_state(c, perspective) for c in cands])
    equities = []
    for net, ext in zip(nets, extras_list):
        with torch.no_grad():
            if getattr(net, "extras_dim", 0) > 0:
                eq = net(feats, ext.unsqueeze(0).expand(len(cands), -1))
            else:
                eq = net(feats)
        equities.append(eq)
    avg = torch.stack(equities).mean(dim=0)
    best = int(avg.argmax().item())
    return cands[best]


def team_td_match(
    team_a: list,
    team_b: list,
    team_a_extras: list[torch.Tensor],
    team_b_extras: list[torch.Tensor],
    *,
    gamma: float = 1.0,
    lam: float = 0.7,
    lr: float = 1e-3,
    state_factory=None,
) -> tuple[int, int]:
    """Play a 2v2 team match. team_a learns; team_b is frozen.

    Move selection uses ensemble equity averaging across both team members.
    Each net in team_a gets an independent TD-lambda update per turn.

    Returns (steps_taken, team_a_won_int).
    """
    state = state_factory() if state_factory is not None else RaceState()

    eligibilities = [
        {p: torch.zeros_like(p) for p in net.parameters()}
        for net in team_a
    ]

    while not state.terminal():
        d1 = random.randint(1, 6)
        d2 = random.randint(1, 6)
        state.dice = (d1, d2)
        cands = legal_successors(state, state.dice)

        if state.turn == 0:
            chosen = _ensemble_pick(team_a, team_a_extras, cands, perspective=0)

            done = chosen.terminal()
            if done:
                target = 1.0 if chosen.winner() == 0 else 0.0
            else:
                with torch.no_grad():
                    board_next = encode_state(chosen, perspective=0)
                    vnexts = []
                    for net, ext in zip(team_a, team_a_extras):
                        if getattr(net, "extras_dim", 0) > 0:
                            vnexts.append(net(board_next.unsqueeze(0), ext.unsqueeze(0)).item())
                        else:
                            vnexts.append(net(board_next.unsqueeze(0)).item())
                target = gamma * (sum(vnexts) / len(vnexts))

            for net, ext, elig in zip(team_a, team_a_extras, eligibilities):
                board_now = encode_state(state, perspective=0)
                if getattr(net, "extras_dim", 0) > 0:
                    v_now = net(board_now.unsqueeze(0), ext.unsqueeze(0))
                else:
                    v_now = net(board_now.unsqueeze(0))

                td_error = target - v_now.item()

                net.zero_grad()
                v_now.sum().backward()
                with torch.no_grad():
                    for p in net.parameters():
                        if p.grad is None:
                            continue
                        elig[p].mul_(gamma * lam).add_(p.grad)
                        p.add_(lr * td_error * elig[p])

            state = chosen
        else:
            chosen = _ensemble_pick(team_b, team_b_extras, cands, perspective=1)
            state = chosen

    winner = state.winner() or 0
    return state.n_turns, int(winner == 0)


# ── Main training loop ────────────────────────────────────────────────────────

def run_team_challenge_loop(
    agent_ids: list[int],
    epochs: int,
    starting_bankroll: int,
    min_stake: int,
    max_stake_fraction: float,
    accept_threshold: float,
    *,
    extras_dim: int = DEFAULT_EXTRAS_DIM,
    seed: int = 42,
    status_fh: Optional[TextIO] = None,
    checkpoint_dir: Optional[Path] = None,
    upload: bool = False,
    encrypt: bool = True,
    weights_hash_resolver: Callable[[int], str] = _resolve_weights_hash,
    style_resolver: Callable[[int], dict[str, float]] = _resolve_agent_style,
    fetch_blob: Optional[Callable[[str], bytes]] = None,
    lr: float = 1e-3,
    lam: float = 0.7,
    gamma: float = 1.0,
    use_0g_inference: bool = False,
    logdir: Optional[str] = None,
) -> dict[int, AgentState]:
    if len(agent_ids) < 4 or len(agent_ids) % 2 != 0:
        raise ValueError("team_challenge trainer requires an even number of agent_ids >= 4")
    if epochs < 1:
        raise ValueError("epochs must be >= 1")

    # Form teams: [(id0, id1), (id2, id3), ...]
    team_ids: list[tuple[int, int]] = [
        (agent_ids[i], agent_ids[i + 1]) for i in range(0, len(agent_ids), 2)
    ]
    if len(team_ids) < 2:
        raise ValueError("need at least 2 teams")

    writer = _SummaryWriter(logdir) if (logdir and _TB_AVAILABLE) else None
    global_match = 0

    _emit(status_fh, "started", agent_ids=agent_ids, epochs=epochs, teams=team_ids)

    _maybe_build_0g_infer_fn(use_0g_inference, status_fh)  # warn if unsupported

    agents: dict[int, AgentState] = {}
    public_profiles: dict[int, dict] = {}

    for aid in agent_ids:
        wh = weights_hash_resolver(aid)
        agents[aid] = load_or_seed(
            aid, extras_dim=extras_dim, weights_hash=wh, fetch=fetch_blob,
        )
        public_profiles[aid] = style_resolver(aid)

    _emit(status_fh, "agents_loaded", loaded={aid: a.profile_kind for aid, a in agents.items()})

    # One ChallengePolicy and optimizer per team (captain = first member).
    team_policies: dict[int, ChallengePolicy] = {}
    team_optimizers: dict[int, torch.optim.Optimizer] = {}
    for ti, (cap_id, _) in enumerate(team_ids):
        team_policies[ti] = ChallengePolicy(agents[cap_id].net, extras_dim=extras_dim)
        team_optimizers[ti] = optim.Adam(agents[cap_id].net.extras.parameters(), lr=lr)

    bankrolls: dict[int, int] = {}
    matches_played: dict[int, int] = {aid: 0 for aid in agent_ids}

    for epoch in range(epochs):
        _emit(status_fh, "epoch_start", epoch=epoch, total=epochs)

        for ti in range(len(team_ids)):
            bankrolls[ti] = starting_bankroll

        proposed_count = 0
        accepted_count = 0
        total_stake_wei = 0

        # PROPOSE: each team captain evaluates all other teams and samples one to challenge.
        proposals: list[tuple[int, int, int, torch.Tensor, float]] = []

        for proposer_ti, (pcap, pmem) in enumerate(team_ids):
            other_teams = [ti for ti in range(len(team_ids)) if ti != proposer_ti]
            scores = []

            for target_ti in other_teams:
                tcap, tmem = team_ids[target_ti]
                opp_style = _avg_styles(public_profiles[tcap], public_profiles[tmem])
                score = team_policies[proposer_ti].score_opponent(opp_style, min_stake)
                scores.append(score)

            scores_tensor = torch.stack(scores)
            probs = torch.softmax(scores_tensor * 10.0, dim=0)
            dist = torch.distributions.Categorical(probs)
            action_idx = dist.sample()
            log_prob = dist.log_prob(action_idx)

            target_ti = other_teams[action_idx.item()]
            chosen_score = scores_tensor[action_idx].item()

            stake = team_policies[proposer_ti].size_bet(
                chosen_score, bankrolls[proposer_ti], min_stake, max_stake_fraction
            )

            if stake > 0:
                _emit(status_fh, "challenge_proposed",
                      proposer_team=proposer_ti, target_team=target_ti,
                      stake_wei=stake, score=chosen_score)
                proposals.append((proposer_ti, target_ti, stake, log_prob, chosen_score))
                proposed_count += 1

        # RESPOND + PLAY + UPDATE
        for proposer_ti, target_ti, stake, log_prob, chosen_score in proposals:
            tcap, tmem = team_ids[target_ti]
            pcap, pmem = team_ids[proposer_ti]
            prop_opp_style = _avg_styles(public_profiles[tcap], public_profiles[tmem])
            tgt_eval_score = team_policies[target_ti].score_opponent(
                _avg_styles(public_profiles[pcap], public_profiles[pmem]), stake
            ).item()

            if tgt_eval_score > accept_threshold:
                _emit(status_fh, "challenge_accepted",
                      proposer_team=proposer_ti, target_team=target_ti, stake_wei=stake)
                accepted_count += 1
                total_stake_wei += stake

                # Build extras for each member of both teams.
                # Team A (proposer): teammate = pmem, opponent = avg(tcap, tmem)
                # Team B (target):   teammate = tmem, opponent = avg(pcap, pmem)
                opp_of_a = _avg_styles(public_profiles[tcap], public_profiles[tmem])
                opp_of_b = _avg_styles(public_profiles[pcap], public_profiles[pmem])

                def _make_extras(self_id, teammate_id, opp_style):
                    ctx = CareerContext(
                        self_style=public_profiles[self_id],
                        opponent_style=opp_style,
                        teammate_style=public_profiles[teammate_id],
                        stake_wei=stake,
                        tournament_position=0.0,
                        is_team_match=True,
                    )
                    return encode_career_context(ctx, dim=extras_dim)

                team_a_extras = [
                    _make_extras(pcap, pmem, opp_of_a),
                    _make_extras(pmem, pcap, opp_of_a),
                ]
                team_b_extras = [
                    _make_extras(tcap, tmem, opp_of_b),
                    _make_extras(tmem, tcap, opp_of_b),
                ]

                team_a_nets = [agents[pcap].net, agents[pmem].net]
                team_b_nets = [agents[tcap].net, agents[tmem].net]

                steps, won = team_td_match(
                    team_a_nets, team_b_nets,
                    team_a_extras, team_b_extras,
                    gamma=gamma, lam=lam, lr=lr,
                )

                winner_ti = proposer_ti if won else target_ti
                _emit(status_fh, "match",
                      proposer_team=proposer_ti, target_team=target_ti,
                      winner_team=winner_ti, stake_wei=stake, plies=int(steps))

                if writer:
                    writer.add_scalar("match/plies", steps, global_match)
                    writer.add_scalar(f"win/team_{winner_ti}", 1.0, global_match)
                    global_match += 1

                for aid in (pcap, pmem):
                    matches_played[aid] += 1
                for aid in (tcap, tmem):
                    matches_played[aid] += 1

                if won:
                    bankrolls[proposer_ti] += stake
                    bankrolls[target_ti] -= stake
                    reward = stake
                else:
                    bankrolls[target_ti] += stake
                    bankrolls[proposer_ti] -= stake
                    reward = -stake

                # REINFORCE update for proposer captain's challenge policy.
                team_optimizers[proposer_ti].zero_grad()
                loss = -log_prob * float(reward)
                loss.backward()
                team_optimizers[proposer_ti].step()

            else:
                _emit(status_fh, "challenge_rejected",
                      proposer_team=proposer_ti, target_team=target_ti,
                      reason="score_below_threshold")

        accept_rate = accepted_count / proposed_count if proposed_count > 0 else 0.0
        avg_stake = total_stake_wei / accepted_count if accepted_count > 0 else 0.0
        _emit(status_fh, "epoch_end", epoch=epoch, accept_rate=accept_rate, avg_stake_wei=avg_stake)

        if writer:
            writer.add_scalar("market/accept_rate", accept_rate, epoch)
            writer.add_scalar("market/avg_stake_wei", avg_stake, epoch)
            writer.add_scalar("market/proposed", proposed_count, epoch)
            writer.add_scalar("market/accepted", accepted_count, epoch)
            for aid, state in agents.items():
                writer.add_scalar(f"weights/core_l2_agent_{aid}", _l2(state.net.core), epoch)
                if state.net.extras is not None:
                    writer.add_scalar(f"weights/extras_l2_agent_{aid}", _l2(state.net.extras), epoch)

    _emit(status_fh, "training_complete")
    if writer:
        writer.close()

    if checkpoint_dir is not None:
        for aid, state in agents.items():
            try:
                local_path, root_hash = save_and_upload_checkpoint(
                    state,
                    checkpoint_dir=Path(checkpoint_dir),
                    upload=upload,
                    encrypt=encrypt,
                    matches_played=matches_played[aid],
                )
                _emit(status_fh, "agent_saved",
                      agent_id=aid, path=str(local_path), root_hash=root_hash)
            except Exception as exc:
                _emit(status_fh, "agent_save_error", agent_id=aid, detail=str(exc))

    return agents


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--agent-ids",
        type=lambda s: [int(x.strip()) for x in s.split(",") if x.strip()],
        required=True, metavar="1,2,3,4",
        help="Comma-separated on-chain IDs (even count, >= 4). Pairs form teams.",
    )
    parser.add_argument("--epochs", type=int, required=True)
    parser.add_argument("--starting-bankroll", type=int, default=100000)
    parser.add_argument("--min-stake", type=int, default=1000)
    parser.add_argument("--max-stake-fraction", type=float, default=0.25)
    parser.add_argument("--accept-threshold", type=float, default=0.45)
    parser.add_argument("--status-file", type=str, default=None)
    parser.add_argument("--checkpoint-dir", type=str, default=None)
    parser.add_argument("--extras-dim", type=int, default=DEFAULT_EXTRAS_DIM)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--lam", type=float, default=0.7)
    parser.add_argument("--gamma", type=float, default=1.0)
    parser.add_argument("--upload-to-0g", action="store_true")
    parser.add_argument("--no-encrypt", action="store_true")
    parser.add_argument("--use-0g-inference", action="store_true")
    parser.add_argument("--logdir", type=str, default=None,
                        help="TensorBoard event directory.")
    parser.add_argument("--launch-tensorboard", action="store_true")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    _install_sigterm_handler()

    completed = False
    with _maybe_open_status_file(args.status_file) as fh:
        try:
            run_team_challenge_loop(
                args.agent_ids,
                args.epochs,
                args.starting_bankroll,
                args.min_stake,
                args.max_stake_fraction,
                args.accept_threshold,
                extras_dim=args.extras_dim,
                seed=args.seed,
                status_fh=fh,
                checkpoint_dir=Path(args.checkpoint_dir) if args.checkpoint_dir else None,
                upload=args.upload_to_0g,
                encrypt=not args.no_encrypt,
                lr=args.lr,
                lam=args.lam,
                gamma=args.gamma,
                use_0g_inference=args.use_0g_inference,
                logdir=args.logdir,
            )
            completed = True
        finally:
            _emit(fh, "done" if completed else "aborted")

    if args.logdir and args.launch_tensorboard:
        print(f"Launching TensorBoard at http://localhost:6006  (logdir: {args.logdir})")
        subprocess.Popen(["tensorboard", "--logdir", args.logdir])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
