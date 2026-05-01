"""
0G Compute eval client — thin Python wrapper around og-compute-bridge/src/eval.mjs.

@notice There is no native Python SDK for 0G Compute, so we shell out to the
        TypeScript SDK via the Node bridge — the same pattern the coach side
        already uses in `agent/coach_compute_client.py`. The Python side just
        builds the eval payload and decodes the JSON response.

@dev    The eval bridge dispatches a backgammon equity-net forward pass to a
        0G compute provider, OR returns pricing for a hypothetical run of N
        inferences. When no backgammon-net provider is registered on the
        serving network (the common case today), `evaluate()` raises
        `OgEvalUnavailable` and `estimate()` returns `EstimateResult(available=False)`
        so the frontend can disclose the unavailable state instead of erroring.

End-to-end use during training:

    from og_compute_eval_client import evaluate, estimate

    # In td_lambda_match's pick_move, when --use-0g-inference is set:
    eq = evaluate(features.numpy(), extras.numpy()).equity

    # In the /training/estimate endpoint, when use_0g_inference=true:
    info = estimate(total_inferences)
    print(f"~ {info.total_og} OG total")
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


# Path to og-compute-bridge at the repo root. agent/ → repo root → og-compute-bridge.
_BRIDGE_DIR = Path(__file__).resolve().parents[1] / "og-compute-bridge"
_EVAL_SCRIPT = _BRIDGE_DIR / "src" / "eval.mjs"

_REQUIRED_ENV = ("OG_STORAGE_RPC", "OG_STORAGE_PRIVATE_KEY")


class OgEvalError(RuntimeError):
    """Wraps any error from the og-compute-bridge eval subprocess."""


class OgEvalUnavailable(OgEvalError):
    """No backgammon-net provider is registered on the 0G serving network.
    Surfaced separately so callers can fall back to local inference cleanly
    instead of treating it as a hard failure."""


@dataclass(frozen=True)
class EvalResult:
    """One forward-pass result from a 0G compute provider."""

    equity: float
    model: str
    provider_address: str


@dataclass(frozen=True)
class EstimateResult:
    """Pricing for a hypothetical run of N inferences. `available=False`
    means no provider is registered; the price fields contain placeholder
    pricing the frontend may still render."""

    per_inference_og: float
    total_og: float
    provider_address: str
    available: bool
    note: str = ""


def _check_env() -> None:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise OgEvalError(f"Missing env vars for 0G Compute eval: {missing}")


def _run_bridge(payload: dict, *, timeout: float) -> dict:
    """Subprocess to `node og-compute-bridge/src/eval.mjs`, send JSON on
    stdin, parse JSON on stdout. stderr lines are bridge diagnostics
    (mirrors the chat client's pattern)."""
    _check_env()
    if not _EVAL_SCRIPT.exists():
        raise OgEvalError(
            f"og-compute-bridge eval script not found at {_EVAL_SCRIPT}. "
            f"Run `pnpm install` (or `npm install`) from {_BRIDGE_DIR} first."
        )
    proc = subprocess.run(
        ["node", str(_EVAL_SCRIPT)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    stderr = proc.stderr.decode(errors="replace").strip()
    if proc.returncode != 0:
        # The bridge writes a structured `OG_EVAL_UNAVAILABLE` prefix when
        # no provider is found. Map that to OgEvalUnavailable so callers
        # can fall back without a generic catch-all.
        if "OG_EVAL_UNAVAILABLE" in stderr:
            raise OgEvalUnavailable(stderr)
        raise OgEvalError(
            f"og-compute-bridge eval failed (exit {proc.returncode}): {stderr}"
        )
    raw = proc.stdout.decode().strip()
    if not raw:
        raise OgEvalError(f"og-compute-bridge eval produced no stdout. stderr: {stderr}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise OgEvalError(f"og-compute-bridge returned non-JSON: {raw!r}") from e


def evaluate(
    features: Sequence[float],
    extras: Sequence[float],
    *,
    timeout: float = 30.0,
) -> EvalResult:
    """Run one equity-net forward pass on 0G compute.

    @param features  198-element gnubg board encoding (list / np.ndarray /
                     torch.Tensor — anything iterable to floats).
    @param extras    16-element career-context vector.
    @param timeout   Subprocess wall-clock cap (seconds). First call on a
                     fresh wallet may take ~30s for ledger bootstrap.
    @raises OgEvalUnavailable when no backgammon-net provider is registered.
    @raises OgEvalError       on any other bridge failure.
    """
    payload = {
        "action": "evaluate",
        "features": [float(x) for x in features],
        "extras": [float(x) for x in extras],
    }
    out = _run_bridge(payload, timeout=timeout)
    try:
        return EvalResult(
            equity=float(out["equity"]),
            model=str(out.get("model", "")),
            provider_address=str(out["providerAddress"]),
        )
    except KeyError as e:
        raise OgEvalError(f"og-compute-bridge response missing field: {e}") from e


def estimate(count: int, *, timeout: float = 15.0) -> EstimateResult:
    """Compute pricing for `count` inferences on 0G compute.

    Always returns a result; `available=False` when no provider is found
    so the frontend can render a placeholder cost row + disclose state.
    """
    if count <= 0:
        raise ValueError("count must be > 0")
    out = _run_bridge({"action": "estimate", "count": int(count)}, timeout=timeout)
    return EstimateResult(
        per_inference_og=float(out.get("per_inference_og", 0.0)),
        total_og=float(out.get("total_og", 0.0)),
        provider_address=str(out.get("providerAddress", "")),
        available=bool(out.get("available", False)),
        note=str(out.get("note", "")),
    )
