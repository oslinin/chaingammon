# Network dropdown in navbar — design

**Date:** 2026-04-28
**Topic:** Add a network selector dropdown to the top navbar.

## Goal

The top navbar should always (when a wallet is connected) display the active network name and let the user switch between supported chains without leaving the page. Replaces the current one-shot "Switch to X" amber nudge in `ConnectButton`.

## Scope

- Selectable chains in the dropdown:
  - **0G Galileo Testnet** (chainId 16602) — always shown.
  - **Sepolia** (chainId 11155111) — always shown.
  - **Hardhat Localhost** (chainId 31337) — shown only in dev (`process.env.NODE_ENV !== "production"`).
- The dropdown is baked into `ConnectButton`. To get it on the match page, `ConnectButton` is added to the match page header (right slot).

## Non-goals

- No persistence of the user's last-selected chain — wagmi/MetaMask already remember.
- No chain icons/logos in v1 — text labels only.
- No new chain configuration UI — `frontend/app/chains.ts` remains the single source of truth (per Frontend Policy 1).
- No changes to `web_readme.html` — this is not a numbered phase.

## Architecture

### 1. `frontend/app/chains.ts` — add `useSelectableChains()`

A new hook that returns the list of chains the user can pick from in the dropdown. Filters `CHAIN_REGISTRY`:

- Always includes 0G Galileo Testnet (16602) and Sepolia (11155111).
- Includes Hardhat Localhost (31337) only when `process.env.NODE_ENV !== "production"`.

Order: 0G Galileo Testnet first (matches `FALLBACK_CHAIN_ID`), then Sepolia, then Localhost (when present). Implementation reads `CHAIN_REGISTRY` so adding a new chain to the registry surfaces it automatically (subject to the env filter, which only applies to localhost).

Returns `ChainEntry[]`. Hook form (rather than module-level constant) so future versions can read additional state (e.g. user preferences) without breaking call sites.

### 2. `frontend/app/NetworkDropdown.tsx` — new client component

Renders a compact dropdown trigger that shows the current network name and opens a menu listing selectable chains. Built with plain HTML — no new dropdown library.

**Trigger button:**
- On a registered chain → shows `${chain.name} ▾` in normal text colors.
- On an unregistered chain (no entry in `CHAIN_REGISTRY`) → shows `Wrong network ▾` styled in amber (`bg-amber-500/text-white`, matching the previous nudge color).
- During `useSwitchChain` `isPending` → shows `Switching… ▾` and is disabled.

**Menu:**
- One row per `ChainEntry` from `useSelectableChains()`.
- Active chain row is marked (e.g. `font-semibold` with a leading checkmark `✓`).
- Clicking a row calls `switchChain({ chainId: entry.chain.id })` and closes the menu.
- Closes on outside click and on `Escape`.

**Errors:**
- If `useSwitchChain` returns an error (user rejected, network not added, etc.), render a small `text-xs text-red-600` line below the trigger, mirroring the existing `connectError` pattern in `ConnectButton`.

**Disconnected behavior:**
- Component returns `null` when `useAccount().isConnected` is false. The dropdown is wallet-driven; no wallet → no dropdown. (Confirmed in brainstorming.)

### 3. `frontend/app/ConnectButton.tsx` — replace the "Switch to X" nudge

- Remove the `onWrongChain` / `targetChain` block and the amber switch button.
- Remove the now-unused `useSwitchChain` import and `SUPPORTED_CHAIN_IDS` set.
- Render `<NetworkDropdown />` to the left of `<ProfileBadge address={address} />` when connected.

The "wrong chain" affordance moves into `NetworkDropdown` (amber trigger label + open menu). Behavior is preserved end-to-end: a user on mainnet sees a colored signal and can switch with one click.

### 4. `frontend/app/match/page.tsx` — add `<ConnectButton>` to header

The right slot of the match page header currently renders the score (`{game.score[0]} – {game.score[1]}`). Layout change:

