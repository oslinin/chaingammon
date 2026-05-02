# KeeperHub workflow specification

The match-settlement workflow that KeeperHub orchestrates for every
Chaingammon match. This file is the canonical spec; the README's
"How It Works" section and the per-turn mermaid sequence diagram both
condense from this.

## Workflow shape

KeeperHub workflows are step graphs: each step has retry policy, gas
budget, and an audit-trail entry. The Chaingammon workflow is two
phases — a per-turn loop and a one-shot settlement at game end.

```
match_open
  ├─ verify_deposits       (read-only; both deposits in MatchEscrow)
  └─ initialize_audit_log  (Log entry on 0G Storage; per-turn appends below)

per_turn_loop  (repeats until game_over):
  ├─ pull_drand_round      (HTTP GET https://api.drand.sh/<chain>/public/<R>)
  ├─ derive_dice           (keccak256(round_digest || turn_index_be8) mod 36)
  ├─ request_move          (0G Compute call OR session-key signed move)
  ├─ validate_move         (WASM rules-engine; reject + halt on illegal)
  ├─ append_to_audit_log   (per-turn 0G Storage Log entry)
  └─ check_terminal        (loop exit condition)

match_settle:
  ├─ build_game_record     (canonical JSON, sorted keys, deterministic)
  ├─ upload_game_record    (0G Storage Log → Merkle rootHash)
  ├─ submit_settlement     (Sepolia: MatchRegistry.settleWithSessionKeys)
  ├─ payout_winner         (Sepolia: MatchEscrow.payoutWinner)
  ├─ update_ens_records    (PlayerSubnameRegistrar.setTextBatch)
  └─ append_audit_summary  (final summary JSON to 0G Storage Log)
```

## Per-step contracts

| Step | Inputs | Outputs | Gas | Retry |
| --- | --- | --- | --- | --- |
| `verify_deposits` | `matchId, escrowAddr` | `bool both_deposited` | 0 (read) | 3× exponential, then halt |
| `pull_drand_round` | `round_number` | `digest_hex` | 0 (HTTP) | 5× exponential, then halt |
| `derive_dice` | `digest_hex, turn_index` | `(d1, d2)` | 0 (compute) | none — pure function |
| `request_move` | `position_id, dice, agent_iNFT_id` | `move, signature` | 0 (HTTP / TEE) | 3× exponential, then forfeit-by-timeout |
| `validate_move` | `position_id, dice, move` | `next_position_id, terminal_flag` | 0 (WASM) | none — deterministic; failure means cheat |
| `append_to_audit_log` | `move_record` | `log_entry_hash` | gas for 0G Log put | 3× exponential |
| `build_game_record` | `match_history` | `game_record_json` | 0 | none |
| `upload_game_record` | `game_record_json` | `rootHash, txHash` | gas for 0G Log put | 3× exponential |
| `submit_settlement` | `humanAuthSig, resultSig, agentId, gameRecordHash` | `tx_hash` | ~150k Sepolia gas | 3× linear (high gas-spike risk) |
| `payout_winner` | `matchId, winnerAddr` | `tx_hash` | ~70k Sepolia gas | 3× linear |
| `update_ens_records` | `subname, {elo, match_count, last_match_id, archive_uri}` | `tx_hash` | ~120k Sepolia gas | 3× linear |
| `append_audit_summary` | `workflow_run_id, final_state` | `log_entry_hash` | gas for 0G Log put | 3× exponential |

## Failure modes & recovery

The workflow is designed to fail safely at every step:

- **`pull_drand_round` failure** (network outage): retry policy exhausts,
  workflow halts, both stakes refundable via `MatchEscrow.refund` after
  a timeout window.
- **`validate_move` rejects an illegal move**: the move is from a buggy
  or malicious agent; halt the workflow, refund both deposits. The
  on-chain settlement was never reached, so no ELO change.
- **`request_move` timeout**: the side-on-roll is offline. Forfeit the
  match to the opponent (apply a forfeit ELO delta, settle as normal).
  Configurable timeout per match — default 5 minutes per turn.
- **`submit_settlement` reverts**: the contract verified the signatures
  failed. Almost always means a bug in session-key signing on the
  client. Halt + audit; do not retry without diagnosing.
- **`payout_winner` reverts after `submit_settlement` succeeds**:
  shouldn't happen in normal operation (escrow has the funds, settler
  is authorised, winner is one of the depositors). If it does, the
  workflow can be replayed against the existing settlement record —
  `MatchRegistry` is the source of truth, `MatchEscrow` is just paying
  out.

## Why drand and not commit-reveal

drand rounds are publicly attested by the League of Entropy and
timestamped, so per-turn dice cannot be predicted before the round is
published, denied or forged after, and can be re-derived by anyone
replaying the match. Commit-reveal works as a fallback for matches
where one side is offline / out-of-band, but drand is the cleaner
primary path: zero coordination overhead, one HTTP fetch per turn.

The mapping is `dice = keccak256(round_digest || turn_index_be8) mod 36`,
unpacked into `(d1, d2)` in `[1, 6]`. See `agent/drand_dice.py` for the
reference Python implementation; the WASM rules engine on the validator
side computes it identically.

## Why every step is auditable

Every step writes to either the 0G Storage Log (per-turn audit, signed
settlement record, final summary) or to Sepolia via a contract call
(`settleWithSessionKeys`, `payoutWinner`, `setTextBatch`). The full
match — every move, every drand round, every signature — is
reconstructible from the on-chain record + the 0G Storage entries it
points to. There is no off-chain state KeeperHub keeps that the user
has to trust.

For the in-flight workflow run, `kh run status --json <runId>` returns
the per-step status and any retry counts. The frontend's
`/match/[matchId]` page mirrors that output for the user.

## Out of scope

- **Cube doubling** — not modeled in v1. The workflow assumes simple
  win/loss settlement; `cube_actions` field of `GameRecord` is empty.
- **Series matches** (best-of-N) — implemented as N independent
  workflow invocations sharing a `seriesId` envelope; the wrapper is
  out of scope for v1.
- **Two-of-two multisig payout / draw splits** — out of scope.
  `MatchEscrow.payoutWinner` is single-recipient; ties are
  artificially broken by remaining pip count or whatever the
  rules engine decides.
- **Tournament bracketing** — orchestrated as an outer workflow that
  invokes this one per match; out of scope for v1.

## Reference implementations

- `agent/drand_dice.py` — dice derivation
- `agent/og_storage_upload.py` / `og_storage_download.py` — Log writes / reads via og-bridge
- `contracts/src/MatchRegistry.sol` — `settleWithSessionKeys` (signature verification + ELO update)
- `contracts/src/MatchEscrow.sol` — `payoutWinner` (settler-only release of pot)
- `contracts/src/PlayerSubnameRegistrar.sol` — `setTextBatch` (ENS text-record write)
