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
    {"event":"agent_saved",      "agent_id":a, "path":..., "root_hash":..., "ts":...}
    {"event":"agent_save_error", "agent_id":a, "detail":..., "ts":...}
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
import math
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


# SummaryWriter is optional — round-robin runs work without it (the
# JSONL status file is the canonical progress feed). When tensorboard
# isn't installed in the agent venv, we set the type to None and
# every write call short-circuits.
try:
    from torch.utils.tensorboard import SummaryWriter   # type: ignore
except ImportError:
    SummaryWriter = None   # type: ignore[assignment]


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


def _maybe_build_0g_infer_fn(use_0g_inference: bool, status_fh):
    """Phase I: if use_0g_inference is True, probe the eval bridge to
    confirm a backgammon-net provider is registered. On success build
    an `infer_fn(features, extras) -> equities` that routes each
    candidate forward pass through `og_compute_eval_client.evaluate`.
    On any failure (provider missing, env unset, bridge import fails)
    emit a `warning` event to the status JSONL and return None so the
    trainer falls back to local inference cleanly.

    The trade-off: 0G inference is one network round-trip per
    candidate, so a position with K legal candidates becomes K
    sequential calls. The eval bridge could batch in a future iteration;
    for now we accept the latency to keep the wire faithful.
    """
    if not use_0g_inference:
        return None
    try:
        import torch as _torch  # local import keeps the trainer importable
        from og_compute_eval_client import (    # noqa: E402
            OgEvalUnavailable,
            evaluate as _og_evaluate,
            estimate as _og_estimate,
        )
    except Exception as exc:
        _emit(status_fh, "warning",
              reason="OG_EVAL_IMPORT_FAILED", detail=str(exc))
        return None

    # Probe — cheap availability check before the loop runs. estimate
    # always returns 0 exit so we read its `available` field.
    try:
        probe = _og_estimate(1)
    except Exception as exc:
        _emit(status_fh, "warning",
              reason="OG_EVAL_PROBE_FAILED", detail=str(exc))
        return None
    if not probe.available:
        _emit(status_fh, "warning",
              reason="OG_EVAL_UNAVAILABLE",
              detail=probe.note or "no backgammon-net provider registered",
              fallback="local")
        return None

    _emit(status_fh, "0g_inference_active",
          provider=probe.provider_address,
          per_inference_og=probe.per_inference_og)

    def _infer(features, extras):
        # features: [N, 198] tensor; extras: [N, 16] tensor or None.
        n = features.shape[0]
        equities = []
        for i in range(n):
            f_list = features[i].tolist()
            e_list = (extras[i].tolist() if extras is not None else [0.0] * 16)
            try:
                r = _og_evaluate(f_list, e_list)
                equities.append(r.equity)
            except OgEvalUnavailable:
                # Provider went away mid-run. Caller (pick_move) can't
                # easily fall back per-call without the net handle, so
                # we surface zero — the picker will degrade to a tie-
                # break. Subsequent matches keep trying; if availability
                # is gone the warnings stack up but training completes.
                equities.append(0.0)
        return _torch.tensor(equities, dtype=features.dtype)

    return _infer


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
    logdir: Optional[Path] = None,
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

    # Phase L.1: open a TensorBoard SummaryWriter when a logdir is
    # supplied so judges can watch per-match TD error, weight L2,
    # win-rate trajectories etc. live. The writer is None-safe — every
    # downstream call site checks `writer is not None` (or relies on
    # td_lambda_match's existing optional-writer behavior). When
    # tensorboard isn't installed in the venv, SummaryWriter is None
    # at module import and we silently skip.
    writer = None
    if logdir is not None and SummaryWriter is not None:
        logdir = Path(logdir)
        logdir.mkdir(parents=True, exist_ok=True)
        writer = SummaryWriter(log_dir=str(logdir))

    _emit(
        status_fh, "started",
        agent_ids=agent_ids, epochs=epochs,
        games_per_epoch=games_per_epoch,
        total_games=total_games,
        use_0g_inference=bool(use_0g_inference),
        logdir=str(logdir) if logdir is not None else None,
    )

    # Phase I: when use_0g_inference is set, probe the eval bridge once
    # and build an `infer_fn` that routes per-candidate forward passes
    # through 0G compute. If the probe says no provider is available
    # (the common case today — backgammon-net-v1 isn't registered on
    # the serving network yet), emit a 'warning' event and fall back
    # to local inference for the rest of the run. Means the toggle
    # doesn't crash a run on a network without a provider — the wire
    # is in place for when one stands up.
    infer_fn = _maybe_build_0g_infer_fn(use_0g_inference, status_fh)

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

    # Per-agent rolling stats — fed into TensorBoard as cumulative
    # win-counts + rolling win-rates so judges can see relative
    # strength evolve over the run.
    cum_wins: dict[int, int] = {aid: 0 for aid in agent_ids}
    cum_games: dict[int, int] = {aid: 0 for aid in agent_ids}
    global_match_step = 0
    global_step = 0  # plies-step counter for td_lambda_match's writer

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

            # Pass infer_fn keyword only when set; the test stub
            # td_match signature (used by hermetic tests) doesn't
            # accept it. Same for writer + global_step.
            kwargs = {"gamma": gamma, "lam": lam, "lr": lr}
            if infer_fn is not None:
                kwargs["infer_fn"] = infer_fn
            if writer is not None:
                kwargs["writer"] = writer
                kwargs["global_step"] = global_step
            steps, won = td_match(
                agents[a_id].net, agents[b_id].net,
                a_extras, b_extras,
                **kwargs,
            )
            winner = a_id if won else b_id
            _emit(
                status_fh, "match",
                epoch=epoch, agent_a=a_id, agent_b=b_id,
                winner=winner, plies=int(steps),
            )

            # Phase L.1 TensorBoard scalars per match. td_lambda_match
            # already logs train/* (TD error, gradient norm, eligibility
            # norm) when writer is non-None — we only need to add the
            # match-level + per-agent aggregates.
            if writer is not None:
                writer.add_scalar("match/plies", int(steps), global_match_step)
                writer.add_scalar(f"win/agent_{a_id}_vs_{b_id}",
                                   1.0 if won else 0.0, global_match_step)
                cum_games[a_id] += 1
                cum_games[b_id] += 1
                cum_wins[winner] += 1
                for aid in agent_ids:
                    games = cum_games[aid]
                    if games > 0:
                        writer.add_scalar(
                            f"win_rate/agent_{aid}",
                            cum_wins[aid] / games,
                            global_match_step,
                        )
            global_match_step += 1
            global_step += int(steps)

        _emit(status_fh, "epoch_end", epoch=epoch)

        # Phase L.1: per-epoch model snapshots. Weight L2 + per-agent
        # extras-head L2 give a quick "is anything actually changing"
        # signal — flat lines = no learning; gentle drift = TD-λ
        # is working as expected.
        if writer is not None:
            for aid, state in agents.items():
                core_l2 = math.sqrt(sum(
                    float(p.pow(2).sum().item())
                    for p in state.net.core.parameters()
                ))
                writer.add_scalar(f"weights/core_l2_agent_{aid}",
                                   core_l2, epoch)
                if state.net.extras is not None:
                    extras_l2 = math.sqrt(sum(
                        float(p.pow(2).sum().item())
                        for p in state.net.extras.parameters()
                    ))
                    writer.add_scalar(f"weights/extras_l2_agent_{aid}",
                                       extras_l2, epoch)
            writer.flush()

    # Close the TensorBoard writer cleanly so the final scalars flush
    # before the trainer subprocess exits. The status JSONL's 'done'
    # event is the operator-facing completion signal; closing here
    # ensures TensorBoard sees every datapoint we logged.
    if writer is not None:
        writer.close()

    # End-of-run save + optional upload.
    if checkpoint_dir is not None:
        # Only the first net of each pair learns, so per-agent training
        # exposure is `epochs * (n - 1) / 2` (each agent appears in
        # `n - 1` pairs per epoch, half as the learner). Round to int
        # for the on-chain match_count.
        matches_per_agent = max(1, epochs * (n - 1) // 2)
        for aid, state in agents.items():
            try:
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
            except Exception as exc:
                # Upload failure (e.g. missing OG_STORAGE_* env vars or
                # network timeout) must not abort the run — the local
                # checkpoint may still have been written. Surface the
                # error in the status JSONL so the frontend can render it.
                _emit(
                    status_fh, "agent_save_error",
                    agent_id=aid, detail=str(exc),
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
    parser.add_argument("--logdir", type=str, default=None,
                        help="Phase L.1: TensorBoard event-file output "
                             "directory. When set, the trainer opens a "
                             "SummaryWriter and logs train/* (TD error, "
                             "gradient norm, eligibility norm), match/* "
                             "(plies, per-pair win), win_rate/* (per-agent "
                             "rolling win rate), and weights/* (per-agent "
                             "L2 norms per epoch). Open with `tensorboard "
                             "--logdir <path>`. The /training/start "
                             "endpoint sets this automatically and spawns "
                             "tensorboard alongside the trainer.")
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
    # --use-0g-inference is wired through to the per-candidate forward
    # pass via _maybe_build_0g_infer_fn. When no backgammon-net provider
    # is registered on the serving network, the helper emits a 'warning'
    # event to the status JSONL and the trainer falls back to local
    # inference for the run. Nothing to print here.

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
                logdir=Path(args.logdir) if args.logdir else None,
            )
            completed = True
        finally:
            _emit(fh, "done" if completed else "aborted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
