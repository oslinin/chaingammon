"""round_robin_trainer.py — multi-agent round-robin self-play with TD-λ.

Spawns one BackgammonNet per agent_id (loaded from 0G storage if a
prior checkpoint exists, else seeded fresh per agent_id), plays every
unordered pair (a, b) once per epoch — `C(N, 2)` games per epoch —
and emits JSONL status events the FastAPI `/training/status` endpoint
reads.

Usage (CLI):

    cd agent && uv run python round_robin_trainer.py \\
        --agent-ids 1,2,3,4 --epochs 10 \\
        --status-file /tmp/run.jsonl \\
        --checkpoint-dir /tmp/ckpt --upload-to-0g

Status JSONL events (one event per line):

    {"event":"started",       "agent_ids":[...], "epochs":N, "total_games":M, "ts":...}
    {"event":"agents_loaded", "loaded":{aid:"model"|"overlay"|"null"|"fresh", ...}}
    {"event":"epoch_start",   "epoch":i, "total":N, "ts":...}
    {"event":"match",         "epoch":i, "agent_a":a, "agent_b":b,
                              "winner":a|b, "plies":n, "ts":...}
    {"event":"epoch_end",     "epoch":i, "ts":...}
    {"event":"agent_saved",   "agent_id":a, "path":..., "root_hash":..., "ts":...}
    {"event":"done"|"aborted","ts":...}

Pairing is `itertools.combinations(agent_ids, 2)` — each unordered pair
plays once per epoch. In a single match `td_lambda_match` updates only
the first net (the second is frozen for that match), so over multiple
epochs every agent receives gradient updates against every other.
With `epochs >= len(agent_ids) - 1` every agent has trained against
every other at least once.

SIGTERM-safe: the FastAPI `/training/abort` endpoint sends SIGTERM and
expects a final 'aborted' event so the status reader can distinguish
graceful completion from kill. The signal handler raises SystemExit(0)
so the `try/finally` runs.
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import random
import signal
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional, TextIO

import torch

from agent_state_io import AgentState, load_or_seed, save_and_upload_checkpoint
from career_features import encode_career_context, sample_career_context
from sample_trainer import DEFAULT_EXTRAS_DIM, td_lambda_match


# Default `td_match` callable — overridable for tests. Signature must
# match `td_lambda_match`'s positional `(agent, opp, agent_extras,
# opp_extras)` plus keyword `gamma, lam, lr` and return `(steps, won)`.
TdMatchFn = Callable[..., tuple[int, int]]


def _emit(fh: Optional[TextIO], event: str, **fields) -> None:
    """Append one JSONL event to `fh` and flush. No-op when `fh` is None."""
    if fh is None:
        return
    fields["event"] = event
    fields.setdefault("ts", time.time())
    fh.write(json.dumps(fields) + "\n")
    fh.flush()


def _resolve_weights_hash(agent_id: int) -> str:
    """Look up `agent_id`'s per-agent weights hash from `AgentRegistry`.

    Returns "" when the chain client can't be constructed (no
    `AGENT_REGISTRY_ADDRESS` env, no RPC reachable) or the agent has
    no entry. Callers treat "" as "seed fresh".
    """
    try:
        from server.app.chain_client import ChainClient

        client = ChainClient()
        hashes = client.agent_data_hashes(agent_id)
        if len(hashes) >= 2:
            return hashes[1]
    except Exception:
        # Offline runs (no chain configured) are common in dev. Don't
        # let chain errors abort training — fall through to seed-fresh.
        pass
    return ""


@contextmanager
def _maybe_open_status_file(path: Optional[str]):
    """Line-buffered append-mode open so the FastAPI status reader sees
    events live; closes on context exit."""
    if not path:
        yield None
        return
    fh = open(path, "a", buffering=1)
    try:
        yield fh
    finally:
        fh.close()


def _install_sigterm_handler() -> None:
    """SIGTERM → SystemExit(0). The trainer's `try/finally` runs and
    emits the 'aborted' event before the process exits."""
    def _handler(signum, frame):
        sys.exit(0)
    signal.signal(signal.SIGTERM, _handler)


def run_round_robin(
    agent_ids: list[int],
    epochs: int,
    *,
    extras_dim: int = DEFAULT_EXTRAS_DIM,
    seed: int = 42,
    status_fh: Optional[TextIO] = None,
    checkpoint_dir: Optional[Path] = None,
    upload: bool = False,
    encrypt: bool = True,
    weights_hash_resolver: Callable[[int], str] = _resolve_weights_hash,
    fetch_blob: Optional[Callable[[str], bytes]] = None,
    td_match: TdMatchFn = td_lambda_match,
    lr: float = 1e-3,
    lam: float = 0.7,
    gamma: float = 1.0,
    use_0g_inference: bool = False,
) -> dict[int, AgentState]:
    """Run the round-robin training loop.

    Pure function (modulo the JSONL side-effect on `status_fh` and the
    optional 0G upload at the end). Returns the final `agent_id ->
    AgentState` map so callers / tests can inspect trained nets.

    `weights_hash_resolver`, `fetch_blob`, and `td_match` are all
    injectable so tests can run without chain / 0G storage / a real
    training run.
    """
    if len(agent_ids) < 2:
        raise ValueError("round-robin requires at least 2 agent_ids")
    if epochs < 1:
        raise ValueError("epochs must be >= 1")

    n = len(agent_ids)
    games_per_epoch = n * (n - 1) // 2
    total_games = epochs * games_per_epoch

    _emit(
        status_fh, "started",
        agent_ids=agent_ids, epochs=epochs,
        games_per_epoch=games_per_epoch,
        total_games=total_games,
        use_0g_inference=bool(use_0g_inference),
    )

    # Hybrid load: try AgentRegistry → 0G storage; else seed fresh.
    agents: dict[int, AgentState] = {}
    for aid in agent_ids:
        wh = weights_hash_resolver(aid)
        agents[aid] = load_or_seed(
            aid,
            extras_dim=extras_dim,
            weights_hash=wh,
            fetch=fetch_blob,
        )
    _emit(
        status_fh, "agents_loaded",
        loaded={aid: a.profile_kind for aid, a in agents.items()},
    )

    # Career-context RNG seeded deterministically off the master seed
    # so two runs with the same args replay identically.
    career_rng = random.Random(seed + 1000)

    for epoch in range(epochs):
        _emit(status_fh, "epoch_start", epoch=epoch, total=epochs)
        for a_id, b_id in itertools.combinations(agent_ids, 2):
            # Career context per match — same shape sample_trainer.py
            # uses in --career-mode. Asymmetric (a has a teammate, b
            # does not) so the extras head sees a non-trivial signal.
            a_ctx = sample_career_context(career_rng, force_team=True)
            b_ctx = sample_career_context(career_rng, force_team=False)
            a_extras = encode_career_context(a_ctx, dim=extras_dim)
            b_extras = encode_career_context(b_ctx, dim=extras_dim)

            steps, won = td_match(
                agents[a_id].net, agents[b_id].net,
                a_extras, b_extras,
                gamma=gamma, lam=lam, lr=lr,
            )
            winner = a_id if won else b_id
            _emit(
                status_fh, "match",
                epoch=epoch, agent_a=a_id, agent_b=b_id,
                winner=winner, plies=int(steps),
            )
        _emit(status_fh, "epoch_end", epoch=epoch)

    # End-of-run save + optional upload.
    if checkpoint_dir is not None:
        # Only the first net of each pair learns, so per-agent training
        # exposure is `epochs * (n - 1) / 2` (each agent appears in
        # `n - 1` pairs per epoch, half as the learner). Round to int
        # for the on-chain match_count.
        matches_per_agent = max(1, epochs * (n - 1) // 2)
        for aid, state in agents.items():
            local_path, root_hash = save_and_upload_checkpoint(
                state,
                checkpoint_dir=Path(checkpoint_dir),
                upload=upload,
                encrypt=encrypt,
                matches_played=matches_per_agent,
            )
            _emit(
                status_fh, "agent_saved",
                agent_id=aid, path=str(local_path), root_hash=root_hash,
            )

    return agents


# ─── CLI ────────────────────────────────────────────────────────────────────


def _parse_agent_ids(s: str) -> list[int]:
    return [int(x.strip()) for x in s.split(",") if x.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--agent-ids", type=_parse_agent_ids, required=True,
                        metavar="1,2,3", help="Comma-separated on-chain IDs.")
    parser.add_argument("--epochs", type=int, required=True,
                        help="Number of round-robin epochs (1 epoch = "
                             "C(N, 2) games across all agent pairs).")
    parser.add_argument("--status-file", type=str, default=None,
                        help="Append JSONL training events to this path.")
    parser.add_argument("--checkpoint-dir", type=str, default=None,
                        help="Per-agent checkpoint output directory. "
                             "Required for --upload-to-0g.")
    parser.add_argument("--extras-dim", type=int, default=DEFAULT_EXTRAS_DIM,
                        help="Extras-input dim for new agents. Loaded "
                             "checkpoints honor their own extras_dim.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--lam", type=float, default=0.7)
    parser.add_argument("--gamma", type=float, default=1.0)
    parser.add_argument("--upload-to-0g", action="store_true",
                        help="Upload each agent's checkpoint to 0G storage "
                             "at end of run. Requires --checkpoint-dir.")
    parser.add_argument("--no-encrypt", action="store_true",
                        help="Demo modifier for --upload-to-0g: skip "
                             "AES-256-GCM seal so a server with no key can "
                             "fetch the checkpoint via load_profile.")
    parser.add_argument("--use-0g-inference", action="store_true",
                        help="Phase G placeholder: route per-move forward "
                             "passes through og_compute_eval_client. The "
                             "flag is recorded in the JSONL events but the "
                             "Phase G eval bridge is not wired yet — for "
                             "this run, inference still runs locally.")
    args = parser.parse_args()

    if len(args.agent_ids) < 2:
        parser.error("--agent-ids must have at least 2 IDs")
    if args.upload_to_0g and not args.checkpoint_dir:
        parser.error("--upload-to-0g requires --checkpoint-dir")
    if args.use_0g_inference:
        print("WARNING: --use-0g-inference set but Phase G eval bridge is "
              "not wired yet. Inference runs locally for this run.",
              file=sys.stderr)

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    _install_sigterm_handler()

    completed = False
    with _maybe_open_status_file(args.status_file) as fh:
        try:
            run_round_robin(
                args.agent_ids,
                args.epochs,
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
            )
            completed = True
        finally:
            _emit(fh, "done" if completed else "aborted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
