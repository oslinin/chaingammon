"""
demo/leaderboard.py — Poll the 0G Chain Tournament contract every 30s
and print a sorted leaderboard with ELO deltas since the last poll.

Usage:
    python demo/leaderboard.py [--top 10] [--interval 30]

Requires:
    OG_RPC_URL env var (default: https://evmrpc-testnet.0g.ai)
    deployments/0g_testnet.json written by deploy_tournament.js
"""

from __future__ import annotations

import argparse
import os
import time
from typing import Optional


def _fetch(n: int) -> list[tuple[str, int]]:
    """Fetch top-n leaderboard from chain."""
    from backgammon.og.chain import top_n
    return top_n(n)


def _shorten(addr: str) -> str:
    return f"{addr[:6]}…{addr[-4:]}"


def _print_board(
    entries: list[tuple[str, int]],
    prev: Optional[dict[str, int]],
    poll_number: int,
) -> None:
    import datetime
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"\n{'─'*50}")
    print(f"  ELO Leaderboard  (poll #{poll_number})  {ts}")
    print(f"{'─'*50}")
    print(f"  {'Rank':>4}  {'Address':>12}  {'ELO':>6}  {'Δ':>6}")
    print(f"  {'─'*4}  {'─'*12}  {'─'*6}  {'─'*6}")
    for rank, (addr, elo) in enumerate(entries, 1):
        delta = ""
        if prev and addr in prev:
            d = elo - prev[addr]
            delta = f"{'+' if d >= 0 else ''}{d}"
        print(f"  {rank:>4}  {_shorten(addr):>12}  {elo:>6}  {delta:>6}")
    print(f"{'─'*50}")


def main() -> None:
    p = argparse.ArgumentParser(description="Chaingammon ELO leaderboard poller")
    p.add_argument("--top",      type=int,   default=10)
    p.add_argument("--interval", type=float, default=30.0)
    args = p.parse_args()

    print(f"Polling leaderboard (top {args.top}) every {args.interval}s …")
    print("Press Ctrl+C to stop.\n")

    prev: Optional[dict[str, int]] = None
    poll = 0

    while True:
        poll += 1
        try:
            entries = _fetch(args.top)
            _print_board(entries, prev, poll)
            prev = {addr: elo for addr, elo in entries}
        except FileNotFoundError as exc:
            print(f"[{poll}] Deployment file not found — deploy first: {exc}")
        except Exception as exc:
            print(f"[{poll}] Error: {exc}")

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
