"""round_robin_trainer.py — multi-agent round-robin self-play with TD-λ.

Spawns one BackgammonNet per agent_id (loaded from 0G storage if a prior
checkpoint exists, else seeded fresh per agent_id), plays every ordered pair
(a, b) and (b, a) per epoch — `N*(N-1)` games per epoch — and emits JSONL
status events the FastAPI `/training/status` endpoint reads.

Pairing is `itertools.permutations(agent_ids, 2)`: both orderings play so
every agent is the TD learner against every other once per epoch. A single
match updates only the first (learner) net; playing both orderings ensures
symmetric gradient updates.

Usage (CLI):

    cd agent && uv run python round_robin_trainer.py \\
        --agent-ids 1,2,3,4 --epochs 10 \\
        --status-file /tmp/run.jsonl \\
        --checkpoint-dir /tmp/ckpt --upload-to-0g

    # With TensorBoard (optional — tensorboard must be installed):
    cd agent && uv run python round_robin_trainer.py \\
        --agent-ids 1,2,3,4 --epochs 50 \\
        --logdir /tmp/tb_rr
    # In another terminal:
    cd agent && uv run tensorboard --logdir /tmp/tb_rr

TensorBoard scalars written per epoch (when --logdir is set):
    win_rate/agent_<id>   — fraction of that agent's epoch games won

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
import signal
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional, TextIO

import torch

try:
    from torch.utils.tensorboard import SummaryWriter as _SummaryWriter
    _TB_AVAILABLE = True
except ImportError:
    _TB_AVAILABLE = False

# Load server/.env into os.environ before any module reads RPC_URL etc.
# Needed because this script is spawned as a subprocess and must know
# which contract addresses to read for the hybrid resolve path.
from dotenv import load_dotenv
from pathlib import Path as _Path
_env_path = _Path(__file__).resolve().parents[1] / "server" / ".env"
load_dotenv(_env_path, override=False)

from agent_state_io import AgentState, load_or_seed, save_and_upload_checkpoint
from career_features import encode_career_context, CareerContext
from sample_trainer import DEFAULT_EXTRAS_DIM, td_lambda_match, encode_state
from sklearn_agent import SklearnProxy, fit_and_export_sklearn, is_sklearn_code


# Default `td_match` callable — overridable for tests. Signature must
# match `td_lambda_match`'s positional `(agent, opp, agent_extras,
# opp_extras)` plus keyword `gamma, lam, lr` and return
# `(steps, won, agent_states, opp_states)`.
TdMatchFn = Callable[..., tuple[int, int, list, list]]


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
        import sys
        from pathlib import Path as _P
        # Add repo root (parent of agent/) to sys.path so we can import server.app.chain_client
        _repo_root = _P(__file__).resolve().parents[1]
        if str(_repo_root) not in sys.path:
            sys.path.insert(0, str(_repo_root))

        from server.app.chain_client import ChainClient

        client = ChainClient.from_env()
        hashes = client.agent_data_hashes(agent_id)
        if len(hashes) >= 2:
            return hashes[1]
    except Exception:
        # Offline runs (no chain configured) are common in dev. Don't
        # let chain errors abort training — fall through to seed-fresh.
        pass
    return ""


def _resolve_agent_style(agent_id: int) -> dict[str, float]:
    """Fetch `agent_id`'s real style overlay from 0G KV and return its
    category->value map, for use as an *opponent* descriptor in the extras
    vector. Returns {} for cold-start agents (no overlay yet) or whenever
    0G isn't configured / reachable — callers treat {} as a neutral profile.

    Offline-safe: skips the KV subprocess entirely unless 0G is actually
    configured (testnet env vars) or the localhost mock is active, so
    hermetic test runs and chainless dev don't spawn `node` per agent.
    """
    try:
        if os.environ.get("OG_STORAGE_MODE") != "localhost" and not all(
            os.environ.get(k)
            for k in ("OG_STORAGE_RPC", "OG_STORAGE_INDEXER", "OG_STORAGE_PRIVATE_KEY")
        ):
            return {}
        from pathlib import Path as _P
        _repo_root = _P(__file__).resolve().parents[1]
        if str(_repo_root) not in sys.path:
            sys.path.insert(0, str(_repo_root))
        from server.app.og_storage_client import get_kv
        from server.app.agent_overlay import Overlay

        blob = get_kv(f"chaingammon/overlay/agent/{agent_id}")
        return dict(Overlay.from_bytes(blob).values)
    except Exception:
        # Same stance as _resolve_weights_hash: infra problems must never
        # abort training — fall through to a neutral profile.
        return {}


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
    style_resolver: Callable[[int], dict[str, float]] = _resolve_agent_style,
    fetch_blob: Optional[Callable[[str], bytes]] = None,
    td_match: TdMatchFn = td_lambda_match,
    lr: float = 1e-3,
    lam: float = 0.7,
    gamma: float = 1.0,
    use_0g_inference: bool = False,
    sklearn_codes: Optional[dict[int, str]] = None,
    search_depths: Optional[dict[int, int]] = None,
    logdir: Optional[str] = None,
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
    games_per_epoch = n * (n - 1)  # permutations: (a,b) and (b,a) both play
    total_games = epochs * games_per_epoch

    writer = _SummaryWriter(logdir) if (logdir and _TB_AVAILABLE) else None

    _emit(
        status_fh, "started",
        agent_ids=agent_ids, epochs=epochs,
        games_per_epoch=games_per_epoch,
        total_games=total_games,
        use_0g_inference=bool(use_0g_inference),
        logdir=logdir or "",
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

    # Identify which agents use sklearn (non-MLP) models.
    sklearn_codes = sklearn_codes or {}
    sklearn_ids: set[int] = {aid for aid in agent_ids if aid in sklearn_codes}
    # Per-agent SklearnProxy (for move selection) and training data accumulator.
    sklearn_proxies: dict[int, SklearnProxy] = {
        aid: SklearnProxy(extras_dim=extras_dim) for aid in sklearn_ids
    }
    # sklearn_data[aid] = list of ([board ‖ style] np.ndarray, outcome float)
    sklearn_data: dict[int, list[tuple]] = {aid: [] for aid in sklearn_ids}

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

    # Resolve each agent's real style profile once (static for the run);
    # used as the *opponent* descriptor in every match's extras vector.
    styles = {aid: style_resolver(aid) for aid in agent_ids}

    for epoch in range(epochs):
        _emit(status_fh, "epoch_start", epoch=epoch, total=epochs)
        _epoch_wins: dict[int, int] = {aid: 0 for aid in agent_ids}
        _epoch_played: dict[int, int] = {aid: 0 for aid in agent_ids}
        # Use permutations so (a, b) and (b, a) both play — every agent
        # learns against every other once per epoch.
        for a_id, b_id in itertools.permutations(agent_ids, 2):
            # Each learner conditions on its *opponent's* real style
            # profile, so the extras head sees a genuine opponent signal
            # instead of a random career context. Cold-start agents
            # resolve to {} -> a neutral (zero) profile.
            a_ctx = CareerContext(
                opponent_style=styles[b_id], teammate_style=None,
                stake_wei=0, tournament_position=0.0, is_team_match=False,
                self_style=styles[a_id],
            )
            b_ctx = CareerContext(
                opponent_style=styles[a_id], teammate_style=None,
                stake_wei=0, tournament_position=0.0, is_team_match=False,
                self_style=styles[b_id],
            )
            a_extras = encode_career_context(a_ctx, dim=extras_dim)
            b_extras = encode_career_context(b_ctx, dim=extras_dim)

            a_is_sklearn = a_id in sklearn_ids
            b_is_sklearn = b_id in sklearn_ids

            if a_is_sklearn and not b_is_sklearn:
                # Put MLP (b) as the TD learner; sklearn (a) as opponent.
                # Swap ids and extras so the td_match call is uniform below.
                learner_id, opp_id = b_id, a_id
                learner_net = agents[b_id].net
                opp_net = sklearn_proxies[a_id]
                learner_extras, opp_extras = b_extras, a_extras
            else:
                learner_id, opp_id = a_id, b_id
                learner_net = sklearn_proxies[a_id] if a_is_sklearn else agents[a_id].net
                opp_net = sklearn_proxies[b_id] if b_is_sklearn else agents[b_id].net
                learner_extras, opp_extras = a_extras, b_extras

            # Pass infer_fn keyword only when set; the test stub
            # td_match signature (used by hermetic tests) doesn't
            # accept it.
            kwargs: dict = {"gamma": gamma, "lam": lam, "lr": lr}
            if infer_fn is not None:
                kwargs["infer_fn"] = infer_fn
            if search_depths:
                kwargs["search_depth"] = search_depths.get(learner_id, 1)
                kwargs["opp_search_depth"] = search_depths.get(opp_id, 1)

            # For sklearn-vs-sklearn, skip gradient updates entirely by
            # passing proxy nets to td_match — they have no parameters so
            # td_lambda_match's backward() becomes a no-op.
            steps, won, agent_states, opp_states = td_match(
                learner_net, opp_net,
                learner_extras, opp_extras,
                **kwargs,
            )
            winner = learner_id if won else opp_id
            _epoch_played[a_id] = _epoch_played.get(a_id, 0) + 1
            _epoch_played[b_id] = _epoch_played.get(b_id, 0) + 1
            _epoch_wins[winner] = _epoch_wins.get(winner, 0) + 1

            # Collect training data for sklearn agents from their states.
            # opp_states are the positions chosen by opp_net (= sklearn agent
            # when opp_id is sklearn). Label = 1.0 if sklearn agent won.
            if opp_id in sklearn_ids and opp_states:
                import numpy as _np
                sk_won = float(winner == opp_id)
                # The sklearn agent (opp) saw `opp_extras` as its style vector
                # this match; train on [board ‖ style] so it conditions on style
                # exactly as at inference, where SklearnProxy concatenates the
                # same vector. Style is constant across the match's states.
                opp_ext_np = opp_extras.detach().cpu().numpy().astype("float32")
                for s in opp_states:
                    try:
                        board_feat = encode_state(s, perspective=0).numpy()
                        feat = _np.concatenate([board_feat, opp_ext_np])
                        sklearn_data[opp_id].append((feat, sk_won))
                    except Exception:
                        pass

            _emit(
                status_fh, "match",
                epoch=epoch, agent_a=a_id, agent_b=b_id,
                winner=winner, plies=int(steps),
            )

        _emit(status_fh, "epoch_end", epoch=epoch)

        if writer:
            for aid in agent_ids:
                g = _epoch_played.get(aid, 0)
                w = _epoch_wins.get(aid, 0)
                writer.add_scalar(f"win_rate/agent_{aid}", w / g if g else 0.0, epoch)

        # After each epoch re-fit sklearn models so they improve over time.
        for sk_id, data in sklearn_data.items():
            if len(data) < 10:
                continue
            try:
                import numpy as _np
                X = _np.stack([d[0] for d in data])
                y = _np.array([d[1] for d in data], dtype="float32")
                source = sklearn_codes[sk_id]
                from sklearn_agent import build_sklearn_model
                model = build_sklearn_model(source)
                model.fit(X, y)
                sklearn_proxies[sk_id].update_model(model)
            except Exception as exc:
                _emit(status_fh, "warning", detail=f"sklearn re-fit failed for agent {sk_id}: {exc}")

    # Signal that the training loop itself is finished. Checkpoint
    # save + 0G upload follow; the frontend uses this event to split
    # the "Train" step timer from the "Upload to 0G" step timer.
    _emit(status_fh, "training_complete")

    # End-of-run save for MLP agents.
    if checkpoint_dir is not None:
        # Every agent was the 'learner' in (n - 1) games per epoch.
        matches_per_agent = epochs * (n - 1)
        for aid, state in agents.items():
            if aid in sklearn_ids:
                continue  # sklearn agents saved separately below
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
                _emit(
                    status_fh, "agent_save_error",
                    agent_id=aid, detail=str(exc),
                )

    # End-of-run save for sklearn agents — final fit + ONNX export.
    if checkpoint_dir is not None:
        import numpy as _np
        for sk_id in sklearn_ids:
            data = sklearn_data[sk_id]
            if not data:
                _emit(status_fh, "agent_save_error", agent_id=sk_id,
                      detail="no training data collected for sklearn agent")
                continue
            try:
                X = _np.stack([d[0] for d in data])
                y = _np.array([d[1] for d in data], dtype="float32")
                local_path, root_hash = fit_and_export_sklearn(
                    sklearn_codes[sk_id], X, y, sk_id,
                    Path(checkpoint_dir),
                    upload=upload,
                    encrypt=encrypt,
                )
                _emit(
                    status_fh, "agent_saved",
                    agent_id=sk_id, path=str(local_path), root_hash=root_hash,
                )
            except Exception as exc:
                _emit(
                    status_fh, "agent_save_error",
                    agent_id=sk_id, detail=str(exc),
                )

    if writer:
        writer.close()

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
    parser.add_argument("--model-codes-file", type=str, default=None,
                        help="Path to a JSON file mapping agent_id (int key) "
                             "to model source code. Agents whose source contains "
                             "'from sklearn' are trained as sklearn models.")
    parser.add_argument("--search-depths", type=str, default=None,
                        metavar="ID:DEPTH,...",
                        help="Per-agent search depth for expectiminimax. "
                             "Format: comma-separated id:depth pairs, e.g. '1:2,3:1'. "
                             "Depth 1 = greedy (default). Depth 2 = 2-ply (~21x slower).")
    parser.add_argument("--logdir", type=str, default=None,
                        help="Directory for TensorBoard event files (optional). "
                             "Writes win_rate/agent_<id> scalar per epoch. "
                             "Run `uv run tensorboard --logdir <logdir>` to view.")
    args = parser.parse_args()

    if len(args.agent_ids) < 2:
        parser.error("--agent-ids must have at least 2 IDs")
    if args.upload_to_0g and not args.checkpoint_dir:
        parser.error("--upload-to-0g requires --checkpoint-dir")

    sklearn_codes: dict[int, str] = {}
    if args.model_codes_file:
        with open(args.model_codes_file) as _f:
            raw_codes: dict = json.load(_f)
        for _k, _v in raw_codes.items():
            if is_sklearn_code(_v):
                sklearn_codes[int(_k)] = _v

    search_depths: dict[int, int] = {}
    if args.search_depths:
        for part in args.search_depths.split(","):
            if ":" in part:
                k, v = part.strip().split(":", 1)
                search_depths[int(k)] = int(v)

    # Seed torch for reproducible weight initialisation on fresh agents.
    # Do NOT seed Python's random module here — td_lambda_match draws dice
    # from random.randint, so a fixed seed makes every training run play
    # the identical game sequence and the winner never changes.
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
                sklearn_codes=sklearn_codes or None,
                search_depths=search_depths or None,
                logdir=args.logdir,
            )
            completed = True
        finally:
            _emit(fh, "done" if completed else "aborted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
