# KeeperHub feedback — Chaingammon Phase 37 integration

## Context

Chaingammon's [keeperhub-workflow.md](keeperhub-workflow.md) describes the full workflow KeeperHub will eventually orchestrate: a per-turn loop pulling drand, deriving dice, validating moves through a WASM rules engine, and a final settlement phase that submits the result to Sepolia, pays out the winner, and updates ENS text records.

[Phase 37 of this codebase](../server/app/keeper_workflow.py) implemented a strict subset of that — an 8-step post-settlement audit orchestrator that runs once a match is already on-chain. The 8 steps were locked in at Phase 36 against a hypothetical `kh run status --json` API and mirrored across the frontend's `/keeper/[matchId]` page. The full per-turn loop (drand-driven dice + WASM move validation + per-turn audit log) wasn't built.

This document records what worked, what was painful, and what would have made the integration smoother — written from the perspective of an application team trying to implement the workflow directly from the spec, with no reference KeeperHub binary or SDK to call.

## What worked

### The Phase-36 contract-first design

Locking the response shape (`{matchId, status, steps[]}` with the 8 step IDs and the per-step `{id, name, status, duration_ms, retry_count, tx_hash, error, detail}` schema) before any real implementation existed turned out to be the single biggest win. The frontend (`/keeper/[matchId]`) was built against the mock and required **zero changes** when Phase 37 swapped in the real orchestrator. This is the right pattern: lock the wire shape early, let frontend and backend evolve in parallel.

The schema-as-contract approach extended cleanly into [keeperhub-workflow.schema.json](keeperhub-workflow.schema.json), which we used as a machine-checkable definition of the output a real `kh run status --json` would emit.

### 8-step canonical ontology

The eight step IDs (`escrow_deposit`, `vrf_rolls`, `og_storage_fetch`, `gnubg_replay`, `settlement_signed`, `relay_tx`, `ens_update`, `audit_append`) covered every distinct verification a post-settlement auditor would want, with clean separation of concerns. Each step has exactly one failure mode that justifies its existence; nothing felt vestigial. We didn't add or remove steps during implementation.

### Sequential-with-fail-stop semantics

A step failure marking itself `failed` while the remainder stay `pending` (and the workflow status flips to `failed`) made debugging straightforward. An auditor reading the response immediately sees *which* step broke and *why* (via the `error` field), without spelunking through logs. We considered "continue past failures and surface a multi-failure summary" but rejected it — the simpler model is more honest for an audit trail.

### Per-step `duration_ms` and `tx_hash` fields

Surfacing per-step duration was free (just bracket the runner with `time.time()`) and immediately useful — operators glancing at `/keeper/[matchId]` see at a glance which step dominates the workflow's runtime. The per-step `tx_hash` slot — even when populated with audit anchors rather than literal tx hashes — gives the frontend a clean rendering convention (the `↗ tx` link).

## What we built ourselves (and shouldn't have to)

### A whole orchestrator

There's no `kh` binary or SDK to call from Python. The Phase-36 docstring says "TODO(phase-37): Replace this endpoint's body with a real `kh run status --json` call once the KeeperHub workflow is wired" — but Phase 37 had to build the workflow runner, the persistence layer, the failure semantics, the background-thread spawn-and-poll model, and the JSON-on-disk audit cache from scratch.

This is ~410 LOC ([keeper_workflow.py](../server/app/keeper_workflow.py)) of plumbing that would be a one-line `kh.run("chaingammon-settle", match_id=...)` call against a real KeeperHub Python client. The fact that we ended up with a working orchestrator just means the design is simple enough to clone — but every team integrating KeeperHub will write the same plumbing until a reference SDK ships.

### Persistence

We persist every workflow run to `/tmp/chaingammon-keeper-workflows/<matchId>.json` so the GET endpoint can return live status across server restarts and so judges navigating away from `/keeper/[matchId]` mid-run come back to a populated view. This is a tiny cache by design, but it's still local-FS only — no shared storage, no leader election if there were multiple keeper instances. A real KeeperHub deployment would presumably handle this for us; we built a per-process workaround.

### Background-thread spawn + polling protocol

`POST /keeper-workflow/{id}/run` returns the initial running state and spawns a daemon thread; the frontend polls every 1.5s. This is fine for one workflow at a time on one host, but it's not what a real KeeperHub-orchestrated installation would look like (job queue, worker pool, durable state machine). We built the simplest thing that worked for one machine + one match.

## Pain points

### `recordMatch` tx hash isn't queryable from `MatchInfo`

The `relay_tx` step's natural payload would be the on-chain `recordMatch` tx hash — the etherscan link an auditor would actually click. But `MatchRegistry.MatchInfo` only stores `{timestamp, winnerAgentId, winnerHuman, loserAgentId, loserHuman, matchLength, gameRecordHash}`. Recovering the tx hash requires `eth_getLogs` against the contract, which is heavyweight, RPC-provider-dependent, and not always available cheaply.

