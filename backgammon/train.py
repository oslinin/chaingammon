"""
backgammon/train.py — CLI self-play training loop.

Usage:
    python -m backgammon.train --epochs 5 --games-per-epoch 100

Prints one line per epoch:
    epoch | avg_moves | loss | win_rate_vs_random | time
"""

from __future__ import annotations

import argparse
import pathlib
import random
import time

import numpy as np
import torch
import torch.optim as optim

from backgammon.agent import NetAgent, RandomAgent
from backgammon.net import BackgammonNet
from backgammon.selfplay import play_game, td_lambda_update


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="TD-Gammon self-play trainer")
    p.add_argument("--epochs",          type=int,   default=50)
    p.add_argument("--games-per-epoch", type=int,   default=200)
    p.add_argument("--lr",              type=float, default=1e-3)
    p.add_argument("--lambda-td",       type=float, default=0.7)
    p.add_argument("--epsilon",         type=float, default=0.1)
    p.add_argument("--hidden",          type=int,   default=128)
    p.add_argument("--seed",            type=int,   default=42)
    p.add_argument("--ckpt-dir",        type=str,   default="checkpoints")
    p.add_argument("--eval-games",      type=int,   default=100)
    p.add_argument("--no-network",      action="store_true",
                   help="Disable AXL/0G network layers (standalone self-play)")
    p.add_argument("--no-chain",        action="store_true",
                   help="Disable 0G Chain ELO reporting")
    return p.parse_args()


def _evaluate_vs_random(
    net: BackgammonNet,
    n_games: int,
    base_seed: int,
) -> float:
    """Win rate of net agent against RandomAgent (alternating sides)."""
    wins = 0
    rand_agent = RandomAgent()
    net_agent = NetAgent(net, epsilon=0.0)

    for i in range(n_games):
        rng_py = random.Random(base_seed + i)
        rng_np = np.random.default_rng(base_seed + i)
        if i % 2 == 0:
            traj = play_game(net_agent, rand_agent, rng_py, rng_np)
            net_is_white = True
        else:
            traj = play_game(rand_agent, net_agent, rng_py, rng_np)
            net_is_white = False

        # target[0]>0.5 ↔ White won
        white_won = traj.target[0].item() > 0.5
        if net_is_white and white_won:
            wins += 1
        elif not net_is_white and not white_won:
            wins += 1

    return wins / n_games


def main() -> None:
    args = _parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    ckpt_dir = pathlib.Path(args.ckpt_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    net = BackgammonNet(hidden=args.hidden)
    optimizer = optim.Adam(net.parameters(), lr=args.lr)

    # Header
    print(f"{'epoch':>5} | {'avg_moves':>9} | {'loss':>8} | {'vs_random':>9} | {'time':>6}")
    print("-" * 48)

    for epoch in range(1, args.epochs + 1):
        t0 = time.time()
        epoch_loss = 0.0
        epoch_moves = 0

        agent = NetAgent(net, epsilon=args.epsilon)
        rng_py_train = random.Random(args.seed + epoch * 1000)
        rng_np_train = np.random.default_rng(args.seed + epoch * 1000)

        for g in range(args.games_per_epoch):
            rng_py = random.Random(rng_py_train.randint(0, 2**31))
            rng_np = np.random.default_rng(int(rng_np_train.integers(0, 2**31)))

            traj = play_game(agent, agent, rng_py, rng_np)
            loss = td_lambda_update(net, optimizer, traj, lam=args.lambda_td)
            epoch_loss += loss
            epoch_moves += traj.total_moves

        avg_loss = epoch_loss / args.games_per_epoch
        avg_moves = epoch_moves / args.games_per_epoch

        win_rate = _evaluate_vs_random(
            net,
            n_games=args.eval_games,
            base_seed=args.seed + epoch * 100_000,
        )

        elapsed = time.time() - t0
        print(
            f"{epoch:>5} | {avg_moves:>9.1f} | {avg_loss:>8.5f} | "
            f"{win_rate:>9.3f} | {elapsed:>5.1f}s"
        )

        # Save checkpoint every epoch.
        ckpt_path = ckpt_dir / f"epoch_{epoch:04d}.pt"
        torch.save({"epoch": epoch, "net": net.state_dict(), "opt": optimizer.state_dict()},
                   ckpt_path)

    print("\nTraining complete.")


if __name__ == "__main__":
    main()
