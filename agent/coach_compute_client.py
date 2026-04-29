"""
0G Compute client — thin Python wrapper around the og-compute-bridge Node CLI.

@notice There is no native Python SDK for 0G Compute, so we shell out to the
        TypeScript SDK via og-compute-bridge/src/chat.mjs. The bridge handles
        ledger creation, sub-account funding, provider discovery, and signed
        request headers. The Python side just builds the chat payload and
        decodes the JSON response.

@dev    Mirrors server/app/og_storage_client.py's subprocess pattern. Reads
        OG_STORAGE_RPC and OG_STORAGE_PRIVATE_KEY from the process env (the
        compute bridge reuses the storage bridge wallet so a single funded
        account drives both flows).
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Path to og-compute-bridge at the repo root. agent/ → repo root → og-compute-bridge.
_BRIDGE_DIR = Path(__file__).resolve().parents[1] / "og-compute-bridge"
_CHAT_SCRIPT = _BRIDGE_DIR / "src" / "chat.mjs"

_REQUIRED_ENV = ("OG_STORAGE_RPC", "OG_STORAGE_PRIVATE_KEY")


class OgComputeError(RuntimeError):
    """Wraps any error from the og-compute-bridge subprocess."""


@dataclass(frozen=True)
class ChatResult:
    """What og-compute-bridge returns from a successful inference call."""

    content: str
    model: str
    provider_address: str


def _check_env() -> None:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise OgComputeError(f"Missing env vars for 0G Compute: {missing}")


def chat(
    messages: list[dict],
    *,
    system: str | None = None,
    timeout: float = 120.0,
) -> ChatResult:
    """Run a single chat-completion against 0G Compute via the Node bridge.

    @param messages   OpenAI-format chat messages: [{"role": "user", "content": ...}, ...]
    @param system     Optional system prompt prepended as a {"role": "system"} entry.
    @param timeout    Subprocess wall-clock cap in seconds. Includes ledger setup,
                      sub-account top-up, and the actual inference call. The first
                      run on a fresh wallet can take ~30s to establish the ledger.
    @return           ChatResult(content, model, provider_address).
    @raises OgComputeError on missing env vars, non-zero exit, or malformed output.
    """
    _check_env()
    if not messages:
        raise OgComputeError("chat() requires a non-empty messages list")
    payload: dict = {"messages": messages}
    if system:
        payload["system"] = system
    proc = subprocess.run(
        ["node", str(_CHAT_SCRIPT)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        env=os.environ.copy(),
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise OgComputeError(
            f"og-compute-bridge failed (exit {proc.returncode}): "
            f"{proc.stderr.decode(errors='replace')}"
        )
    try:
        out = json.loads(proc.stdout.decode().strip())
    except json.JSONDecodeError as e:
        raise OgComputeError(f"og-compute-bridge returned non-JSON: {proc.stdout!r}") from e
    try:
        return ChatResult(
            content=out["content"],
            model=out["model"],
            provider_address=out["providerAddress"],
        )
    except KeyError as e:
        raise OgComputeError(f"og-compute-bridge response missing field: {e}") from e