We compromised by surfacing `gameRecordHash` (the 0G Storage rootHash) as the audit anchor instead — that's also a meaningful "click here to see what happened" link, but it's less obviously a "settlement transaction" to a blockchain-native auditor.

**Suggestion:** include the recordMatch tx hash in `MatchInfo`, or expose a helper view function `getRecordMatchTx(matchId) -> bytes32` on `MatchRegistry`.

### `match_id` type mismatch between gnubg and chain

gnubg's `match_id` is a base64-encoded short string. `MatchRegistry`'s `matchId` is a `uint256`. The keeper workflow needs the `uint256` (because that's what `chain.get_match` takes), but the frontend often has the gnubg base64 (because that's what `/games/{game_id}` returned during play).

`step_escrow_deposit` raises `RuntimeError` with a clear "re-run with the int matchId returned by /finalize-game" message when given a base64 string — but this is a footgun every integrator will hit. The frontend had to be careful to track *both* identifiers and pass the right one to `/keeper-workflow/{id}/run`.

**Suggestion:** standardize on one identifier shape across the whole match lifecycle. The `keccak256(playerA || playerB || nonce)` pattern from the schema is a good candidate — it's deterministic, fits in `bytes32`, and could be derived by both the gnubg layer and the chain layer.

### Per-move drand round attestation isn't stored in `GameRecord`

`step_vrf_rolls` only verifies that drand is *reachable* — it can't verify that *each turn's actual dice* were derived from a specific drand round, because `MoveEntry` doesn't carry a `drand_round` field and the trainer doesn't currently record it. The full keeperhub-workflow.md spec calls for `pull_drand_round` + `derive_dice` per turn; Phase 37 had to weaken this step to "drand network is up."

**Suggestion:** `MoveEntry.drand_round: Optional[int]` on the canonical GameRecord schema, populated by the move-applier whenever drand-derived dice were used. The `gnubg_replay` step could then re-derive each turn's dice from its drand round and assert legality, closing the audit loop.

### Session-key signature verification has no on-chain query

`step_settlement_signed` is essentially a no-op: it just confirms the `MatchInfo` is present, on the assumption that the recordMatch path verified the session-key signatures before writing. We can't independently re-verify the signatures from MatchRegistry's storage because the signatures aren't stored — only the result of their verification.

**Suggestion:** either (a) store the canonical settlement payload bytes alongside the result so the auditor can recover the exact bytes that were signed, or (b) emit the session-key public keys as event parameters on `MatchSettled` so an auditor can cross-reference.

### `retry_count` is in the schema but the orchestrator doesn't retry

Every step's response carries a `retry_count: int` field. Our orchestrator always emits `0` because we don't implement automatic retry — a step either succeeds or fails-and-aborts on the first try. For drand probes and 0G Storage fetches a 3× exponential retry would obviously be the right policy. We didn't build it because the simplest thing was good enough; in production it should be configurable per step.

**Suggestion:** retry-policy-as-config, declared per step in the workflow definition (the schema's "Retry" column from keeperhub-workflow.md is the right shape).

### "Concurrent matches" is unhandled

`run_workflow_in_thread` takes a single `_run_lock` mutex, so two `/run` POSTs serialize. For a real keeper running many matches in parallel this would be a queue or a worker pool; we punted to "one workflow at a time per process."

## What we'd want from a future KeeperHub SDK

In rough priority order:

1. **A real Python client** — `from keeperhub import run_workflow; run_workflow("chaingammon-settle", match_id=...)`. ~410 LOC of orchestrator code becomes one import.
2. **A workflow-definition format** — declarative TOML/YAML/JSON file that lists steps + retry policies + dependencies. Would let us check the workflow into version control and have KeeperHub validate it at deploy time, instead of hand-coding step ordering.
3. **A reference implementation of the per-step protocol** — e.g. how should a step report progress to KeeperHub? Webhooks? Polling? STDOUT JSON? Settling that would let us build steps as pluggable scripts rather than Python functions inside our orchestrator.
4. **Standard run-audit format** — the `audit_append` step should produce a JSON document that KeeperHub knows how to interpret, so the audit trail is portable across applications.
5. **A test harness** — running our 26 hermetic tests against a stub KeeperHub local-mode would be cleaner than the current "build the orchestrator + mock all of its dependencies" pattern.

## Summary

The Phase-36 contract-first design + 8-step ontology held up well — Phase 37 was a clean slot-in. The pain wasn't shape; it was the absence of a reference orchestrator + a few schema-level gaps in `MatchInfo` and `GameRecord` that forced graceful degradation in `relay_tx`, `vrf_rolls`, and `settlement_signed`. None of these blocked shipping; all of them have clear fixes that would make the next integration team's life easier.

The 8-step audit workflow itself runs end-to-end on this codebase: `POST /keeper-workflow/{matchId}/run` produces a live, persisted, frontend-renderable workflow with real on-chain reads, real 0G Storage fetches, real gnubg replays, real ENS cross-checks, and a real audit JSON pinned to 0G Storage. The plumbing we built is generic — anyone implementing the same spec against the same primitives would land in roughly the same place.
