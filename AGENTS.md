# AGENTS.md

This file guides automated agents (Codex, Claude Code, CI bots) working in this repo. For deep architecture detail read `CONTEXT.md`. For product vision read `MISSION.md`.

## What this project is

Chaingammon is an open protocol for portable backgammon reputation. Players and AI agents hold ENS subnames (`<name>.chaingammon.eth`) whose text records store ELO and archive links. AI agents are ERC-7857 iNFTs with encrypted gnubg weights on 0G Storage. Match settlement runs as a KeeperHub workflow on Sepolia.

## Repository layout

| Directory | What lives there |
| --- | --- |
| `agent/` | Python 3.12 (uv) — BackgammonNet trainer, coach service, ONNX export |
| `contracts/` | Solidity 0.8.24 (Hardhat 2) — ELO, registry, ENS registrar |
| `frontend/` | Next.js 16 (webpack only) — game UI, matchmaking, profile, replay |
| `server/` | Python FastAPI — 0G Storage bridge, KeeperHub trigger |
| `docs/` | ADRs, agent skill docs, design notes |
| `scripts/` | One-time ops (upload gnubg docs to 0G, tunnel setup) |

## Build and test commands

Run from the repo root:

```bash
pnpm test                  # all tests (agent + contracts + frontend)
pnpm agent:test            # pytest suite only
pnpm contracts:test        # Hardhat suite only
pnpm frontend:test         # Next.js build check only
pnpm frontend:dev          # Next.js dev server (webpack)
```

Or from within a sub-project:

```bash
# agent/
uv run pytest

# contracts/
pnpm exec hardhat test
pnpm exec hardhat test test/<file>.test.js   # single file

# frontend/
pnpm test:e2e              # Playwright suite — required before any frontend commit
pnpm lint
```

## Git policy — stop before committing

1. Show a summary of changed files and a draft commit message.
2. **Stop and wait.** Do not run `git commit` or `git push` without explicit owner approval.
3. Approval is per-commit. A prior "yes" does not carry forward.

## TDD — tests first

1. Write tests describing the done-state criteria before any implementation.
2. Run them — they must fail (red).
3. Implement the minimum code to make them pass (green).
4. Update `README.md` with any changed commands.

Test locations: `agent/tests/`, `contracts/test/`, `frontend/tests/` (Playwright). Never delete or weaken existing tests.

## Frontend rules (non-negotiable)

See `frontend/AGENTS.md` for the full rules. Short version:

- **No hardcoded chains or addresses.** Use `frontend/app/chains.ts` and `useChainContracts()`.
- **Run `pnpm test:e2e`** before committing any change under `frontend/app/`.
- **`--webpack` flag is mandatory.** Never run `next dev` or `next build` without it; do not use Turbopack.

## Issue tracker

Issues live in GitHub Issues. Use the `gh` CLI:

```bash
gh issue list --state open
gh issue view <number> --comments
gh issue create --title "..." --body "..."
gh issue edit <number> --add-label "ready-for-agent"
```

Labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Domain vocabulary

Use the terms from `CONTEXT.md`. If your output contradicts an ADR in `docs/adr/`, surface the conflict explicitly rather than silently overriding it.

## Out of scope — do not implement without asking

Commit-reveal dice / VRF, betting / prediction markets, ELO derivative tokens, anti-cheat for human ratings, ZK move proofs, mainnet deployment.
