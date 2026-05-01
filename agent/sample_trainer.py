"""sample_trainer.py — runnable demo of agent NN training.

Trains a per-agent BackgammonNet via self-play TD(lambda), starting from
gnubg-style published weights for the shared "core" feature backbone and
randomly initialized weights for each agent's "extra" contextual head.
Writes TensorBoard event files (scalars, histograms, model graph) under
`./runs/<run_name>` and optionally launches the TensorBoard dashboard.

Two networks share the same gnubg-derived `core` backbone:
  - `agent`     — being trained, owns its own random `extras` head.
  - `opponent`  — frozen, owns a *different* random `extras` head.

This file is the runnable counterpart of the README's "How agents are
trained" section. The environment here is a deliberately tiny pip-race
abstraction (single integer per side, dice subtract, first to zero
wins) — enough to give the value network a real learnable signal
without re-implementing backgammon's full rule set. Production training
swaps `RaceEnv` for a full backgammon engine driving the same encoder
shape; the training mechanics (TD(lambda) eligibility traces, gnubg
init, per-agent random extras, TensorBoard logging) stay identical.

Usage:

    python sample_trainer.py --matches 200 --launch-tensorboard

then open http://localhost:6006 to watch loss, win-rate, and parameter
histograms evolve. Without --launch-tensorboard the script just writes
events; run `tensorboard --logdir runs` separately to view them.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import torch
from torch import nn
from torch.utils.tensorboard import SummaryWriter

from drand_dice import derive_dice


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

# gnubg's contact net is documented to use ~198 inputs (24 points x 4 unary
# indicators per side, plus bar / borne-off counts, pip count, and a few
# extras). We mirror that input dim so feature encoders ported from gnubg
# slot in unmodified. The "extras" head is whatever per-agent context the
# career-mode policy wants — opponent-style profile, teammate signals,
# tournament position, stake size, etc.
GNUBG_FEAT_DIM = 198
DEFAULT_HIDDEN = 80
DEFAULT_EXTRAS_DIM = 16


def gnubg_published_core_init(in_dim: int, hidden: int, *, seed: int = 0xBACC) -> nn.Linear:
    """Return a Linear(in_dim, hidden) layer whose weights stand in for
    gnubg's published feedforward weights.

    In production the caller would load the actual gnubg weights file
    (`weights` / `gnubg.weights` from the gnubg source distribution),
    convert it to a torch state_dict, and load it here. For the runnable
    demo we deterministically initialize from a fixed seed — what
    matters for the rest of the pipeline is that *every agent* starts
    from the *same* core weights, which a shared deterministic init
    captures exactly.
    """
    g = torch.Generator().manual_seed(seed)
    layer = nn.Linear(in_dim, hidden)
    with torch.no_grad():
        # Xavier-uniform stand-in for the published gnubg distribution.
        bound = math.sqrt(6.0 / (in_dim + hidden))
        layer.weight.uniform_(-bound, bound, generator=g)
        layer.bias.zero_()
    return layer


class BackgammonNet(nn.Module):
    """Per-agent value network: predicts win equity from (board, extras).

    Architecture mirrors TD-Gammon / gnubg's contact net (small MLP with
    sigmoid output) with one addition: an `extras` linear head that
    consumes per-agent contextual features (opponent style, team
    signals, tournament position, stake size — anything that should
    affect the policy in career mode but not in single-game mode).

    Weight layout:
      core  : Linear(GNUBG_FEAT_DIM, hidden)  — initialized from gnubg.
      extras: Linear(extras_dim,   hidden)    — randomly initialized.
      head  : Linear(hidden,       1)         — randomly initialized.

    When `extras_dim == 0` or the extras input is zero, the network's
    behaviour reduces to the gnubg-equivalent single-game head.
    """

    def __init__(
        self,
        in_dim: int = GNUBG_FEAT_DIM,
        hidden: int = DEFAULT_HIDDEN,
        extras_dim: int = DEFAULT_EXTRAS_DIM,
        *,
        core_seed: int = 0xBACC,
        extras_seed: int | None = None,
    ) -> None:
        super().__init__()
        self.core = gnubg_published_core_init(in_dim, hidden, seed=core_seed)
        if extras_dim > 0:
            self.extras = nn.Linear(extras_dim, hidden)
            if extras_seed is not None:
                # Each agent gets its own random extras head — same core,
                # different "personality." Two agents minted from the same
                # gnubg weights with different extras_seed will diverge in
                # play after enough training.
                g = torch.Generator().manual_seed(extras_seed)
                bound = math.sqrt(6.0 / (extras_dim + hidden))
                with torch.no_grad():
                    self.extras.weight.uniform_(-bound, bound, generator=g)
                    self.extras.bias.zero_()
        else:
            self.extras = None
        self.head = nn.Linear(hidden, 1)
        with torch.no_grad():
            nn.init.xavier_uniform_(self.head.weight)
            self.head.bias.zero_()

    def forward(self, board: torch.Tensor, extras: torch.Tensor | None = None) -> torch.Tensor:
        h = torch.sigmoid(self.core(board))
        if self.extras is not None and extras is not None:
            h = h + torch.sigmoid(self.extras(extras))
        # Equity in [0, 1] — probability the side to move wins.
        return torch.sigmoid(self.head(h)).squeeze(-1)


# ---------------------------------------------------------------------------
# Environment — minimal pip-race abstraction
# ---------------------------------------------------------------------------

START_PIP = 60   # 15 checkers x ~4 average pips, rounded for the demo.
MAX_TURNS = 200  # Force termination if the race somehow stalls.


@dataclass
class RaceState:
    """State of a two-player pip race.

    `pip[0]` / `pip[1]` are pip counts for sides 0 and 1. Lower = closer
    to winning. Side 0 starts on roll. `dice` is set when it's the
    side-to-move's turn to commit a move.
    """
    pip: list[int] = field(default_factory=lambda: [START_PIP, START_PIP])
    turn: int = 0
    dice: tuple[int, int] | None = None
    n_turns: int = 0

    def terminal(self) -> bool:
        return self.pip[0] <= 0 or self.pip[1] <= 0 or self.n_turns >= MAX_TURNS

    def winner(self) -> int | None:
        if self.pip[0] <= 0:
            return 0
        if self.pip[1] <= 0:
            return 1
        if self.n_turns >= MAX_TURNS:
            # Tiebreak by smaller remaining pip count.
            return 0 if self.pip[0] < self.pip[1] else 1
        return None


def encode_state(state: RaceState, perspective: int) -> torch.Tensor:
    """Encode `state` into a GNUBG_FEAT_DIM-shaped vector from
    `perspective`'s point of view.

    The first 99 dims encode a unary thermometer of the perspective's pip
    count (lower = closer to winning); the next 99 dims encode the
    opponent's. Production code uses gnubg's exact 198-dim contact-net
    encoding here.
    """
    feat = torch.zeros(GNUBG_FEAT_DIM)
    me = max(0, min(99, state.pip[perspective]))
    op = max(0, min(99, state.pip[1 - perspective]))
    feat[:me] = 1.0
    feat[99:99 + op] = 1.0
    return feat


def encode_extras(extras_dim: int, agent_id: int, *, seed: int) -> torch.Tensor:
    """Per-agent contextual feature vector (the "personality" inputs).

    Production code would compute this from teammate identity,
    opponent style profile, tournament position, stake size, etc. For
    the demo we use a deterministic per-agent random projection so the
    extras head has *something* to learn.
    """
    g = torch.Generator().manual_seed(seed + agent_id)
    return torch.randn(extras_dim, generator=g)


def legal_successors(state: RaceState, dice: tuple[int, int]) -> list[RaceState]:
    """Enumerate up to 4 candidate successor states for `state` given
    `dice`. The race-env is too simple to have real choice, so we
    fabricate plausible variants (use both dice / drop one die / play
    the larger first). The point is to give the value network *some*
    selection problem to solve."""
    d1, d2 = dice
    side = state.turn
    new_pips = list(state.pip)
    candidates: list[RaceState] = []

    def _make(advance: int) -> RaceState:
        nxt = list(state.pip)
        nxt[side] = max(0, nxt[side] - advance)
        return RaceState(pip=nxt, turn=1 - side, dice=None, n_turns=state.n_turns + 1)

    seen: set[int] = set()
    for advance in (d1 + d2, max(d1, d2), min(d1, d2), d1, d2):
        if advance in seen:
            continue
        seen.add(advance)
        candidates.append(_make(advance))
        if len(candidates) >= 4:
            break
    return candidates


# ---------------------------------------------------------------------------
# Self-play training loop with TD(lambda)
# ---------------------------------------------------------------------------


def pick_move(net: BackgammonNet, candidates: list[RaceState], extras: torch.Tensor,
              perspective: int) -> tuple[RaceState, torch.Tensor]:
    """Greedily pick the candidate that maximizes net's predicted equity
    for `perspective`. Returns the (chosen state, V-tensor for chosen)."""
    feats = torch.stack([encode_state(c, perspective) for c in candidates])
    with torch.no_grad():
        ext = extras.unsqueeze(0).expand(len(candidates), -1) if net.extras is not None else None
        equities = net(feats, ext)
    best = int(equities.argmax().item())
    return candidates[best], equities[best:best + 1]


def td_lambda_match(
    agent: BackgammonNet,
    opponent: BackgammonNet,
    agent_extras: torch.Tensor,
    opponent_extras: torch.Tensor,
    *,
    gamma: float = 1.0,
    lam: float = 0.7,
    lr: float = 1e-3,
    writer: SummaryWriter | None = None,
    global_step: int = 0,
    drand_round_digest: bytes | None = None,
) -> tuple[int, int]:
    """Play a single self-play match. `agent` learns; `opponent` is frozen.

    Returns `(steps_taken, agent_won_int)`. Logs per-step TD error and
    eligibility-trace norm to TensorBoard when `writer` is provided.

    `drand_round_digest`: when supplied, every turn's dice are derived
    via `drand_dice.derive_dice(digest, turn_index)` — the same
    deterministic mapping production code uses with KeeperHub's pulled
    drand rounds. When None, falls back to local PRNG so the demo runs
    standalone without a fixed digest.
    """
    state = RaceState()
    eligibility = {p: torch.zeros_like(p) for p in agent.parameters()}

    while not state.terminal():
        # Dice: derive from the drand round digest in production-shaped
        # mode, or fall back to local PRNG for the standalone demo.
        if drand_round_digest is not None:
            roll = derive_dice(drand_round_digest, turn_index=state.n_turns)
            d1, d2 = roll.d1, roll.d2
        else:
            d1 = random.randint(1, 6)
            d2 = random.randint(1, 6)
        state.dice = (d1, d2)
        cands = legal_successors(state, state.dice)

        if state.turn == 0:
            # Agent's turn — selects a successor and learns from the transition.
            board_now = encode_state(state, perspective=0)
            v_now = agent(board_now.unsqueeze(0),
                          agent_extras.unsqueeze(0)) if agent.extras is not None else \
                    agent(board_now.unsqueeze(0))

            chosen, _ = pick_move(agent, cands, agent_extras, perspective=0)
            with torch.no_grad():
                board_next = encode_state(chosen, perspective=0)
                v_next_t = agent(board_next.unsqueeze(0),
                                 agent_extras.unsqueeze(0)) if agent.extras is not None else \
                          agent(board_next.unsqueeze(0))
                v_next = v_next_t.item()

            # Terminal reward is observed when the chosen state is terminal
            # for the agent's side; otherwise we bootstrap from V(s').
            done_after_move = chosen.terminal()
            if done_after_move:
                reward = 1.0 if chosen.winner() == 0 else 0.0
                target = reward
            else:
                target = gamma * v_next

            td_error = target - v_now.item()

            # Backprop the *value* prediction (not the TD error itself):
            # eligibility traces accumulate ∇V(s_t), and the parameter
            # update is `+lr * td_error * eligibility`. This is the
            # canonical TD(lambda) gradient step.
            agent.zero_grad()
            v_now.sum().backward()
            with torch.no_grad():
                grad_norm_sq = 0.0
                for p in agent.parameters():
                    if p.grad is None:
                        continue
                    eligibility[p].mul_(gamma * lam).add_(p.grad)
                    p.add_(lr * td_error * eligibility[p])
                    grad_norm_sq += float(p.grad.pow(2).sum().item())

            if writer is not None:
                step = global_step + state.n_turns
                writer.add_scalar("train/td_error", td_error, step)
                writer.add_scalar("train/v_now", v_now.item(), step)
                writer.add_scalar("train/v_next", v_next, step)
                writer.add_scalar("train/grad_norm", math.sqrt(grad_norm_sq), step)
                elig_norm = math.sqrt(sum(float(e.pow(2).sum().item())
                                          for e in eligibility.values()))
                writer.add_scalar("train/eligibility_norm", elig_norm, step)

            state = chosen
        else:
            # Opponent's turn — frozen network picks greedily; no learning.
            chosen, _ = pick_move(opponent, cands, opponent_extras, perspective=1)
            state = chosen

    winner = state.winner() or 0
    return state.n_turns, int(winner == 0)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def evaluate(agent: BackgammonNet, opponent: BackgammonNet,
             agent_extras: torch.Tensor, opponent_extras: torch.Tensor,
             n_matches: int = 20) -> float:
    """Win rate of `agent` vs `opponent` over `n_matches` greedy games."""
    wins = 0
    for _ in range(n_matches):
        state = RaceState()
        while not state.terminal():
            d1, d2 = random.randint(1, 6), random.randint(1, 6)
            cands = legal_successors(state, (d1, d2))
            if state.turn == 0:
                state, _ = pick_move(agent, cands, agent_extras, perspective=0)
            else:
                state, _ = pick_move(opponent, cands, opponent_extras, perspective=1)
        if state.winner() == 0:
            wins += 1
    return wins / n_matches


def maybe_launch_tensorboard(logdir: Path) -> subprocess.Popen | None:
    """Spawn `tensorboard --logdir <logdir>` as a child process if the
    binary is on PATH. Returns the Popen handle so the caller can wait
    for Ctrl+C, or None if the binary is missing."""
    binary = shutil.which("tensorboard")
    if binary is None:
        print("tensorboard binary not on PATH — skipping dashboard launch.", file=sys.stderr)
        print("Install with: uv add tensorboard  (or pip install tensorboard)", file=sys.stderr)
        return None
    print(f"Launching TensorBoard at http://localhost:6006 (logdir={logdir})")
    return subprocess.Popen(
        [binary, "--logdir", str(logdir), "--port", "6006", "--bind_all"],
        stdout=sys.stdout, stderr=sys.stderr,
    )


def save_checkpoint(net: BackgammonNet, path: Path, *, match_count: int,
                    extras_dim: int) -> None:
    """Persist the agent's state_dict + the metadata needed to rebuild
    the network shape on load. Production code wraps this with
    AES-256-GCM and uploads to 0G Storage; the local file format here
    is the same shape, just unencrypted."""
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": net.state_dict(),
        "match_count": match_count,
        "extras_dim": extras_dim,
        "in_dim": GNUBG_FEAT_DIM,
        "hidden": DEFAULT_HIDDEN,
    }, path)


def load_checkpoint(path: Path) -> tuple[BackgammonNet, int]:
    """Load a checkpoint written by `save_checkpoint`. Returns
    `(net, match_count)`. The net is rebuilt with the shape recorded
    in the checkpoint metadata, then the state_dict is loaded into it.
    `weights_only=True` keeps load safe against malicious pickles."""
    blob = torch.load(path, weights_only=True)
    net = BackgammonNet(
        in_dim=blob["in_dim"],
        hidden=blob["hidden"],
        extras_dim=blob["extras_dim"],
    )
    net.load_state_dict(blob["state_dict"])
    return net, int(blob["match_count"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--matches", type=int, default=100,
                        help="Number of self-play training matches (default: 100).")
    parser.add_argument("--lr", type=float, default=1e-3, help="Learning rate.")
    parser.add_argument("--lam", type=float, default=0.7, help="TD(lambda) trace decay.")
    parser.add_argument("--gamma", type=float, default=1.0, help="Discount factor.")
    parser.add_argument("--logdir", type=str, default="runs/sample_trainer",
                        help="TensorBoard log directory (default: runs/sample_trainer).")
    parser.add_argument("--launch-tensorboard", action="store_true",
                        help="Spawn `tensorboard --logdir <logdir>` after training.")
    parser.add_argument("--seed", type=int, default=42, help="Python+torch RNG seed.")
    parser.add_argument("--extras-dim", type=int, default=DEFAULT_EXTRAS_DIM,
                        help="Per-agent contextual feature dim (0 = single-game head).")
    parser.add_argument("--save-checkpoint", type=str, default=None,
                        help="Path to write the trained agent's checkpoint "
                             "(.pt). Skipped if unset.")
    parser.add_argument("--load-checkpoint", type=str, default=None,
                        help="Path to a checkpoint to resume training from. "
                             "Bypasses the gnubg-init core; the opponent is "
                             "still freshly initialized with extras_seed=2.")
    parser.add_argument("--drand-digest", type=str, default=None,
                        help="Hex-encoded drand round digest. When set, "
                             "every turn's dice are derived via "
                             "drand_dice.derive_dice(digest, turn_index) "
                             "— the same deterministic mapping production "
                             "uses. Without this flag, dice come from the "
                             "local PRNG (standalone demo mode).")
    args = parser.parse_args()

    drand_digest = bytes.fromhex(args.drand_digest) if args.drand_digest else None

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    # Both nets share core weights (gnubg-init); each has its own extras head.
    starting_match_count = 0
    if args.load_checkpoint:
        agent, starting_match_count = load_checkpoint(Path(args.load_checkpoint))
        print(f"Resumed from {args.load_checkpoint} (match_count={starting_match_count}).")
    else:
        agent = BackgammonNet(extras_dim=args.extras_dim, core_seed=0xBACC, extras_seed=1)
    opponent = BackgammonNet(extras_dim=args.extras_dim, core_seed=0xBACC, extras_seed=2)

    agent_extras = (encode_extras(args.extras_dim, agent_id=1, seed=args.seed)
                    if args.extras_dim > 0 else torch.zeros(0))
    opponent_extras = (encode_extras(args.extras_dim, agent_id=2, seed=args.seed)
                       if args.extras_dim > 0 else torch.zeros(0))

    # Sanity check: at fresh init both nets share the gnubg-init core.
    # Skip when loading from a checkpoint — the agent's core has already
    # diverged from the gnubg init through prior training.
    if not args.load_checkpoint:
        assert torch.allclose(agent.core.weight, opponent.core.weight), \
            "core weights should be identical at init (both seeded from gnubg published init)"

    logdir = Path(args.logdir)
    logdir.mkdir(parents=True, exist_ok=True)
    writer = SummaryWriter(log_dir=str(logdir))

    # Log model architecture to the TensorBoard "Graphs" tab.
    sample_board = torch.zeros(1, GNUBG_FEAT_DIM)
    if args.extras_dim > 0:
        writer.add_graph(agent, (sample_board, agent_extras.unsqueeze(0)))
    else:
        writer.add_graph(agent, sample_board)

    # Baseline win rate before training.
    baseline_wr = evaluate(agent, opponent, agent_extras, opponent_extras, n_matches=20)
    writer.add_scalar("eval/win_rate_vs_frozen", baseline_wr, 0)
    print(f"Baseline win rate (untrained): {baseline_wr:.2%}")

    global_step = 0
    rolling_outcomes: list[int] = []

    t0 = time.time()
    for match_idx in range(args.matches):
        steps, won = td_lambda_match(
            agent, opponent, agent_extras, opponent_extras,
            gamma=args.gamma, lam=args.lam, lr=args.lr,
            writer=writer, global_step=global_step,
            drand_round_digest=drand_digest,
        )
        global_step += steps
        rolling_outcomes.append(won)
        if len(rolling_outcomes) > 50:
            rolling_outcomes.pop(0)

        writer.add_scalar("match/won", won, match_idx)
        writer.add_scalar("match/length", steps, match_idx)
        writer.add_scalar("match/rolling_win_rate",
                          sum(rolling_outcomes) / len(rolling_outcomes), match_idx)

        # Periodic histograms — let the user see weights and gradients drift
        # over training in the TensorBoard "Distributions" / "Histograms" tabs.
        if (match_idx + 1) % 25 == 0 or match_idx == args.matches - 1:
            for name, p in agent.named_parameters():
                writer.add_histogram(f"params/{name}", p, match_idx)
                if p.grad is not None:
                    writer.add_histogram(f"grads/{name}", p.grad, match_idx)
            wr = evaluate(agent, opponent, agent_extras, opponent_extras, n_matches=20)
            writer.add_scalar("eval/win_rate_vs_frozen", wr, match_idx + 1)
            print(f"  match {match_idx + 1:>4}/{args.matches}  "
                  f"rolling win-rate {sum(rolling_outcomes)/len(rolling_outcomes):.2%}  "
                  f"eval vs frozen {wr:.2%}")

    final_wr = evaluate(agent, opponent, agent_extras, opponent_extras, n_matches=50)
    elapsed = time.time() - t0
    print(f"\nDone. {args.matches} matches in {elapsed:.1f}s. "
          f"Final win rate vs frozen opponent: {final_wr:.2%}")
    print(f"TensorBoard events: {logdir}")
    print(f"View with: tensorboard --logdir {logdir}")

    if args.save_checkpoint:
        ckpt_path = Path(args.save_checkpoint)
        save_checkpoint(agent, ckpt_path,
                        match_count=starting_match_count + args.matches,
                        extras_dim=args.extras_dim)
        print(f"Saved checkpoint: {ckpt_path}")

    writer.close()

    if args.launch_tensorboard:
        proc = maybe_launch_tensorboard(logdir)
        if proc is not None:
            try:
                proc.wait()
            except KeyboardInterrupt:
                proc.terminate()
                proc.wait()


if __name__ == "__main__":
    main()
