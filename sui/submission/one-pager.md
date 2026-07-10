# Chaingammon on Sui — one-pager (Overflow 2026, Agentic Web track)

**Status of this document:** drafted per Task 9 Step 3 of `docs/superpowers/plans/2026-07-08-sui-port.md`. The Move package and app are CI-verified on the `sui` branch (`.github/workflows/sui-ci.yml`, commit `19ee112` at the time of writing) but **not yet deployed to Sui testnet** — see "What's live vs. what's built" below and `sui/README.md`'s "Deployed addresses" section for exactly what's blocking that and what closes the gap. Placeholders below (`<TESTNET_URL>`, tx links) get filled in once deployed.

## Problem

Chaingammon's EVM version (Sepolia) proved the core loop — humans and AI agents share one ELO ledger, matches settle trustlessly, agent "brains" are on-chain assets — but hit three hard open problems the July 2026 audit flagged as structural, not implementation bugs:

1. **Dice grinding.** drand-derived dice are verifiable, but nothing stops a party from composing a transaction that only commits after seeing the roll and rerolling on a bad result, absent extra machinery.
2. **Trustless weight transfer.** An agent's trained model is its actual value. Selling the iNFT should mean the buyer — and only the buyer — can use the weights. ERC-7857's confidential-transfer story needs a centralized re-encryption oracle to actually enforce that; EVM Chaingammon deferred it.
3. **Wallet-first onboarding.** Every new player needs a wallet, gas, and a mental model of both before they can play a single game.

## What Sui deletes

Each problem maps to a first-class Sui primitive instead of an app-level workaround:

| Problem | Sui primitive | Where it lives here |
|---|---|---|
| Dice grinding | `sui::random`, PTB-level "no abort after seeing randomness" restriction | `chaingammon::game_match::roll` — `public(package) entry`, alternating roller by `turn_index` parity |
| Trustless weight transfer | Seal identity-based encryption + on-chain access policy, Kiosk for atomic trade | `chaingammon::agent::seal_approve` (gates decryption on current `Agent.owner`) + `claim_ownership` (syncs `owner` on a Kiosk purchase) |
| Wallet-first onboarding | zkLogin (Google/Apple) + sponsored transactions | `sui/app`'s `AUTH_MODE=mock\|enoki` switch (see "What's live" below) |

## What's live vs. what's built

Everything below is **CI-verified on the `sui` branch** (Move unit tests + Playwright E2E against a real local Sui network, in `.github/workflows/sui-ci.yml`) — but CI runs on an ephemeral localnet, not testnet, and this development environment's network egress policy blocks the live services (Seal key servers, Walrus publisher/aggregator, Sui testnet fullnode) needed to actually deploy and demo end-to-end. That is the honest state as of this document; see `sui/README.md`'s per-feature "unverified" callouts for exactly which pieces those are.

- **Unrated peer-to-peer play** — Nostr matchmaking, WebRTC transport, commit-reveal dice, zero chain dependency. Fully live in the app, CI-verified.
- **zkLogin onboarding** — implemented behind an `AUTH_MODE=mock|enoki` switch; ships in `mock` mode (a real Sui address generated client-side, no OAuth round-trip) because no Enoki API key / Google OAuth client id is configured anywhere this was built. The `enoki` code path is unwritten pending those keys — this is the one piece of the "wallet-first onboarding" story not yet wired to the real thing.
- **Native-randomness rated play** — real SUI stakes locked via `game_match::open`/`join`, dice from `sui::random` via `game_match::roll`, cosigned settlement updating both players' `HumanProfile` ELO. Full end-to-end E2E (`tests/rated_hvh.spec.ts`) plays a complete match with model moves on a real (local) Sui network and passes in CI.
- **Seal-gated, Walrus-stored agent weights** — the `seal_approve` on-chain policy is written, unit-tested, and CI-green. The upload/fetch/decrypt scripts (`mint_agent.ts`, `fetch_weights.ts`) are typechecked against the real `@mysten/seal`/`@mysten/sui` SDKs but have never reached a live Seal key server or Walrus publisher from this environment.
- **Kiosk trade** — `chaingammon::agent::claim_ownership` (the piece that makes a trade actually flip decrypt access) is written, unit-tested, and CI-green. `trade_agent.ts`'s on-chain mechanics (`kiosk::place_and_list` → `purchase` → `confirm_request` → `claim_ownership`) are typechecked against the framework's documented signatures but likewise unverified against a live network.

## Traction

None yet — pre-testnet-deployment. This is the honest baseline for a hackathon submission built end-to-end in one sandboxed environment: 50/50 Move unit tests green, 3 independent CI jobs green (`move`, `app`, `app-localnet`) on every push to the `sui` branch, and one full rated-match E2E (stakes, on-chain dice, cosigned settlement, ELO update) proven against a real (if ephemeral, local) Sui network.

## Team / contact

See the repository's contact information — `oslinin/chaingammon` on GitHub, `sui` branch.

## Links

- Repo: `sui` branch of `oslinin/chaingammon`
- Design spec: `docs/superpowers/specs/2026-07-07-sui-port-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-08-sui-port.md`
- README: `sui/README.md`
- Deployed testnet URL: `<TESTNET_URL>` (pending — see `sui/README.md`'s "Deployed addresses")
- Overflow registration: https://overflow.sui.io/
