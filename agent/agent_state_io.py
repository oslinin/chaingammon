"""agent_state_io.py — hybrid load-if-exists checkpoint resolution + upload
helpers for round-robin training.

The round-robin trainer (`agent/round_robin_trainer.py`) needs, for each
on-chain agent_id, either:

  * the agent's most recently uploaded `BackgammonNet` checkpoint
    (resolved via `AgentRegistry.dataHashes[agent_id][1]` → 0G storage
    Merkle root → blob → `agent_profile.load_profile` content-sniff →
    `ModelProfile.net`), or

  * a deterministic per-agent fresh net (gnubg-init core + per-id
    extras-seed) when the agent has no prior checkpoint.

This module is the thin layer that does that lookup and produces an
`AgentState` the trainer can use directly. End-of-run, the symmetric
`save_and_upload_checkpoint` writes the trained net back to 0G storage
(plaintext under `--no-encrypt`, AES-256-GCM otherwise) so the next
training run picks up where this one left off.

`load_or_seed` is injectable in two places — `weights_hash` (the
caller's responsibility to resolve from `AgentRegistry`) and `fetch`
(the bytes-fetcher, defaulting to `og_storage_client.get_blob`). Tests
exercise both branches without touching chain or 0G storage.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import torch

from agent_profile import (
    AgentProfile,
    ModelProfile,
    NullProfile,
    OverlayProfile,
    load_profile,
)
from sample_trainer import (
    DEFAULT_EXTRAS_DIM,
    BackgammonNet,
    save_checkpoint,
)


@dataclass
class AgentState:
    """One agent's runtime state inside a round-robin training run.

    `starting_match_count` is the `match_count` field encoded in the
    loaded checkpoint (0 for fresh-seed agents). The trainer adds the
    matches it plays this run when it writes a new checkpoint, so the
    cumulative count keeps climbing across runs."""

    agent_id: int
    net: BackgammonNet
    extras_dim: int
    starting_match_count: int = 0
    profile_kind: str = "fresh"  # "model" | "overlay" | "null" | "fresh"


def _seed_fresh(agent_id: int, *, extras_dim: int) -> AgentState:
    """Construct a deterministic per-agent BackgammonNet with the same
    gnubg-init core every agent shares + a per-id extras-head seed.
    Mirrors the fallback path in sample_trainer.py:562."""
    net = BackgammonNet(
        extras_dim=extras_dim,
        core_seed=0xBACC,
        extras_seed=agent_id,
    )
    return AgentState(
        agent_id=agent_id,
        net=net,
        extras_dim=extras_dim,
        starting_match_count=0,
        profile_kind="fresh",
    )


def load_or_seed(
    agent_id: int,
    *,
    extras_dim: int = DEFAULT_EXTRAS_DIM,
    weights_hash: Optional[str] = None,
    fetch: Optional[Callable[[str], bytes]] = None,
) -> AgentState:
    """Resolve `agent_id`'s `BackgammonNet` from 0G storage if available,
    else seed deterministically.

    @param agent_id     On-chain ID. Used as the extras-head seed in
                        the seed-fresh fallback.
    @param extras_dim   Width of the extras input. Must match any
                        loaded checkpoint; if a checkpoint disagrees
                        (it carries its own `extras_dim`), the loaded
                        value wins and is reflected in `AgentState`.
    @param weights_hash Pre-resolved 0G Merkle root for this agent.
                        Empty / "0x000..." / None falls through to
                        seed-fresh. Caller queries the chain.
    @param fetch        Optional override of the bytes-fetcher passed
                        to `load_profile`. Defaults to og-bridge.
    """
    if not weights_hash or _is_zero_hash(weights_hash):
        return _seed_fresh(agent_id, extras_dim=extras_dim)

    profile: AgentProfile = load_profile(weights_hash, fetch=fetch)
    if isinstance(profile, ModelProfile) and profile.net is not None:
        loaded_dim = int(profile.metrics().get("extras_dim", extras_dim))
        return AgentState(
            agent_id=agent_id,
            net=profile.net,
            extras_dim=loaded_dim,
            starting_match_count=int(profile.metrics().get("match_count", 0)),
            profile_kind="model",
        )

    # Overlay or null profile — agent has on-chain weights_hash but it
    # points at JSON, not a checkpoint. Seed fresh and tag the kind so
    # the trainer's status JSONL surfaces "this agent had no model
    # checkpoint, started untrained".
    state = _seed_fresh(agent_id, extras_dim=extras_dim)
    if isinstance(profile, OverlayProfile):
        state.profile_kind = "overlay"
    elif isinstance(profile, NullProfile):
        state.profile_kind = "null"
    return state


def save_and_upload_checkpoint(
    state: AgentState,
    *,
    checkpoint_dir: Path,
    upload: bool = False,
    encrypt: bool = True,
    matches_played: int = 0,
) -> tuple[Path, Optional[str]]:
    """Write `state.net` to `checkpoint_dir/agent-{id}.pt` and optionally
    upload to 0G storage. Returns `(local_path, root_hash | None)`.

    Mirrors the upload block in `sample_trainer.main()` (around
    sample_trainer.py:679–704); refactored here so the round-robin
    trainer + standalone trainer share one canonical save+upload path.

    @param matches_played  Added to `state.starting_match_count` when
                           writing the checkpoint, so cumulative
                           training history persists across runs.
    """
    checkpoint_dir = Path(checkpoint_dir)
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    path = checkpoint_dir / f"agent-{state.agent_id}.pt"
    save_checkpoint(
        state.net,
        path,
        match_count=state.starting_match_count + matches_played,
        extras_dim=state.extras_dim,
    )
    if not upload:
        return path, None

    raw = path.read_bytes()
    if encrypt:
        from checkpoint_encryption import encrypt_blob, generate_key

        key = generate_key()
        sealed = encrypt_blob(raw, key)
        key_path = path.with_suffix(path.suffix + ".key")
        key_path.write_bytes(key)
    else:
        sealed = raw

    from og_storage_upload import upload_checkpoint

    result = upload_checkpoint(sealed)
    return path, result.root_hash


# ─── helpers ────────────────────────────────────────────────────────────────


def _is_zero_hash(h: str) -> bool:
    """A 32-byte zero hash means 'no entry on chain'. Accept any
    hex-prefixed empty hash representation."""
    if not h:
        return True
    body = h[2:] if h.startswith("0x") else h
    return all(c == "0" for c in body)
