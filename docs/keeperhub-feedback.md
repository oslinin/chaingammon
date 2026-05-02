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

---

## Addendum (2026-05-02) — MCP integration attempt

After the Phase-37 write-up above, we revisited registration of [keeperhub/match-settle.yaml](../keeperhub/match-settle.yaml) on the actual KeeperHub platform via the published MCP server (`https://app.keeperhub.com/mcp`). The intent was a one-shot `kh workflow push match-settle.yaml`-equivalent. What actually happened produced a second batch of specific feedback.

### MCP OAuth state is dropped between tool-call boundaries

`mcp__keeperhub__authenticate` returns a URL and tells the agent: *"Once they complete the flow, the server's tools will become available automatically. If the browser shows a connection error on the redirect page, ask the user to paste the full URL from the address bar and call `mcp__keeperhub__complete_authentication` with it."*

The localhost auto-listener path eventually worked. The manual `complete_authentication` fallback **never** worked across two attempts: the server consistently returned `"No OAuth flow is in progress for keeperhub. Call mcp__keeperhub__authenticate first, then retry with the callback URL."` even though the immediately-prior `authenticate` call returned a fresh `state` value that matched the callback's `state` query param. Conclusion: the OAuth flow record is held in state that's tied to a single MCP request connection, not persisted across agent turns. For an agent that can't always keep its localhost listener alive (e.g. sandboxed environments, headless CI), the documented fallback is not actually usable.

**Suggestion:** persist the OAuth flow record server-side keyed by the pkce `state` value, with a generous TTL (e.g. 10 min). Manual `complete_authentication` should succeed any time within that window regardless of intervening MCP requests.

### `ai_generate_workflow` ignores explicit field-level constraints

We made three sequential `ai_generate_workflow` calls with increasingly aggressive context constraints — the third one literally said *"network MUST be the literal string '11155111'. Eleven-one-one-five-five-one-one-one."* and provided a verbatim 6-arg ABI fragment as `"abi MUST be exactly: …"`. All three runs ignored those constraints:

| Constraint requested verbatim | What was generated |
|---|---|
| `triggerType: "Event"` (real-time event listener) | `Webhook` (run 1: `web3/query-events`; runs 2–3: `Webhook` with fabricated `webhookPath`) |
| `network: "11155111"` | `"Ethereum Sepolia"`, `"sepolia"`, `"Sepolia"` |
| 6-arg verbatim ABI fragment for `recordMatch` | run 2: hallucinated 1-arg `recordMatch(bytes32 matchId)`; run 3: literal placeholder string `"Your contract ABI"` |
| `0x0000000000000000000000000000000000000000` placeholder | `"0xMatchEscrowAddress"`, `"0xYourRegistryAddress"` (not valid hex) |
| 6-element `functionArgs` array | run 2: ignored args entirely; run 3: single-key object `{"matchId": "..."}` |
| Template `{{@trigger:Blockchain Event.args.matchId}}` | `{{@nodeId:trigger-1.event}}` (literal `nodeId:` text inserted) |

The pattern is consistent: the generator treats the context as a vague hint and substitutes its priors. For any workflow that needs a specific contract ABI, specific chain, or specific function signature — i.e., basically any real-world web3 workflow — the AI generator's output is unsafe to deploy without total reauthoring. We ended up hand-writing the `nodes`/`edges` arrays and calling `create_workflow` directly; that worked on the first try.

**Suggestion:** either (a) honour explicit context constraints (treat `MUST be exactly: <literal>` clauses as hard constraints), or (b) document the generator as "for shape sketches only, not for production workflows" so users don't burn cycles fighting it.

### `tools_documentation` template grammar is under-specified

The docs string explains `{{@nodeId:Label.field}}` for cross-node references, plus `{{@__system:System.unixTimestamp}}` for builtins. Nothing in `tools_documentation` covers:

