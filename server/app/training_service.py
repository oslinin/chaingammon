"""training_service.py — singleton job manager for the /training/* endpoints.

Spawns one `agent/round_robin_trainer.py` subprocess at a time and
reads the trainer's JSONL status file on demand to compute aggregate
progress. The trainer's existing emit semantics are preserved — this
service is a thin reader on top, not a wrapper.

Lifecycle:
    POST /training/start    → start_job() — spawns subprocess, stashes
                              TrainingJob in module-level singleton.
    GET  /training/status   → get_status() — reads JSONL + checks
                              os.kill(pid, 0); returns aggregate dict.
    POST /training/abort    → abort_job() — SIGTERM → 5 s grace →
                              SIGKILL; clears singleton.

Process death without a 'done' event in the JSONL is interpreted as
'aborted' (matches the contract Phase D's sample_trainer/round_robin
trainer establish — 'done' is emitted only on graceful completion).

Singleton is in-memory: server restart loses job state. Status JSONL
files persist in tmp for post-mortem debugging.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# Repository root — agent/round_robin_trainer.py lives at ../agent/.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENT_DIR = _REPO_ROOT / "agent"
_TRAINER = _AGENT_DIR / "round_robin_trainer.py"


# Used by /training/estimate when use_0g_inference is true. Calibrated
# from typical race lengths in the trainer's test fixtures; configurable
# via env so we don't have to push a code change to recalibrate.
MEAN_PLIES_PER_GAME = int(os.environ.get("CHAINGAMMON_MEAN_PLIES", "60"))


# Phase G: real per-inference price comes from broker.inference's
# getServiceMetadata(provider). For Phase E we expose a constant default
# that the frontend can render so the gas-estimate row isn't empty;
# Phase G replaces this with a live price call.
_DEFAULT_PER_INFERENCE_OG = float(
    os.environ.get("CHAINGAMMON_PER_INFERENCE_OG", "0.00001")
)


@dataclass
class TrainingJob:
    """One running (or recently-finished) training subprocess."""

    pid: int
    started_at: datetime
    epochs: int
    agent_ids: list[int]
    status_file_path: Path
    log_path: Path
    use_0g_inference: bool
    use_0g_coaching: bool
    process: Optional[subprocess.Popen] = field(default=None, repr=False)


_current_job: Optional[TrainingJob] = None


# ─── lifecycle ──────────────────────────────────────────────────────────────


def _is_pid_alive(pid: int) -> bool:
    """`os.kill(pid, 0)` is the standard 'does this PID exist' probe.
    Raises ProcessLookupError if the process is gone, PermissionError
    if it exists but is owned by a different user (treat as alive)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _clear_if_dead() -> None:
    """If the singleton job's process has exited, clear the global so a
    new start can succeed. Called at the top of start_job() and
    get_status()."""
    global _current_job
    if _current_job is not None and not _is_pid_alive(_current_job.pid):
        # Don't drop the JSONL path — the status reader still wants it
        # for post-mortem; just zero out the module global so a new
        # start_job() doesn't 409 against a corpse.
        _current_job = None


