"""challenge_trainer.py — multi-agent marketplace training with TD-λ and REINFORCE.

Agents propose challenges, accept or reject incoming ones based on Kelly
criterion and expected value (via score_opponent), and play out the accepted
matches. Win/Loss updates bankrolls and drives policy updates via REINFORCE.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional, TextIO

import subprocess
import torch
import torch.optim as optim

try:
    from torch.utils.tensorboard import SummaryWriter as _SummaryWriter
    _TB_AVAILABLE = True
except ImportError:
    _TB_AVAILABLE = False

from dotenv import load_dotenv
from pathlib import Path as _Path
_env_path = _Path(__file__).resolve().parents[1] / "server" / ".env"
load_dotenv(_env_path, override=False)

from agent_state_io import AgentState, load_or_seed, save_and_upload_checkpoint
from sample_trainer import DEFAULT_EXTRAS_DIM, td_lambda_match
from career_features import encode_career_context, CareerContext
from challenge_policy import ChallengePolicy

# Using the same phase G and hash logic from round_robin_trainer
from round_robin_trainer import (
    _resolve_weights_hash,
    _resolve_agent_style,
    _maybe_build_0g_infer_fn,
    TdMatchFn,
)

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


def run_challenge_loop(
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
    td_match: TdMatchFn = td_lambda_match,
    lr: float = 1e-3,
    lam: float = 0.7,
    gamma: float = 1.0,
    use_0g_inference: bool = False,
    logdir: Optional[str] = None,
) -> dict[int, AgentState]:

    if len(agent_ids) < 2:
        raise ValueError("challenge trainer requires at least 2 agent_ids")
    if epochs < 1:
        raise ValueError("epochs must be >= 1")

    writer = _SummaryWriter(logdir) if (logdir and _TB_AVAILABLE) else None
    global_match = 0

    _emit(
        status_fh, "started",
        agent_ids=agent_ids, epochs=epochs,
        use_0g_inference=bool(use_0g_inference),
    )

    infer_fn = _maybe_build_0g_infer_fn(use_0g_inference, status_fh)

    agents: dict[int, AgentState] = {}
    optimizers: dict[int, torch.optim.Optimizer] = {}
    policies: dict[int, ChallengePolicy] = {}
    bankrolls: dict[int, int] = {}
    matches_played: dict[int, int] = {aid: 0 for aid in agent_ids}

    # Each agent's public profile in the marketplace is its *real* style
    # overlay (fetched once via style_resolver), so the betting policy's
    # score_opponent conditions on genuine opponent styles instead of a
    # random vector. Cold-start agents resolve to {} -> a neutral profile.
    public_profiles = {aid: style_resolver(aid) for aid in agent_ids}

    for aid in agent_ids:
        wh = weights_hash_resolver(aid)
        agents[aid] = load_or_seed(
            aid,
            extras_dim=extras_dim,
            weights_hash=wh,
            fetch=fetch_blob,
        )
        policies[aid] = ChallengePolicy(agents[aid].net, extras_dim=extras_dim)
        # We perform REINFORCE on the extras head.
        optimizers[aid] = optim.Adam(agents[aid].net.extras.parameters(), lr=lr)

    _emit(
        status_fh, "agents_loaded",
        loaded={aid: a.profile_kind for aid, a in agents.items()},
    )


    for epoch in range(epochs):
        _emit(status_fh, "epoch_start", epoch=epoch, total=epochs)

        # Reset bankrolls
        for aid in agent_ids:
            bankrolls[aid] = starting_bankroll

        proposed_count = 0
        accepted_count = 0
        total_stake_wei = 0

        # 1. PROPOSE phase
        # proposer -> target -> (stake, log_prob)
        proposals: list[tuple[int, int, int, torch.Tensor, float]] = []

        for proposer in agent_ids:
            candidates = [a for a in agent_ids if a != proposer]
            scores = []

            for target in candidates:
                # To propose, we evaluate their style. What stake do we pass to score_opponent?
                # We can't size_bet until we have a score, but score requires a stake.
                # Let's pass min_stake to score_opponent initially just to rank targets.
                score = policies[proposer].score_opponent(public_profiles[target], min_stake)
                scores.append(score)

            # Form a softmax distribution over scores
            scores_tensor = torch.stack(scores)
            probs = torch.softmax(scores_tensor * 10.0, dim=0) # scale to sharpen distribution slightly

            # Sample a target
            dist = torch.distributions.Categorical(probs)
            action_idx = dist.sample()
            log_prob = dist.log_prob(action_idx)

            target = candidates[action_idx.item()]
            chosen_score = scores_tensor[action_idx].item()

            # Sizing bet
            stake = policies[proposer].size_bet(chosen_score, bankrolls[proposer], min_stake, max_stake_fraction)

            if stake > 0:
                # Recalculate score with actual stake to get the accurate EV?
                # Not strictly necessary for REINFORCE log_prob, but accurate for reporting.
                _emit(status_fh, "challenge_proposed", proposer=proposer, target=target, stake_wei=stake, score=chosen_score)
                proposals.append((proposer, target, stake, log_prob, chosen_score))
                proposed_count += 1

        # 2. RESPOND phase & 3. PLAY phase & 4. UPDATE
        for proposer, target, stake, log_prob, chosen_score in proposals:
            # target evaluates
            eval_score = policies[target].score_opponent(public_profiles[proposer], stake).item()

            if eval_score > accept_threshold:
                _emit(status_fh, "challenge_accepted", proposer=proposer, target=target, stake_wei=stake)
                accepted_count += 1
                total_stake_wei += stake

                # PLAY — both sides' extras carry the OPPONENT's real
                # public profile (set above), so td_lambda_match conditions
                # on genuine styles rather than a random career context.
                a_ctx = CareerContext(
                    opponent_style=public_profiles[target],
                    teammate_style=None,
                    stake_wei=stake,
                    tournament_position=0.0,
                    is_team_match=False
                )
                b_ctx = CareerContext(
                    opponent_style=public_profiles[proposer],
                    teammate_style=None,
                    stake_wei=stake,
                    tournament_position=0.0,
                    is_team_match=False
                )
                a_extras = encode_career_context(a_ctx, dim=extras_dim)
                b_extras = encode_career_context(b_ctx, dim=extras_dim)

                kwargs = {"gamma": gamma, "lam": lam, "lr": lr}
                if infer_fn is not None:
                    kwargs["infer_fn"] = infer_fn

                steps, won = td_match(
                    agents[proposer].net, agents[target].net,
                    a_extras, b_extras,
                    **kwargs,
                )

                winner = proposer if won else target
                _emit(
                    status_fh, "match",
                    proposer=proposer, target=target,
                    winner=winner, profit_wei=stake, plies=int(steps)
                )

                if writer:
                    writer.add_scalar("match/plies", steps, global_match)
                    writer.add_scalar(f"win/agent_{winner}", 1.0, global_match)
                    writer.add_scalar(f"bankroll/agent_{proposer}", bankrolls[proposer], global_match)
                    writer.add_scalar(f"bankroll/agent_{target}", bankrolls[target], global_match)
                    global_match += 1

                matches_played[proposer] += 1
                matches_played[target] += 1

                # UPDATE BANKROLL
                if won:
                    bankrolls[proposer] += stake
                    bankrolls[target] -= stake
                    reward = stake
                else:
                    bankrolls[target] += stake
                    bankrolls[proposer] -= stake
                    reward = -stake

                # UPDATE CHALLENGE POLICY (REINFORCE)
                optimizers[proposer].zero_grad()
                loss = -log_prob * float(reward)
                loss.backward()
                optimizers[proposer].step()

            else:
                _emit(status_fh, "challenge_rejected", proposer=proposer, target=target, reason="score_below_threshold")

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
                _emit(
                    status_fh, "agent_saved",
                    agent_id=aid, path=str(local_path), root_hash=root_hash,
                )
            except Exception as exc:
                _emit(
                    status_fh, "agent_save_error",
                    agent_id=aid, detail=str(exc),
                )

    return agents

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--agent-ids", type=lambda s: [int(x.strip()) for x in s.split(",") if x.strip()], required=True,
                        metavar="1,2,3", help="Comma-separated on-chain IDs.")
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
                        help="Write TensorBoard event files to this directory.")
    parser.add_argument("--launch-tensorboard", action="store_true",
                        help="Spawn 'tensorboard --logdir <logdir>' after training completes.")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    _install_sigterm_handler()

    completed = False
    with _maybe_open_status_file(args.status_file) as fh:
        try:
            run_challenge_loop(
                args.agent_ids,
                args.epochs,
                args.starting_bankroll,
                args.min_stake,
                args.max_stake_fraction,
                args.accept_threshold,
                extras_dim=args.extras_dim,
                logdir=args.logdir,
                seed=args.seed,
                status_fh=fh,
                checkpoint_dir=Path(args.checkpoint_dir) if args.checkpoint_dir else None,
                upload=args.upload_to_0g,
                encrypt=not args.no_encrypt,
                lr=args.lr,
                lam=args.lam,
                gamma=args.gamma,
                use_0g_inference=args.use_0g_inference,
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