- How to access trigger event args (we guessed `args.matchId` based on the inline ABI's input names — this may or may not be correct; we were unable to test because the workflow is disabled).
- How to access HTTP response body fields (we guessed `response.body.valid`).
- What operators are valid in `Condition.condition` (we guessed `===` from JS-like syntax).
- The exact shape of `functionArgs` for web3/write-contract (we guessed JSON-array-of-strings based on AI generator output, which itself was unreliable).

The AI generator's confusion may be downstream of these documentation gaps — if even the official generator can't produce consistent template syntax, the human-facing docs probably don't pin it down either.

**Suggestion:** ship a short "template reference" page with one example per common access pattern: trigger event arg, HTTP response field, on-chain read result, Condition operator list, web3 function-args-array.

### Schema gaps for keeper-style workflows

The original [keeperhub/match-settle.yaml](../keeperhub/match-settle.yaml) was a 7-step settlement flow modeled on the keeper conventions (drand round per turn, forfeit clock, off-chain ECDSA signature, mid-flow webhook wait). Mapping it onto KeeperHub's schema turned up structural misses:

| YAML step | KeeperHub gap |
|---|---|
| `trigger.filter.count: 2 group_by: matchId` | No multi-event aggregation. Event trigger fires per event; no indexed-arg filter, no "fire when N events with the same indexed value have arrived" primitive. |
| `http-poll` (drand-per-turn, forfeit-poll) | No polling action with `interval_seconds` + `stop_condition`. `Schedule` (cron) trigger could fake it with a separate workflow per loop, but loses the in-workflow stop condition. |
| `webhook` as a mid-flow step (waiting for `/match/{id}/end`) | Webhooks are **triggers only**, never mid-flow waits. The "long-running workflow that pauses for an external event" pattern has no equivalent. |
| `ecdsa-sign` of an arbitrary keeper payload | No off-chain signing primitive. Para MPC can sign on-chain transactions emitted by `web3/write-contract`, but cannot produce an EIP-191 / EIP-712 / raw-payload signature for downstream relay. |
| `{{ secret.X }}` templating | No secret template syntax. Credentials only via `integrations` (Discord, Sendgrid, wallet). Generic key-value secrets (an API key for our gnubg replay service, the relayer URL) have no place to live. |

Effectively, KeeperHub's primitive set is "trigger → HTTP/web3 actions → done" — a fanout workflow over a single event. Long-lived, multi-event, signature-producing keeper workflows need to be redesigned as multiple independent workflows + external orchestration, which is exactly the orchestrator we built in `server/app/keeper_workflow.py`. The on-platform workflow ends up doing only the final on-chain write.

**Suggestion:** if KeeperHub wants to host the *whole* keeper, the priorities are (in this order) (1) a `Wait Webhook` action node so a workflow can pause mid-flow for an external signal; (2) a `Sign Message` action that emits an EIP-191/EIP-712 signature usable by downstream HTTP/web3 nodes; (3) a per-workflow secret store with `{{ secret.X }}` template access; (4) multi-event aggregation triggers (`fire when N events with matching indexed-arg X have arrived`).

### `recordMatch` is `onlyOwner` — KeeperHub's wallet can't be the caller

`MatchRegistry.recordMatch` (`contracts/src/MatchRegistry.sol:121-128`) is gated by `onlyOwner` → the deployer EOA `0xa2219C4f48bC9e6806Bce3B391aB9e23f55FEbb5`. The KeeperHub wallet integration is Para MPC, which won't be the deployer. So the workflow we just registered (id `7f9dqwtohidj6lc89tuht`, disabled) would revert at execution time even if everything else were correct.

This is a chaingammon-side issue, not a KeeperHub one — the contract was designed for a single-keeper-server deploy model, not a hosted-orchestrator model. Working around it would require either deploying a new MatchRegistry that grants Para MPC a settler role (similar to how `MatchEscrow.settler` is set to MatchRegistry), or wrapping `recordMatch` behind a signature-verifying setter that anyone can call as long as they present a deployer signature. We didn't pursue either — the disabled workflow lives as a design artifact.

**Suggestion** (for the chaingammon side): add a `settler` role to MatchRegistry analogous to MatchEscrow's existing `settler`. The KeeperHub wallet then becomes the settler, and the deployer retains override rights via `onlyOwner` admin functions but isn't on the hot path.

### What worked

After the AI dead-ends, the path that succeeded on the first attempt:

1. Read `list_action_schemas` once (it dumps all triggers, actions, and chains in a single 9k-line response — too big for a model context, but greppable on disk).
2. Mirror the structural conventions the AI generator emits (the wrapping `data: {label, type, config, status}` shape; `position: {x, y}` for visual layout; edge `{id, source, target, type: "default"}`).
3. Hand-write the `nodes` and `edges` arrays with the literal field values you actually want.
4. Call `create_workflow` with `enabled: false` to land a non-firing draft.

The workflow round-tripped intact (every field preserved; `visibility: "private"`, `enabled: false`, `workflowType: "read"` defaulted automatically). This is the path we'd recommend to anyone hitting the same generator regressions.

**Suggestion:** publish a "workflow as code" reference doc with two or three complete `nodes`/`edges` examples (one per common shape: pure HTTP fanout; event-trigger → web3 write; cron → multi-step). The AI generator's output is too unreliable to serve as a learn-by-example.
