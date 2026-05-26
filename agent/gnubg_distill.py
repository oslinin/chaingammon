"""gnubg_distill.py — distill gnubg into the uniform 198->equity net.

Realises the chosen architecture (fork "Y"): rather than running gnubg's real
multi-net evaluator at inference (which can't be a single uniform ONNX and
would need bespoke runtime code in the browser and server), we train a standard
BackgammonNet-shaped net (Linear(198,hidden) -> sigmoid -> Linear(hidden,1) ->
sigmoid) to reproduce gnubg's win probability. The result is an ordinary
uniform-contract model: it exports to the same `features -> equity` ONNX every
other agent uses, runs identically in the browser (play) and on the server
(training compute), needs no change to the model-agnostic training pipeline,
and gets n-ply lookahead for free via the existing search_depth property.

Pipeline:
  1. generate_training_data: self-play rollouts (gnubg-guided by default, with
     endgame seeding) collect positions across the game; each is encoded with
     the SAME 198-dim encoder used at inference (gnubg_encoder.encode_full_board)
     and labelled with gnubg's P(win) for the side to move (agent/gnubg_net.py
     is the teacher).
  2. distill: supervised regression of the net onto those labels.
  3. save_core: writes the trained first layer in the shape
     sample_trainer.gnubg_published_core_init loads, so every minted MLP loads
     its core from gnubg-distilled weights — the literal answer to "can the mint
     helper's MLP be based on gnubg weights?".

The committed gnubg_net / gnubg_onnx / gnubg_search modules are the teacher and
the offline reference/validation harness; only this distilled net is served.
"""
from __future__ import annotations

import argparse
import random
from pathlib import Path

import torch
from torch import nn

from gnubg_encoder import GNUBG_FEAT_DIM, encode_full_board
from gnubg_net import DEFAULT_WD_PATH, GnubgEvaluator
from gnubg_search import board_to_tanboard
from onnx_board_state import OnnxBoardState, legal_successors_onnx
from rules_engine import Board

# Conventional location for the distilled core weights. sample_trainer's
# gnubg_published_core_init loads this when present (env GNUBG_CORE_WEIGHTS
# overrides). Kept out of git by default — produced by a full offline run.
DEFAULT_CORE_PATH = Path(__file__).resolve().parent / "data" / "gnubg_core.pt"


class _DistillNet(nn.Module):
    """BackgammonNet with no extras head: sigmoid(head(sigmoid(core(board)))).

    Bit-compatible with sample_trainer.BackgammonNet(extras_dim=0), so the
    trained `core` layer drops straight into gnubg_published_core_init. Defined
    locally (random init) so distillation never seeds itself from a previously
    saved gnubg core."""

    def __init__(self, in_dim: int = GNUBG_FEAT_DIM, hidden: int = 80) -> None:
        super().__init__()
        self.core = nn.Linear(in_dim, hidden)
        self.head = nn.Linear(hidden, 1)

    def forward(self, board: torch.Tensor) -> torch.Tensor:
        h = torch.sigmoid(self.core(board))
        return torch.sigmoid(self.head(h)).squeeze(-1)


def _random_endgame_position(rng: random.Random) -> tuple[list[int], list[int], list[int], int]:
    """A random no-contact race/bearoff position: each side's remaining men are
    scattered over its own half of the board so the two sides never overlap
    (guaranteed race), with a random number already borne off. Fills the
    race/bearoff coverage that opening rollouts under-sample."""
    points = [0] * 24
    off = [0, 0]
    for side in (0, 1):
        off_n = rng.randint(0, 14)  # <=14 so the side still has a man on the board
        off[side] = off_n
        idxs = list(range(0, 9)) if side == 0 else list(range(15, 24))  # disjoint halves
        sign = 1 if side == 0 else -1
        for _ in range(15 - off_n):
            points[rng.choice(idxs)] += sign
    return points, [0, 0], off, rng.randint(0, 1)


def _label(evaluator: GnubgEvaluator, board, bar, off, to_move: int) -> tuple[torch.Tensor, float]:
    """(198-dim features, gnubg P(win) for the side to move) for one position."""
    b0, b1 = board_to_tanboard(Board(tuple(board), tuple(bar), tuple(off)), to_move)
    return encode_full_board(board, bar, off, to_move), evaluator.evaluate(b0, b1)[0][0]


def _guided_choice(state: OnnxBoardState, dice, evaluator: GnubgEvaluator,
                   eps: float, rng: random.Random, *, max_candidates: int = 32) -> OnnxBoardState:
    """Epsilon-greedy gnubg policy: a uniform-random legal move with
    probability `eps`, otherwise gnubg's 0-ply best (the successor that
    minimises the opponent's equity). To bound cost on boards with many
    successors (notably doubles), the 0-ply pick scores a random sample of at
    most `max_candidates` of them — enough to keep the data near good lines
    without paying for the full fan-out."""
    succ = legal_successors_onnx(state, dice)
    if len(succ) == 1 or rng.random() < eps:
        return rng.choice(succ)
    pool = succ if len(succ) <= max_candidates else rng.sample(succ, max_candidates)
    best, best_v = pool[0], float("-inf")
    for s in pool:
        b0, b1 = board_to_tanboard(Board(tuple(s.board), tuple(s.bar), tuple(s.off)), s.turn)
        v = -evaluator.evaluate(b0, b1)[1]  # value for the side that just moved
        if v > best_v:
            best_v, best = v, s
    return best