def start_job(
    *,
    epochs: int,
    agent_ids: list[int],
    use_0g_inference: bool = False,
    use_0g_coaching: bool = False,
    extras_dim: int = 16,
    seed: int = 42,
    checkpoint_dir: Optional[Path] = None,
    upload_to_0g: bool = False,
    no_encrypt: bool = False,
) -> TrainingJob:
    """Spawn round_robin_trainer.py with the given args.

    Raises RuntimeError if a job is already running. The caller (the
    HTTP endpoint) translates that to a 409.

    Tests substitute the trainer subprocess by monkey-patching
    `training_service.subprocess.Popen` (resolved at call time, not
    import time, so the patch lands before this function fires).
    """
    global _current_job
    _clear_if_dead()
    if _current_job is not None:
        raise RuntimeError("a training job is already running")

    if epochs < 1:
        raise ValueError("epochs must be >= 1")
    if len(agent_ids) < 2:
        raise ValueError("agent_ids must have at least 2 entries")

    # Status file lives in tmp; one file per run. Persistent across
    # process death so /training/status can still surface the final
    # state after the trainer exits.
    fd, status_path = tempfile.mkstemp(prefix="chaingammon-training-", suffix=".jsonl")
    os.close(fd)
    status_file = Path(status_path)

    log_fd, log_path = tempfile.mkstemp(prefix="chaingammon-training-", suffix=".log")
    log_file = Path(log_path)

    cmd = [
        sys.executable,
        str(_TRAINER),
        "--agent-ids", ",".join(str(a) for a in agent_ids),
        "--epochs", str(epochs),
        "--status-file", str(status_file),
        "--extras-dim", str(extras_dim),
        "--seed", str(seed),
    ]
    if checkpoint_dir is not None:
        cmd.extend(["--checkpoint-dir", str(checkpoint_dir)])
    if upload_to_0g:
        cmd.append("--upload-to-0g")
    if no_encrypt:
        cmd.append("--no-encrypt")
    if use_0g_inference:
        cmd.append("--use-0g-inference")

    # Open log file for the subprocess to write to.
    log_fh = open(log_path, "w")
    try:
        # Look up Popen on the module at call time so test monkeypatches
        # apply. Default argument capture-at-import would dodge them.
        process = subprocess.Popen(
            cmd,
            cwd=str(_AGENT_DIR),
            stdout=log_fh,
            stderr=log_fh,
        )
    except Exception:
        log_fh.close()
        status_file.unlink(missing_ok=True)
        log_file.unlink(missing_ok=True)
        raise

    job = TrainingJob(
        pid=process.pid,
        started_at=datetime.now(timezone.utc),
        epochs=epochs,
        agent_ids=list(agent_ids),
        status_file_path=status_file,
        log_path=log_file,
        use_0g_inference=use_0g_inference,
        use_0g_coaching=use_0g_coaching,
        process=process,
    )
    _current_job = job
    return job


def abort_job(*, grace_seconds: float = 5.0) -> bool:
    """SIGTERM → grace_seconds → SIGKILL. Returns True if a job was
    running and is now (or will shortly be) terminated; False if no
    job was running."""
    global _current_job
    if _current_job is None or not _is_pid_alive(_current_job.pid):
        _current_job = None
        return False

    pid = _current_job.pid
    proc = _current_job.process
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        _current_job = None
        return True

    if proc is not None:
        try:
            proc.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
    else:
        # No Popen handle (test substitution) — sleep + SIGKILL.
        deadline = time.time() + grace_seconds
        while time.time() < deadline and _is_pid_alive(pid):
            time.sleep(0.05)
        if _is_pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    _current_job = None
    return True


def get_current_job() -> Optional[TrainingJob]:
    return _current_job


def reset_for_tests() -> None:
    """Clear the singleton — for use in test setup/teardown only."""
    global _current_job
    _current_job = None


# ─── status aggregation ─────────────────────────────────────────────────────


def get_status() -> dict[str, Any]:
    """Read the current (or most recent) job's JSONL status file and
    aggregate.

    Does NOT clear the singleton when the job is dead — that would
    make the closing 'done' event invisible to the next status poll.
    `start_job` clears stale jobs before spawning a new one, so the
    'most recent done' state stays readable for as long as the
    backend doesn't get a new /training/start.

    Returns a stable dict shape regardless of whether a job is running,
    so the frontend's React Query can `useQuery({ queryKey: [...] })`
    without conditional rendering tricks."""
    job = _current_job
    if job is None:
        return _empty_status()

    events = _read_events(job.status_file_path)
    return _aggregate(events, job=job, alive=_is_pid_alive(job.pid))


def aggregate_for_tests(events: list[dict], *, job: Optional[TrainingJob] = None,
                         alive: bool = False) -> dict[str, Any]:
    """Test seam — exposes the pure aggregation logic without singleton state."""
    return _aggregate(events, job=job, alive=alive)


def _empty_status() -> dict[str, Any]:
    return {
        "running": False,
        "completed_games": 0,
        "total_games": 0,
        "current_epoch": 0,
        "total_epochs": 0,
        "agent_ids": [],
        "per_agent": {},
        "use_0g_inference": False,
        "use_0g_coaching": False,
        "ended": None,
        "last_update_ts": 0.0,
    }


