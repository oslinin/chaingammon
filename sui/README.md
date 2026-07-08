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

**Task 0 (scaffold) complete and CI-verified.** `.github/workflows/sui-ci.yml` passed on `sui` branch commit `5a9ab8b` (2026-07-08): the `sui` CLI installs, `sui move build` and `sui move test` both succeed against the placeholder package. There is no app yet (`sui/app` — added in Task 4), no deployed contracts, and no working game — Task 1 (`elo.move`) is next.

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

Expected (once the toolchain is installed): the `chaingammon::version_tests::package_version_is_one` test passes. This is a placeholder test proving the package skeleton compiles and Move tests run — Task 1 (`elo.move`) adds the first real test suite.

## Localnet (for later tasks — not needed yet)

```bash
RUST_LOG=off sui start --with-faucet --force-regenesis
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
