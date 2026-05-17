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

# When OG_EQUITY_URL is set (e.g. http://136.112.73.124), evaluate() and
# estimate() call that server's /equity endpoint directly, bypassing the
# 0G broker entirely. Use this when the provider is not yet registered
# on-chain (addOrUpdateService requires a 100 OG ledger stake on testnet).
_OG_EQUITY_URL = os.environ.get("OG_EQUITY_URL", "").rstrip("/")

# Per-inference pricing shown in the gas estimate when running in direct mode.
_DIRECT_PRICE_OG = float(os.environ.get("OG_COMPUTE_PER_INFERENCE_OG", "0.00001"))


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


def _direct_evaluate(
    features: Sequence[float],
    extras: Sequence[float],
    *,
    timeout: float,
) -> EvalResult:
    """POST features+extras to OG_EQUITY_URL/equity, bypassing the broker."""
    import urllib.request
    body = json.dumps({
        "features": [float(x) for x in features],
        "extras": [float(x) for x in extras],
    }).encode()
    req = urllib.request.Request(
        f"{_OG_EQUITY_URL}/equity",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read())
    except Exception as e:
        raise OgEvalError(f"Direct equity call to {_OG_EQUITY_URL} failed: {e}") from e
    return EvalResult(
        equity=float(out["equity"]),
        model=str(out.get("model", "backgammon-net-v1")),
        provider_address=_OG_EQUITY_URL,
    )


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

    When OG_EQUITY_URL is set, calls that server directly (no broker, no
    on-chain settlement). Otherwise routes through the 0G serving network.

    @param features  198-element gnubg board encoding.
    @param extras    16-element career-context vector.
    @raises OgEvalUnavailable when no backgammon-net provider is registered.
    @raises OgEvalError       on any other failure.
    """
    if _OG_EQUITY_URL:
        return _direct_evaluate(features, extras, timeout=timeout)
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

    When OG_EQUITY_URL is set, returns local pricing with available=True.
    Otherwise routes through the 0G serving network; available=False when
    no provider is found.
    """
    if count <= 0:
        raise ValueError("count must be > 0")
    if _OG_EQUITY_URL:
        total = _DIRECT_PRICE_OG * count
        return EstimateResult(
            per_inference_og=_DIRECT_PRICE_OG,
            total_og=total,
            provider_address=_OG_EQUITY_URL,
            available=True,
            note=f"Direct provider at {_OG_EQUITY_URL} (on-chain registration pending)",
        )
    out = _run_bridge({"action": "estimate", "count": int(count)}, timeout=timeout)
    return EstimateResult(
        per_inference_og=float(out.get("per_inference_og", 0.0)),
        total_og=float(out.get("total_og", 0.0)),
        provider_address=str(out.get("providerAddress", "")),
        available=bool(out.get("available", False)),
        note=str(out.get("note", "")),
    )
