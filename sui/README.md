# Chaingammon on Sui

A self-contained, Sui-native variant of Chaingammon: Move packages for agent
objects, matches, and ELO; a standalone Next.js app with its own copy of the
chain-agnostic game core (rules engine, matchmaking, board UI); zkLogin
onboarding; SUI-staked rated play with on-chain dice; and Seal-gated agent
weights on Walrus.

- **Design spec:** [`docs/superpowers/specs/2026-07-07-sui-port-design.md`](../docs/superpowers/specs/2026-07-07-sui-port-design.md)
- **Implementation plan:** [`docs/superpowers/plans/2026-07-08-sui-port.md`](../docs/superpowers/plans/2026-07-08-sui-port.md)
- **Branch:** `sui` (long-lived; rebased onto `master` periodically). This directory does not exist on `master`.
- **Relationship to the main app (`frontend/`):** intentionally separate. No shared code, no shared contracts. See "Copied modules" below for what was ported by hand from `frontend/` and when.

This README is kept current after every task in the implementation plan — it should always be enough to install, build, and test whatever has landed so far from a clean machine.

## Status

**Tasks 0-2 complete, CI-verified.** `.github/workflows/sui-ci.yml` is green on `sui` branch commit `db15749`: 28/28 Move unit tests pass. Task 1 added `chaingammon::elo` (exact-parity Move port of `contracts/src/EloMath.sol`'s rating math). Task 2 adds `chaingammon::agent` — the tradable, bankrolled Agent object (mint, deposit/withdraw, weights pointer, match-settlement hook, Kiosk-ready via a published `TransferPolicy<Agent>`), replacing `AgentRegistry.sol` + `AgentVault.sol`. CI caught one real bug on first compile (`withdraw` needed a mutable `TxContext` for `coin::from_balance`) — fixed and re-verified green; see git history for details. There is no app yet (`sui/app` — added in Task 4), no deployed contracts, and no working game — Task 3 (`match.move`) is next.

⚠️ **CLI examples below are unverified.** Unlike `sui move build`/`sui move test` (proven by CI), the "Using the Agent module" commands were written against `sui client call` documentation conventions but never actually run — this sandbox has no local `sui` CLI and CI doesn't spin up a localnet or execute CLI commands, only `sui move test`. Treat them as a starting point, not a guarantee; verify against a real localnet before relying on them.

This local checkout could not run `sui move build`/`sui move test` directly (this sandbox's egress policy blocks `github.com`, and no `sui` CLI crate exists on crates.io as a fallback) — verification happened via CI on GitHub's runners instead, which have normal network access. If you're picking this up in an environment with `github.com` access, installing the CLI locally (below) and running the tests directly is faster than round-tripping through CI.

## Prerequisites

- [`sui` CLI](https://docs.sui.io/guides/developer/getting-started/sui-install), **testnet** release channel.

  ```
  Verified sui CLI version: testnet-v1.75.1 (verified via CI on 2026-07-08; also pinned in .github/workflows/sui-ci.yml's SUI_RELEASE_TAG)
  ```

  If you install a newer `testnet-*` release locally and it also passes `sui move test`, update both this line and `SUI_RELEASE_TAG` in `.github/workflows/sui-ci.yml`.
- [`pnpm`](https://pnpm.io/) (already required by the rest of this monorepo) — this directory's `app` and `scripts` packages are part of the root pnpm workspace (see root `pnpm-workspace.yaml`).
- Node.js 22 (matches the rest of the repo).

## Install & build

```bash
# From the repo root, on the `sui` branch:
git checkout sui

# Move package
cd sui/move/chaingammon
sui move build
```

## Test

```bash
cd sui/move/chaingammon
sui move test
```

Expected: `Test result: OK. Total tests: 28; passed: 28; failed: 0` — `chaingammon::version_tests::package_version_is_one` (1, Task 0 placeholder), `chaingammon::elo_tests` (20, Task 1, exact parity with `contracts/src/EloMath.sol`), `chaingammon::agent_tests` (7, Task 2: mint field defaults, deposit/withdraw round-trip, insufficient-balance abort, non-owner-cannot-withdraw/set_weights via `test_scenario`'s two-address pattern, weights recording, elo/match_count bump on `record_result`). (Earlier revisions of this file undercounted the elo/agent suites by one each — corrected here against the actual `#[test]` count and CI's own total.)

## Localnet

```bash
RUST_LOG=off sui start --with-faucet --force-regenesis
```

Needed from Task 4 onward for the app; not required just to build/test the Move package above.

### Using the Agent module (unverified — see warning above)

Publish the package (once, per network — this also runs `agent.move`'s `init`, which claims a `Publisher` and shares a `TransferPolicy<Agent>` needed for Kiosk trading in Task 8):

```bash
sui client publish --gas-budget 100000000
# Note the package ID from the output — used as <PKG> below.
```

Mint an agent (transfers it to your active address):

```bash
sui client call --package <PKG> --module agent --function mint \
  --args "gnubg-classic" 1 \
  --gas-budget 10000000
```

Deposit into its bankroll (needs a `Coin<SUI>` object id — `sui client gas` lists yours, or split one with `sui client split-coin`):

```bash
sui client call --package <PKG> --module agent --function deposit \
  --args <AGENT_OBJECT_ID> <COIN_OBJECT_ID> \
  --gas-budget 10000000
```

Withdraw (owner-only; sends the withdrawn `Coin<SUI>` to your own address):

```bash
sui client call --package <PKG> --module agent --function withdraw_to_sender \
  --args <AGENT_OBJECT_ID> 1000 \
  --gas-budget 10000000
```

## Copied modules

Files ported by hand from `frontend/` into `sui/app/` (Task 4 onward), with the `master` commit they were copied at. Bug fixes to the originals must be re-applied here manually — there is no shared-code mechanism between the two apps by design (owner decision, 2026-07-08: standalone app, no `ChainAdapter`).

| File | Copied from (`frontend/`) | Source commit |
|---|---|---|
| _(none yet — populated starting Task 4)_ | | |

## Deployed addresses

_(none yet — populated starting Task 9, testnet deploy)_

| Network | Package ID | Notes |
|---|---|---|
| — | — | — |

## CI

`.github/workflows/sui-ci.yml` runs on every push/PR to the `sui` branch: installs the `sui` CLI and runs `sui move build` + `sui move test`. Kept separate from the main repo's `ci.yml` so Sui-branch work never conflicts with `master` CI. An `app` job is added once `sui/app` exists (Task 4).

## Project layout (grows with each task)

```
sui/
  move/chaingammon/   — Move package (elo, agent, match modules — Tasks 1-3)
  app/                — standalone Next.js app (Task 4+)
  scripts/            — TS deploy/demo scripts (Task 3+)
  submission/         — Overflow 2026 submission assets (Task 9)
```
