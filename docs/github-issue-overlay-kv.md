# Move all agent weights from 0G blob storage to 0G KV

@claude

## Background and rationale

The agent iNFT currently uses two `dataHashes` slots committed on-chain in `AgentRegistry`:

- `dataHashes[0]` — gnubg base weights, further fine-tuned via TD-λ RL (the large ONNX checkpoint)
- `dataHashes[1]` — feature/style weights also updated by the same RL training runs (the 21-float `Overlay` vector in `agent_overlay.py`)

Both artifacts are produced by the same training process (`training_service.py`), have the same mutability profile (change after every training run), and are controlled by the same authorized writer (the server's `DEPLOYER_PRIVATE_KEY`). There is no meaningful reason to use different storage primitives for them.

**Both should move to 0G KV**, with `dataHashes[0]` and `dataHashes[1]` on-chain dropped or repurposed.

### Why 0G KV, not 0G blob storage

0G KV is stored on the same decentralized 0G network as blob storage — the data lives on 0G nodes, not on anyone's server. The difference between the two primitives is:

| | 0G blob | 0G KV |
|---|---|---|
| Addressing | Content-addressed (root hash = Merkle root of content) | Key-addressed (stable key → latest value) |
| Mutability | Immutable — old blobs persist forever | Mutable — key points to latest write |
| On-chain footprint | Root hash committed per write | No on-chain commitment required |
| Orphaned data | Every training run leaves a stale blob | Previous value is overwritten in place |

The current blob approach commits a root hash to `AgentRegistry` on every training run. This burns gas per run, orphans old blobs, and doesn't add meaningful security: the same deployer key that could swap the blob could also update the on-chain hash pointer. The content-addressing guarantee is real but not actionable for Chaingammon — nobody is forensically auditing historical weight snapshots per match.

0G KV gives each agent a **stable, mutable address** (`chaingammon/weights/agent/{id}` and `chaingammon/overlay/agent/{id}`) that the training service overwrites in place, with no per-run gas cost and no orphaned blobs.

### The style overlay was already broken

Per-game overlay updates (updating the 21-float vector after every real match) were the original design intent but were disabled because blob storage made every game write an on-chain tx. See the comments at `main.py:1006` and `main.py:1183`:

> "Per-game overlay bumps were dropped — every finished match used to call updateOverlayHash on each agent (and upload a fresh overlay blob to 0G Storage), which churned `experienceVersion` and burned gas on writes that didn't reflect a meaningful retraining step."

Moving the overlay to KV re-enables per-game learning at essentially no cost — a KV write has no on-chain component.

### Human players

Once human style profiles are introduced, they should use 0G KV keyed by wallet address (`chaingammon/overlay/human/{address_lower}`). The per-game overlay update logic is identical; only the key changes. Blob storage + on-chain hash per game is not viable for humans.

---

## What to change

### 1. Research the 0G KV API

The installed SDK (`@0gfoundation/0g-ts-sdk` v1.2.6, `og-bridge/node_modules/`) does not export a KV client — it only exports `Indexer`, `Uploader`, `Downloader`. Before writing any code:

- Check the [0G documentation](https://docs.0g.ai) and the SDK changelog for KV support.
- Determine the correct access pattern: updated SDK export, separate package, or direct HTTP API.
- Document findings as a short comment at the top of `og-bridge/src/kv-put.mjs`.

If 0G KV is not yet available on testnet, implement a `localhost` mock (a plain JSON file at `/tmp/chaingammon-kv-mock.json`) so the rest of the code can be wired and tested end-to-end without a live network. Use the same `OG_STORAGE_MODE=localhost` env-var pattern as `upload.mjs`.

### 2. Add KV bridge scripts

Create `og-bridge/src/kv-put.mjs` and `og-bridge/src/kv-get.mjs` following the same conventions as `upload.mjs` / `download.mjs`:

**`kv-put.mjs`**
- Args: `node kv-put.mjs <key>`; value bytes on stdin.
- Writes to 0G KV under `key`. Overwrites any prior value.
- Stdout: single JSON line `{ "key": "...", "ok": true }`.
- Supports `OG_STORAGE_MODE=localhost` mock.

**`kv-get.mjs`**
- Args: `node kv-get.mjs <key>`.
- Fetches from 0G KV. Writes raw bytes to stdout.
- Exits non-zero with a clear message if the key is not found.
- Supports `OG_STORAGE_MODE=localhost` mock.

### 3. Add `put_kv` / `get_kv` to `og_storage_client.py`

Add alongside `put_blob` / `get_blob`:

```python
def put_kv(key: str, data: bytes, *, timeout: float = 30.0) -> None:
    """Write `data` to 0G KV under `key`. Overwrites any prior value."""

def get_kv(key: str, *, timeout: float = 30.0) -> bytes:
    """Fetch bytes from 0G KV. Raises OgStorageError if the key is not found."""
```

Canonical key scheme:

| Artifact | Key |
|---|---|
| Agent NN weights (ONNX) | `chaingammon/weights/agent/{agent_id}` |
| Agent feature overlay (21-float JSON) | `chaingammon/overlay/agent/{agent_id}` |
| Human feature overlay (future) | `chaingammon/overlay/human/{wallet_address_lower}` |

### 4. Update `training_service.py` — write both artifacts to KV

In `_post_training_chain_writes` (currently writes root hash to `dataHashes[1]` after a training run):

- Instead of `put_blob` + `update_overlay_hash`, call:
  - `put_kv(f"chaingammon/weights/agent/{agent_id}", weights_bytes)` for the ONNX checkpoint.
  - `put_kv(f"chaingammon/overlay/agent/{agent_id}", overlay_bytes)` for the feature overlay (if the trainer produces one; otherwise skip).
- Remove the `chain.update_overlay_hash(...)` call — no on-chain hash write is needed.
- Update `_emit_chain_write` events accordingly: replace `root_hash`/`tx_hash` fields with `kv_key`.

The training page's `chain_writes` status panel should still show a completion entry per agent; update the displayed fields to show the KV key written rather than a tx hash.

### 5. Restore per-game overlay updates using KV

In `_fetch_overlay` (`main.py:889`): read from `get_kv(f"chaingammon/overlay/agent/{agent_id}")`. Fall back to `Overlay.default()` if the key is not found (cold-start agent). Remove the `get_blob(overlay_hash)` call.

In `finalize_game` and `finalize_game_from_record`: replace the no-op `overlay_updates: list[dict] = []` blocks with real per-game overlay persistence:

```python
# For each agent side (winner and loser):
#   1. current = get_kv(f"chaingammon/overlay/agent/{agent_id}") → Overlay.from_bytes, or Overlay.default()
#   2. new_overlay = update_overlay(current, agent_moves_this_game, won, current.match_count)
#   3. put_kv(f"chaingammon/overlay/agent/{agent_id}", new_overlay.to_bytes())
#   4. append { agent_id, match_count: new_overlay.match_count } to overlay_updates
```

KV failures are non-fatal: log a warning and populate `overlay_updates[n].error`. Do not raise an HTTP exception — the match is already on-chain.

### 6. Drop `dataHashes` on-chain commits

- Remove `chain.update_overlay_hash(...)` calls from `training_service.py` (covered above).
- Remove the `AGENT_REGISTRY_ADDRESS` requirement for the training chain-write path if it's only used for `update_overlay_hash`. Keep it for other `AgentRegistry` reads (agent enumeration, match count, tier).
- Do not change the `AgentRegistry` contract itself. `dataHashes` slots simply won't be written to after this change; they'll stay at whatever value they last held (or `bytes32(0)` for new agents).

### 7. Update `get_agent_profile` (`main.py:2146`)

Currently reads `dataHashes[1]` and content-sniffs the blob. After this change:

1. Fetch NN weights from `get_kv(f"chaingammon/weights/agent/{agent_id}")` → pass to `load_profile`.
2. Fetch feature overlay from `get_kv(f"chaingammon/overlay/agent/{agent_id}")` → `Overlay.from_bytes`.
3. Return both in the response (overlay values as `overlay_values: dict[str, float]`).

### 8. Add tests

- `server/tests/test_og_kv.py`: unit-tests for `put_kv` / `get_kv` under `OG_STORAGE_MODE=localhost`. Cover round-trip, key isolation between agents, and `OgStorageError` on missing key.
- Extend `test_phase9_overlay_integration.py`: verify `finalize_game` writes an overlay to KV and a subsequent `_fetch_overlay` reads it back (no blob calls involved).
- Extend training tests: verify `_post_training_chain_writes` writes to KV keys and no longer calls `update_overlay_hash`.

### 9. Update inline documentation

- `og_storage_client.py` module docstring: explain the two primitives — blob for immutable content-addressed data (game records), KV for mutable agent state (weights, overlays).
- `agent_overlay.py` module docstring: note that overlays are stored in 0G KV, updated per game.
- `main.py`: replace "Per-game overlay bumps were dropped" comments with the new KV path description.
- `training_service.py`: update docstrings on `_post_training_chain_writes` to describe KV writes.

---

## What not to change

- Game record uploads — `put_blob` is still correct for per-match `GameRecord` blobs (immutable, content-addressed, fetched by root hash stored in `MatchRegistry`).
- `Overlay` dataclass, `CATEGORIES`, `classify_move`, `apply_overlay`, `update_overlay` — only the persistence layer changes; the overlay logic itself is unchanged.
- `AgentRegistry` contract — no Solidity changes. `dataHashes` slots are left as-is.
- ENS text records — `style_uri` is a future field; leave unset for now.

---

## Acceptance criteria

- [ ] `OG_STORAGE_MODE=localhost`: `put_kv` + `get_kv` round-trip returns identical bytes.
- [ ] Training run writes ONNX weights to `chaingammon/weights/agent/{id}` in KV (no blob upload, no on-chain hash write).
- [ ] `_fetch_overlay` reads from KV; cold-start agents get `Overlay.default()`.
- [ ] `finalize_game` writes an updated overlay to KV for each agent side after every real match.
- [ ] `get_agent_profile` returns weights summary (from KV) and overlay values (from KV).
- [ ] Game record blobs (`put_blob` in `finalize_game`) are untouched.
- [ ] All existing overlay and training tests pass.
- [ ] New KV tests pass under `OG_STORAGE_MODE=localhost`.
