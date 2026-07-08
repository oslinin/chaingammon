# Sui port — design

**Date:** 2026-07-07 (decisions recorded 2026-07-08)
**Topic:** A Sui-native variant of Chaingammon (Move settlement + Walrus/Seal weights + zkLogin onboarding + native randomness), developed on a long-lived `sui` branch, targeted at the Sui Overflow 2026 "Agentic Web" track.

**Owner decisions (2026-07-08):**
1. **Project shape:** self-contained `sui/` workspace (Move packages + its own small Next.js app with *copied* libs) on a long-lived `sui` branch. **No ChainAdapter, no shared-code refactor of the existing frontend** — the EVM app is not touched. Duplication is accepted for the spike.
2. **Stakes:** SUI only in v1 (`Balance<SUI>` in the Match object).
3. **Onboarding:** Enoki-hosted zkLogin + sponsored transactions.
4. **Adjudication:** spec-only in v1 (§7 stays a design section; happy-path co-sign + timeouts ship).
5. **Agent identity:** fresh Sui agent population — no passporting from EVM agents.

**Implementation plan:** `docs/superpowers/plans/2026-07-08-sui-port.md`.

## Goal

Stand up a working Sui-native Chaingammon: humans and AI agents play rated backgammon where dice come from Sui native randomness, agent weights live encrypted on Walrus behind Seal ownership policies, agents are tradeable Sui objects with their own bankroll, and players onboard with zkLogin (Google/Apple) + sponsored transactions — no wallet install, no gas UX.

The port must **reuse the chain-agnostic 90%** of the codebase unchanged: the TypeScript rules engine, ONNX inference (browser + workers), the Python training stack, the Nostr/WebRTC matchmaking layer, and the Next.js UI. Only the settlement/identity/storage layer forks.

**Strategic rationale (from the July 2026 audit):** the three hardest open problems in the EVM version map to first-class Sui primitives — dice grinding → native randomness; trustless weight transfer (deferred ERC-7857 work) → Seal + Kiosk; wallet-first onboarding funnel → zkLogin + sponsored transactions. The port is therefore not a lateral re-implementation: it deletes problems.

## Scope

- New top-level `sui/` workspace directory: Move packages, deploy scripts, TS helpers.
- A `ChainAdapter` seam in the frontend so EVM and Sui implementations coexist behind one interface.
- Unrated + rated (SUI-staked) human-vs-human and human-vs-agent play settling on Sui testnet.
- Agent mint/trade with Seal-gated weights on Walrus.
- Overflow 2026 submission package (deployed testnet app, demo video, one-pager).

## Non-goals

- **No migration.** The EVM deployment (Sepolia + 0G + ENS + KeeperHub) remains the primary line; the `sui` branch does not touch it beyond the adapter seam.
- No feature parity on day one: tournaments, team play, coach LLM, and the training UI stay EVM/main-branch-only until the spike proves out.
- No Move re-implementation of the full rules engine (adjudication uses a Nautilus enclave instead — §7).
- No USDC-on-Sui stakes in v1 (SUI coin only; token choice is an open question, §11).
- No SuiNS integration in v1 (display names come from profile objects; SuiNS later).

## Architecture

### 1. Component mapping

| EVM component | Sui replacement | Notes |
|---|---|---|
| `MatchRegistry.sol` (ELO, settlement, nonces, session keys) | `chaingammon::match` Move package | Shared `Match` objects; session keys become ephemeral ed25519 keys whose pubkeys are registered in the Match object at open |
| `MatchEscrow(.Usdc).sol` | `Balance<SUI>` held inside the `Match` object | No separate escrow contract: Sui objects hold funds natively |
| `AgentRegistry.sol` (ERC-721, ERC-7857-shaped) | `chaingammon::agent` Move package — `Agent` owned object | Weights blob id + hash + style overlay + ELO + bankroll live *on the object*; dynamic fields for future extension |
| `AgentVault.sol` (per-agent bankroll) | `Balance<SUI>` field on `Agent` | Deposit/withdraw = owner-gated entry functions |
| ENS subnames + text records | Profile objects now; SuiNS later | `HumanProfile` shared-object registry keyed by address |
| drand dice (client-fetched, grindable) | `sui::random` per-turn for rated play; commit-reveal for unrated | §5 |
| 0G Storage (match archive, weights, style) | **Walrus** blobs | Same content-addressed model; blob ids recorded on-chain |
| 0G Storage encrypted weights + operator key | **Seal** — decryption policy = current agent owner | The trustless-transfer story the EVM version defers |
| 0G Compute TEE (coach, offline eval) | **Nautilus** enclaves | v1 uses it only for adjudication (§7); coach stays off |
| KeeperHub workflows (settle, audit) | Move entry functions + Nautilus adjudication + a thin cron worker | Weakest mapping; Sui has no keeper network — accepted |
| Privy + wagmi/viem | **zkLogin** (Enoki) + `@mysten/dapp-kit` + sponsored transactions | Guests get a real address from game one |
| Nostr + WebRTC matchmaking | **Unchanged** | Chain-agnostic by design |
| Rules engine, ONNX eval, trainers | **Unchanged** | The value of the port: these carry over |

