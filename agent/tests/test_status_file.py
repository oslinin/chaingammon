"""Tests for sample_trainer.py's --status-file flag.

Run with:  cd agent && uv run pytest tests/test_status_file.py -v

Spawns the trainer as a subprocess so we exercise the full main()
path (argparse, RNG seed, signal handler, file open / close, JSONL
emit at each match, final 'done'). Fast: --matches is small.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "agent"
TRAINER = AGENT_DIR / "sample_trainer.py"


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def _run_trainer(
    *,
    matches: int,
    status_path: Path,
    logdir: Path,
    extra_args: list[str] | None = None,
    timeout: float = 60.0,
) -> subprocess.CompletedProcess:
    """Spawn the trainer to completion and return the CompletedProcess."""
    cmd = [
        sys.executable,
        str(TRAINER),
        "--matches", str(matches),
        "--extras-dim", "16",
        "--logdir", str(logdir),
        "--status-file", str(status_path),
    ]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.run(
        cmd,
        cwd=str(AGENT_DIR),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def test_status_file_round_trip(tmp_path: Path):
    """started → match × N → done. Exit code 0; final event is 'done'."""
    status = tmp_path / "events.jsonl"
    logdir = tmp_path / "tb"

    proc = _run_trainer(matches=3, status_path=status, logdir=logdir)
    assert proc.returncode == 0, (
        f"trainer exited with {proc.returncode}\nstdout:\n{proc.stdout}"
        f"\nstderr:\n{proc.stderr}"
    )

    events = _read_jsonl(status)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "started"
    assert kinds[-1] == "done"
    matches = [e for e in events if e["event"] == "match"]
    assert len(matches) == 3


def test_match_events_carry_winner_and_plies(tmp_path: Path):
    """Each match event has winner ∈ {agent, opponent} and integer plies > 0."""
    status = tmp_path / "events.jsonl"
    proc = _run_trainer(
        matches=2,
        status_path=status,
        logdir=tmp_path / "tb",
    )
    assert proc.returncode == 0
    matches = [e for e in _read_jsonl(status) if e["event"] == "match"]
    assert len(matches) == 2
    for e in matches:
        assert e["winner"] in ("agent", "opponent")
        assert isinstance(e["plies"], int) and e["plies"] > 0
        assert e["match_idx"] in (0, 1)
        assert e["total"] == 2


def test_started_carries_total_and_career_mode_flag(tmp_path: Path):
    """`started` event payload reflects --matches and --career-mode."""
    status = tmp_path / "events.jsonl"
    proc = _run_trainer(
        matches=2,
        status_path=status,
        logdir=tmp_path / "tb",
        extra_args=["--career-mode"],
    )
    assert proc.returncode == 0
    started = _read_jsonl(status)[0]
    assert started["event"] == "started"
    assert started["total"] == 2
    assert started["career_mode"] is True


def test_done_event_has_final_win_rate(tmp_path: Path):
    """The closing `done` event reports `final_win_rate` so the backend
    can surface a final summary."""
    status = tmp_path / "events.jsonl"
    proc = _run_trainer(
        matches=2,
        status_path=status,
        logdir=tmp_path / "tb",
    )
    assert proc.returncode == 0
    done = _read_jsonl(status)[-1]
    assert done["event"] == "done"
    assert isinstance(done["final_win_rate"], float)
    assert 0.0 <= done["final_win_rate"] <= 1.0


def test_no_status_file_means_no_emission(tmp_path: Path):
    """Backwards-compatible: omit --status-file and the trainer behaves
    exactly as it did before this flag (writes nothing JSONL-shaped)."""
    logdir = tmp_path / "tb"
    cmd = [
        sys.executable, str(TRAINER),
        "--matches", "2", "--extras-dim", "16",
        "--logdir", str(logdir),
    ]
    proc = subprocess.run(
        cmd, cwd=str(AGENT_DIR),
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0
    # No file would have been created at any predetermined path.
    assert not list(tmp_path.glob("*.jsonl"))


def test_sigterm_during_run_leaves_no_done(tmp_path: Path):
    """Send SIGTERM mid-run: the trainer should die without writing
    a 'done' event. The backend treats absence of 'done' as 'aborted'.
    """
    status = tmp_path / "events.jsonl"
    logdir = tmp_path / "tb"
    cmd = [
        sys.executable, str(TRAINER),
        "--matches", "200",                # plenty of headroom
        "--extras-dim", "16",
        "--logdir", str(logdir),
        "--status-file", str(status),
    ]
    proc = subprocess.Popen(
        cmd, cwd=str(AGENT_DIR),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # Wait until at least one match has been emitted, then SIGTERM.
    deadline = time.time() + 30.0
    while time.time() < deadline:
        if status.exists():
            try:
                lines = status.read_text().splitlines()
            except FileNotFoundError:
                lines = []
            if any('"event": "match"' in ln for ln in lines):
                break
        time.sleep(0.1)
    else:
        proc.kill()
        proc.wait()
        pytest.fail("trainer never wrote a match event before deadline")

    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=10)

    events = _read_jsonl(status)
    kinds = {e["event"] for e in events}
    assert "started" in kinds
    assert "done" not in kinds, (
        "SIGTERM mid-run should NOT produce a 'done' event"
    )