def generate_training_data(
    n_positions: int,
    evaluator: GnubgEvaluator | None = None,
    *,
    wd_path: str | Path = DEFAULT_WD_PATH,
    seed: int = 0,
    max_plies: int = 80,
    policy: str = "guided",
    guide_eps: float = 0.2,
    endgame_frac: float = 0.15,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Collect (features[198], gnubg P(win)) pairs for distillation.

    Each position is encoded from the side-to-move's perspective with the SAME
    198-dim encoder used at inference and labelled with gnubg's win probability
    for that side (gnubg is the teacher regardless of how the position arose).

    Coverage matters: a net trained on positions unlike those it will be queried
    on distils poorly. So:
      - `policy="guided"` plays gnubg's 0-ply best move with probability
        1 - `guide_eps` and a random move otherwise, tracing realistic
        (near-optimal) lines with some exploration; `policy="random"` plays
        uniformly at random (fast, wide, but off-distribution).
      - `endgame_frac` of the positions come from random race/bearoff seeding,
        which opening rollouts rarely reach.
    """
    if evaluator is None:
        evaluator = GnubgEvaluator(wd_path=wd_path)
    rng = random.Random(seed)
    feats: list[torch.Tensor] = []
    labels: list[float] = []

    for _ in range(int(n_positions * endgame_frac)):
        board, bar, off, to_move = _random_endgame_position(rng)
        f, y = _label(evaluator, board, bar, off, to_move)
        feats.append(f)
        labels.append(y)

    while len(feats) < n_positions:
        state = OnnxBoardState.initial()
        for _ in range(max_plies):
            if state.terminal():
                break
            f, y = _label(evaluator, state.board, state.bar, state.off, state.turn)
            feats.append(f)
            labels.append(y)
            if len(feats) >= n_positions:
                break
            dice = (rng.randint(1, 6), rng.randint(1, 6))
            if policy == "guided":
                state = _guided_choice(state, dice, evaluator, guide_eps, rng)
            else:
                state = rng.choice(legal_successors_onnx(state, dice))

    return torch.stack(feats), torch.tensor(labels, dtype=torch.float32)


def distill(
    X: torch.Tensor,
    y: torch.Tensor,
    *,
    hidden: int = 80,
    epochs: int = 40,
    lr: float = 1e-3,
    batch_size: int = 512,
    seed: int = 0,
    val_frac: float = 0.1,
) -> tuple[_DistillNet, dict[str, float]]:
    """Train a _DistillNet to regress gnubg's P(win). Returns (net, metrics)
    where metrics carries final train/val MSE and val Pearson correlation."""
    torch.manual_seed(seed)
    n = X.shape[0]
    n_val = max(1, int(n * val_frac))
    perm = torch.randperm(n)
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    Xtr, ytr, Xval, yval = X[tr_idx], y[tr_idx], X[val_idx], y[val_idx]

    net = _DistillNet(in_dim=X.shape[1], hidden=hidden)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    for _ in range(epochs):
        net.train()
        for i in range(0, Xtr.shape[0], batch_size):
            xb, yb = Xtr[i:i + batch_size], ytr[i:i + batch_size]
            opt.zero_grad()
            loss_fn(net(xb), yb).backward()
            opt.step()

    net.eval()
    with torch.no_grad():
        tr_mse = loss_fn(net(Xtr), ytr).item()
        pval = net(Xval)
        val_mse = loss_fn(pval, yval).item()
        # Pearson r between predictions and gnubg labels on the val split.
        pc = pval - pval.mean()
        yc = yval - yval.mean()
        denom = (pc.norm() * yc.norm()).item()
        val_r = float((pc @ yc).item() / denom) if denom > 0 else 0.0

    return net, {"train_mse": tr_mse, "val_mse": val_mse, "val_pearson": val_r}


def save_core(net: _DistillNet, path: str | Path = DEFAULT_CORE_PATH) -> Path:
    """Persist the distilled first layer for gnubg_published_core_init."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "in_dim": net.core.in_features,
            "hidden": net.core.out_features,
            "weight": net.core.weight.detach().clone(),
            "bias": net.core.bias.detach().clone(),
        },
        path,
    )
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--positions", type=int, default=50_000)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--hidden", type=int, default=80)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--policy", choices=["guided", "random"], default="guided")
    ap.add_argument("--guide-eps", type=float, default=0.2)
    ap.add_argument("--endgame-frac", type=float, default=0.15)
    ap.add_argument("--wd-path", default=DEFAULT_WD_PATH)
    ap.add_argument("--core-out", default=str(DEFAULT_CORE_PATH))
    args = ap.parse_args()

    print(f"[distill] generating {args.positions} gnubg-labelled positions "
          f"(policy={args.policy}, endgame_frac={args.endgame_frac})...")
    X, y = generate_training_data(
        args.positions, wd_path=args.wd_path, seed=args.seed,
        policy=args.policy, guide_eps=args.guide_eps, endgame_frac=args.endgame_frac,
    )
    print(f"[distill] training {args.hidden}-hidden net for {args.epochs} epochs...")
    net, metrics = distill(X, y, hidden=args.hidden, epochs=args.epochs, lr=args.lr, seed=args.seed)
    print(f"[distill] metrics: {metrics}")
    out = save_core(net, args.core_out)
    print(f"[distill] saved distilled core -> {out}")


if __name__ == "__main__":
    main()