- Keep left slot (back link) and existing center span (`Agent #N · M-pt match`).
- Move the score to sit immediately after the center span (or fold into the center span). Render `<ConnectButton />` in the right slot.

The exact arrangement is a small layout call to make during implementation; the constraint is "score still readable; ConnectButton/network dropdown reachable on the match page."

## Data flow

```
useChainId() ──► NetworkDropdown trigger label
                       │
                       ├── menu opens
                       │       │
                       │       ▼
                       │   useSelectableChains() ──► menu rows
                       │       │
                       │       ▼
                       │   onClick row ─► switchChain({ chainId })
                       │                       │
                       │                       ▼
                       │                  wallet prompts user
                       │                       │
                       │                       ▼
                       │                  wallet emits chainChanged
                       │                       │
                       └────────────── useChainId() updates ◄──┘
```

No new state lives in the dropdown beyond `isOpen`. Source of truth for the active chain stays with the wallet (via wagmi).

**Wallet-originated switches are equivalent:** because the trigger label reads from `useChainId()` and wagmi listens to the wallet's `chainChanged` event, switching networks directly inside MetaMask updates the navbar identically to clicking a row in the dropdown. The dropdown is one of two equally-valid UIs over the same wagmi state — there is no Chaingammon-side cache that could fall out of sync.

## Testing

Per Frontend Policy 2, a new Playwright spec `frontend/tests/network-dropdown.spec.ts`:

1. **Trigger label visible after connect** — using the existing wagmi mock pattern (or a fixture page mirroring `frontend/app/test-dice/page.tsx` if a stub wallet is needed), connect and assert the trigger shows the active chain's `name`.
2. **Menu lists expected chains** — open the menu and assert the visible option labels match the chains expected for the test environment.
   - In `pnpm test:e2e` (dev mode): expect 0G Galileo Testnet, Sepolia, Hardhat Localhost.
   - Optional: a separate spec built against `pnpm build` output to confirm Localhost is hidden — only if cheap to wire.
3. **Active chain marked** — current chain row has the active marker (checkmark / bold).
4. **Switch click invokes wagmi** — clicking a non-active row calls `switchChain` (asserted via the mock connector's recorded calls, or via a UI-visible side effect such as the trigger label updating).
5. **Disconnected: dropdown not rendered** — when `isConnected` is false, the dropdown root is absent from the DOM.
6. **Wrong-chain label** — when the connected chain is not in `CHAIN_REGISTRY` (mock with mainnet 1), trigger shows `Wrong network ▾` and amber styling.

If `frontend/tests/` doesn't already have a wagmi-mock pattern, the simpler fallback is a fixture page (`frontend/app/test-network-dropdown/page.tsx`) that wraps `<NetworkDropdown>` in a small mock provider. Either path is acceptable; pick whichever matches existing test idioms during implementation.

## Files touched

| File | Change |
| --- | --- |
| `frontend/app/chains.ts` | Add `useSelectableChains()` hook. |
| `frontend/app/NetworkDropdown.tsx` | New client component. |
| `frontend/app/ConnectButton.tsx` | Remove "Switch to X" block; render `<NetworkDropdown />`. |
| `frontend/app/match/page.tsx` | Add `<ConnectButton />` to header right slot; keep score visible. |
| `frontend/tests/network-dropdown.spec.ts` | New Playwright spec. |

## Risks / open questions

- **Mock-wallet pattern in Playwright** — confirm during implementation whether `frontend/tests/` already has a wagmi mock connector setup. If not, the fixture-page approach is the lower-risk fallback and matches `dice-size.spec.ts`.
- **`useSwitchChain` failure modes on Sepolia** — some wallets refuse to switch to chains they haven't been "added" with `wallet_addEthereumChain` first. wagmi handles the call but the user may see a wallet-side prompt; this is acceptable v1 behavior.
- **Match-page header layout** — adding `ConnectButton` to a 3-element header may need a small flex tweak. Decide during implementation; not a design-level concern.