def _read_events(path: Path) -> list[dict]:
    """Tolerant JSONL reader: skips malformed lines (the trainer
    line-buffers, but a process death mid-write could leave a partial
    final line)."""
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _aggregate(events: list[dict], *, job: Optional[TrainingJob],
                alive: bool) -> dict[str, Any]:
    started: Optional[dict] = None
    matches: list[dict] = []
    last_epoch_completed = -1
    ended: Optional[str] = None
    last_ts = 0.0

    for e in events:
        kind = e.get("event")
        ts = float(e.get("ts", 0.0))
        if ts > last_ts:
            last_ts = ts
        if kind == "started":
            started = e
        elif kind == "match":
            matches.append(e)
        elif kind == "epoch_end":
            last_epoch_completed = max(last_epoch_completed,
                                        int(e.get("epoch", -1)))
        elif kind == "done":
            ended = "done"
        elif kind == "aborted":
            ended = "aborted"

    per_agent: dict[int, dict] = {}
    for m in matches:
        for side in ("agent_a", "agent_b"):
            aid = int(m[side])
            d = per_agent.setdefault(aid, {"games": 0, "wins": 0, "losses": 0})
            d["games"] += 1
        winner = int(m["winner"])
        per_agent[winner]["wins"] += 1
        loser_field = "agent_b" if int(m["agent_a"]) == winner else "agent_a"
        per_agent[int(m[loser_field])]["losses"] += 1

    if started is None:
        # No events yet; the subprocess might still be coming up.
        return {
            **_empty_status(),
            "running": alive,
            "last_update_ts": last_ts,
            "use_0g_inference": bool(job.use_0g_inference) if job else False,
            "use_0g_coaching": bool(job.use_0g_coaching) if job else False,
        }

    total_games = int(started.get("total_games", 0))
    total_epochs = int(started.get("epochs", 0))
    agent_ids = [int(a) for a in started.get("agent_ids", [])]
    completed_games = len(matches)

    # If process is dead and we never saw 'done', treat as aborted.
    if ended is None and not alive:
        ended = "aborted"

    running = alive and ended is None

    return {
        "running": running,
        "completed_games": completed_games,
        "total_games": total_games,
        "current_epoch": last_epoch_completed + 1 if running else last_epoch_completed,
        "total_epochs": total_epochs,
        "agent_ids": agent_ids,
        "per_agent": {
            str(aid): {
                "games": per_agent.get(aid, {}).get("games", 0),
                "wins": per_agent.get(aid, {}).get("wins", 0),
                "losses": per_agent.get(aid, {}).get("losses", 0),
            }
            for aid in agent_ids
        },
        "use_0g_inference": bool(started.get("use_0g_inference", False)),
        "use_0g_coaching": bool(job.use_0g_coaching) if job else False,
        "ended": ended,
        "last_update_ts": last_ts,
    }


# ─── /training/estimate helper ──────────────────────────────────────────────


def estimate_run(
    epochs: int,
    agent_ids: list[int],
    use_0g_inference: bool,
    *,
    per_inference_og: float = _DEFAULT_PER_INFERENCE_OG,
    eval_estimator=None,
) -> dict[str, Any]:
    """Compute the gas estimate for a training run.

    Local mode (use_0g_inference=False): cost is zero; the response is
    arithmetic only (number of games + inferences for the UI).

    0G mode: calls `eval_estimator(count)` if provided (Phase G) for a
    live price; otherwise uses the env-configured default. The
    `available` field tells the frontend whether the eval bridge is
    actually wired — when False, the toggle should disable itself
    with the carried `note`.
    """
    n = len(agent_ids)
    games = epochs * n * (n - 1) // 2 if n >= 2 else 0
    total_inferences = games * MEAN_PLIES_PER_GAME

    if not use_0g_inference:
        return {
            "games": games,
            "total_inferences": total_inferences,
            "gas_og": 0.0,
            "per_inference_og": 0.0,
            "available": True,
        }

    if eval_estimator is not None:
        try:
            result = eval_estimator(total_inferences)
            # Result has `available` (the eval bridge returns this when
            # the discovery step couldn't find a provider but pricing
            # arithmetic still works). Honor it instead of always
            # returning available=true.
            return {
                "games": games,
                "total_inferences": total_inferences,
                "gas_og": float(result.total_og),
                "per_inference_og": float(result.per_inference_og),
                "available": bool(getattr(result, "available", True)),
                "note": str(getattr(result, "note", "")),
            }
        except Exception as e:
            return {
                "games": games,
                "total_inferences": total_inferences,
                "gas_og": 0.0,
                "per_inference_og": 0.0,
                "available": False,
                "note": f"OG_EVAL_UNAVAILABLE: {e}",
            }

    # No eval_estimator passed (Phase G not wired). Surface honest
    # placeholder pricing so the frontend can still render the row.
    return {
        "games": games,
        "total_inferences": total_inferences,
        "gas_og": per_inference_og * total_inferences,
        "per_inference_og": per_inference_og,
        "available": False,
        "note": "Phase G eval bridge not wired yet; price is a placeholder",
    }