### 2. Move package layout

```
sui/
  move/chaingammon/
    Move.toml
    sources/
      agent.move      — Agent object, mint, bankroll, weights/overlay hashes, seal policies
      profile.move    — HumanProfile registry (display name, ELO, style blob id)
      match.move      — Match lifecycle: open → join → play → settle | adjudicate
      elo.move        — pure ELO math (port of EloMath.sol; unit-tested against its vectors)
    tests/            — Move unit tests (sui move test)
  scripts/            — TS deploy + demo scripts (@mysten/sui)
  README.md           — install, localnet, deploy, test — kept current every phase
```

### 3. `Agent` object

```move
public struct Agent has key, store {
    id: UID,
    name: String,
    tier: u8,
    weights_blob: BlobRef,        // Walrus blob id + content hash
    overlay_blob: Option<BlobRef>,// style overlay (public)
    elo: u64,                     // starts 1500
    match_count: u32,
    experience_version: u32,
    bankroll: Balance<SUI>,
}
```

- `store` ability → tradable via **Kiosk** with a `TransferPolicy` (v1 policy: no rules; royalty rule optional later).
- **Seal policy**: the package exposes the `seal_approve`-pattern entry function that aborts unless the transaction sender currently owns the `Agent` (or holds the `KioskOwnerCap` of the kiosk containing it). Effect: buy the agent → you can decrypt its weights; seller loses access. This replaces the entire deferred ERC-7857 re-encryption design. Exact function signatures follow the Seal SDK docs at implementation time (`https://seal-docs.wal.app` / Mysten Seal repo) — do not invent them from this spec.
- Bankroll: `deposit(agent, coin)` (anyone may sponsor an agent), `withdraw(agent, amount)` owner-only, `stake_into_match(...)` owner-or-operator.
- ELO/match_count are updated only by `match::settle*` functions (the packages share a friend/witness relationship).

### 4. `Match` lifecycle

Shared object; state machine `OPEN → PLAYING → SETTLED | ADJUDICATING → SETTLED`.

- `open(stake, session_pubkey, opponent_hint)` — creator locks stake, registers their ephemeral ed25519 session pubkey.
- `join(match, stake, session_pubkey)` — opponent locks matching stake. Match id doubles as the Nostr/WebRTC match id (discovery unchanged).
- Play happens **off-chain** exactly as today (WebRTC, client rules engine, per-move session-key signatures — the signed move log from hardening-plan Task 13 is a prerequisite and carries over).
- `settle_cosigned(match, result, sig_a, sig_b)` — happy path: one transaction from either player (or a sponsor) carrying both session-key signatures over the canonical result bytes; Move verifies both ed25519 sigs against the registered pubkeys, pays out stakes, updates ELO on both profiles/agents.
- `flag_for_adjudication(match, move_log_blob)` — griefing path, §7.
- Timeouts: `reclaim(match)` after N epochs when nobody joined; `abandon(match)` splits stakes when neither settlement nor adjudication evidence arrives within M epochs.

### 5. Dice

Two modes, chosen at match open:

- **Unrated (free) play — commit-reveal, zero chain traffic.** Per turn: both clients exchange `H(secret_i)` then reveal; dice = `keccak(secret_a ‖ secret_b ‖ turn_index) mod 36`. Trustless between two parties, instant, free. Replaces drand entirely for casual play (also removes the drand HTTP dependency).
- **Rated/staked play — Sui native randomness.** Per turn, the side to move submits a sponsored PTB calling `match::roll(match, &random.Random)`; dice derive on-chain and are emitted as an event both clients read. Unpredictable (no pre-derivable seed — knowing future dice would change correct play), ungrindable (chain generates, client cannot choose), and cheap/fast enough on Sui (sub-second finality, sponsored gas). The per-turn tx also timestamps the game on-chain — free anti-stall evidence for adjudication.

The turn-index monotonicity check from hardening-plan Task 3 applies to both modes.

### 6. Onboarding

- zkLogin via **Enoki**: Google/Apple sign-in produces a real Sui address; sponsored transactions (Enoki gas pool) make rated play gasless for players.
- The guest-play decision (owner, 2026-07-07) is *subsumed* on Sui: "guest" = zkLogin user with zero SUI, playing unrated commit-reveal matches — same UX, real address, upgradeable to rated without re-onboarding.
- Wallet-extension users are also supported via `@mysten/dapp-kit` connect.

### 7. Adjudication (griefing fallback) — Nautilus

When the loser refuses to co-sign: winner uploads the signed move log to Walrus and calls `flag_for_adjudication(match, blob_ref)`. A **Nautilus** enclave (registered in the package as the trusted adjudicator measurement) fetches the log, verifies every per-move session signature, replays the game through the *same TypeScript rules engine* compiled for the enclave runtime, and submits `settle_adjudicated(match, verdict, attestation)`; Move verifies the enclave attestation against the registered measurement. This is the Sui analogue of the KeeperHub adjudication decision (owner, 2026-07-07) and doubles as the stack showcase (Walrus × Seal × Nautilus) Overflow judges are primed for. **v1 scope:** design + enclave PoC; shipping it is a stretch goal (S6).

### 8. Standalone app — `sui/app` (decided: no ChainAdapter)

Per the 2026-07-08 decision, the Sui variant is a **fully separate Next.js app** at `sui/app/` with zero imports from `frontend/`. Chain-agnostic modules it needs (rules engine, match engine, Nostr matchmaking, WebRTC, board UI, ONNX eval) are **copied** into `sui/app/lib/` and `sui/app/components/`, trimmed of EVM imports. Chain calls use `@mysten/sui` + `@mysten/dapp-kit` + Enoki directly — no abstraction layer.

Consequences accepted: (a) bug fixes to copied modules must be ported by hand between the two apps (record the copy manifest and source commit in `sui/README.md`); (b) the existing frontend and its test suites are never touched by the port; (c) merging later means merging a directory, not untangling a seam.

### 9. What the trainers need

Nothing chain-specific. One addition: `agent/og_storage_upload.py` gets a sibling `walrus_upload.py` (Walrus HTTP publisher API) selected by env, so `--upload-to-0g` grows a `--upload-to-walrus` twin. Seal encryption of checkpoints replaces `checkpoint_encryption.py`'s AES-GCM *for the Sui variant only* (the key ceases to be an operator secret and becomes a Seal policy).

### 10. Branch & CI strategy (updated per 2026-07-08 decisions)

- **Long-lived `sui` branch created directly from master** — no master-side prerequisite, since the port only *adds* the `sui/` directory (plus one workspace-list line and one CI file). Rebase onto master periodically; conflicts are near-impossible by construction.
- CI: a separate `.github/workflows/sui-ci.yml` (so it never conflicts with the hardening-plan `ci.yml`) running `sui move test`, the Move build, and the `sui/app` typecheck + Playwright specs, on pushes to the `sui` branch.
- Merge-back criterion: if the Overflow entry earns a grant/finalist slot or real users, the `sui/` directory merges to master as-is (it's additive); if not, the branch is archived with a retro note.

## Phased roadmap (each phase = shippable, README updated, no commits without owner approval)

| Phase | Deliverable | Verify |
|---|---|---|
| **S0** | `sui/` scaffold on the new `sui` branch: Move package skeleton, localnet script, `sui/README.md` (install `sui` CLI, run localnet, `sui move test` green on an empty package), CI job | `sui move test`; README walkthrough from clean machine |
| **S1** | ~~ChainAdapter~~ **Dropped** per 2026-07-08 decision — the app is standalone (§8); S4 copies libs instead | — |
| **S2** | `agent.move` + `elo.move`: mint, bankroll, Kiosk listing; ELO math ported with EVM test vectors | Move unit tests incl. EloMath vector parity |
| **S3** | Walrus + Seal weights: trainer `--upload-to-walrus`, mint script wiring blob refs, demo script proving owner-can-decrypt / non-owner-cannot / buyer-can-after-Kiosk-purchase | scripted e2e on testnet, output pasted in PR |
| **S4** | `match.move` full lifecycle + commit-reveal dice; `sui.ts` adapter; zkLogin login; unrated HvH settling on localnet | new Playwright spec (mock Enoki, localnet), Move tests for settle/timeout/reclaim |
| **S5** | Rated play: staked matches + per-turn native randomness via sponsored PTBs | Move tests + testnet match walkthrough |
| **S6** *(stretch)* | Nautilus adjudication PoC per §7 | enclave replay of a fixture log → on-chain verdict on testnet |
| **S7** | Overflow submission: testnet deploy, demo video, one-pager, agent leaderboard filtered to Sui agents | submission checklist below |

**Overflow submission checklist (S7):** deployed testnet URL · 3-min video (zkLogin sign-in → unrated game → mint agent → agent plays rated staked match → trade agent in Kiosk, buyer decrypts weights) · one-pager (problem, stack usage: Walrus/Seal/randomness/zkLogin/Nautilus, traction) · public repo pointer to the `sui` branch · team/contact.

## Open questions — RESOLVED 2026-07-08 (see decisions block at top)

1. **Stake coin:** SUI only in v1. (Legal posture from the audit applies on Sui too: advertise free play only.)
2. **Enoki dependence:** accepted for the spike; self-hosting revisited only if terms become a problem.
3. **Agent identity continuity:** fresh Sui population, no passporting.
4. **Adjudication ops:** cut from v1 — spec-only (§7); no enclave/cron to host yet.

## Risks

- **Move learning curve** — mitigated by keeping contracts small (three packages, no rules engine on-chain) and leaning on Move unit tests.
- **Seal/Nautilus API drift** — both are young; the spec deliberately defers exact signatures to implementation-time docs.
- **Two-stack maintenance** — capped by the adapter seam, weekly rebases, and an explicit merge-or-archive decision at S7.
- **Per-turn tx latency in rated play** — Sui finality is sub-second, but the UX must show the roll instantly (optimistic UI on the event stream); fall back to commit-reveal if testnet latency disappoints (open the match in "unrated dice" mode with stakes — degraded but functional).
