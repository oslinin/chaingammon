# Network Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a network selector dropdown to the top navbar so users can see the active chain name and switch between Sepolia, 0G Galileo Testnet, and (in dev) Hardhat Localhost without leaving the page.

**Architecture:** Split the dropdown into a presentational component (`NetworkDropdownView`) and a wagmi-aware wrapper (`NetworkDropdown`). The view is rendered on a fixture page for Playwright visual coverage; the wrapper feeds it data from `useChainId` / `useSwitchChain`. The chain list comes from a new `useSelectableChains()` hook in `frontend/app/chains.ts`. The dropdown replaces the existing "Switch to X" amber nudge inside `ConnectButton`, and `ConnectButton` is added to the match page header so the dropdown is reachable mid-match.

**Tech Stack:** Next.js 16 (webpack only — see `frontend/AGENTS.md`), React 19, wagmi v3, viem v2, TypeScript, Tailwind, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-28-network-dropdown-design.md`

**Project rules to obey:**
1. **No commits without owner approval.** This plan does NOT include `git commit` steps. The final task is "show owner the diff + draft commit message and stop." (Per `feedback_git_policy` memory.)
2. **Use `pnpm`, never `npm`/`npx`.** All command examples use pnpm.
3. **Webpack only.** Don't run `next dev` or `next build` without `--webpack`. Use the existing `pnpm` scripts.
4. **Frontend Policy 2 — Playwright is the visual-regression gate.** Every change to `frontend/app/**` must run `pnpm --filter frontend test:e2e` green before "done."
5. **Frontend Policy 1 — chain registry is the single source of truth.** Don't hardcode chain IDs or addresses outside `frontend/app/chains.ts`.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `frontend/app/chains.ts` | Modify | Add `useSelectableChains()` hook returning the user-facing chain list (filters Localhost out of production builds). |
| `frontend/app/NetworkDropdownView.tsx` | Create | Pure presentational component. Renders trigger + menu given props (`activeChainId`, `selectableChains`, `isPending`, `error`, `onSwitch`). No wagmi imports. |
| `frontend/app/NetworkDropdown.tsx` | Create | Wagmi-aware wrapper. Reads `useAccount` / `useChainId` / `useSwitchChain` and `useSelectableChains`, returns `null` when disconnected, otherwise renders `<NetworkDropdownView>`. |
| `frontend/app/test-network-dropdown/page.tsx` | Create | Fixture page rendering `<NetworkDropdownView>` in three controlled variants for Playwright (active=0G, wrong-chain=mainnet, switching=true). |
| `frontend/app/ConnectButton.tsx` | Modify | Remove the `useSwitchChain` import, the `SUPPORTED_CHAIN_IDS` set, and the "Switch to X" amber button. Render `<NetworkDropdown />` to the left of `<ProfileBadge>`. |
| `frontend/app/match/page.tsx` | Modify | Add `<ConnectButton />` to the header right slot; keep score visible. |
| `frontend/tests/network-dropdown.spec.ts` | Create | Playwright spec — drives the fixture page (variant rendering, menu open/close, click → `onSwitch`) and the home page (dropdown absent when disconnected). |

---

## Task 1: Add `useSelectableChains()` hook to `chains.ts`

**Files:**
- Modify: `frontend/app/chains.ts` (append at end)

- [ ] **Step 1: Add the hook**

Open `frontend/app/chains.ts`. Append after the existing `useActiveChainId` function (currently the last export):

```typescript
// Chain IDs the user can pick from in the network dropdown.
// Order matters — this is the order they render in the menu.
//   - 0G Galileo Testnet (16602) — primary chain, listed first.
//   - Sepolia (11155111) — secondary, listed second.
//   - Hardhat Localhost (31337) — dev only, listed last.
const SELECTABLE_CHAIN_IDS_PROD = [16602, 11155111] as const;
const SELECTABLE_CHAIN_IDS_DEV = [16602, 11155111, 31337] as const;

/**
 * The chains the user can pick from in the network dropdown.
 *
 * Always includes the primary chains (0G Galileo Testnet, Sepolia).
 * Includes Hardhat Localhost only when `process.env.NODE_ENV !== "production"`,
 * so the demo build does not surface a chain that won't reach a node.
 *
 * Each entry is the same `ChainEntry` shape served from `CHAIN_REGISTRY`,
 * so a chain absent from the registry (e.g. its deployment JSON is missing)
 * is silently skipped.
 */
export function useSelectableChains(): ChainEntry[] {
  const ids =
    process.env.NODE_ENV === "production"
      ? SELECTABLE_CHAIN_IDS_PROD
      : SELECTABLE_CHAIN_IDS_DEV;
  return ids
    .map((id) => CHAIN_REGISTRY[id])
    .filter((entry): entry is ChainEntry => entry !== undefined);
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: no errors. (If the project doesn't have a standalone tsc check, run `pnpm --filter frontend build` instead — slower but covers the same ground.)

---

## Task 2: Write failing Playwright spec for the dropdown

**Files:**
- Create: `frontend/tests/network-dropdown.spec.ts`

- [ ] **Step 1: Write the spec file**

Create `frontend/tests/network-dropdown.spec.ts` with these contents:

```typescript
// Network dropdown — visual + interaction regression coverage.
//
// Strategy:
//   - The presentational `NetworkDropdownView` is exercised on a fixture
//     page (`/test-network-dropdown`) that renders three controlled
//     variants. No wallet, no wagmi state — pure props.
//   - The wagmi-aware `NetworkDropdown` is exercised by visiting the
//     home page disconnected and asserting the trigger does NOT render.
//     A connected-state e2e would require a wallet stub (Synpress / mock
//     connector); the existing test fixtures don't have one. The view's
//     fixture-page coverage stands in for the rendering side, and the
//     real e2e proves the wrapper renders nothing when disconnected.
//
// Fixture variants (selected via ?variant= query param):
//   ?variant=active     → on 0G Galileo Testnet (chainId 16602)
//   ?variant=wrong      → on mainnet (chainId 1, NOT in registry)
//   ?variant=switching  → switching pending

import { test, expect } from "@playwright/test";

test.describe("NetworkDropdownView (fixture page)", () => {
  test("active variant: shows current chain name and lists selectable chains", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("0G Galileo Testnet");

    // Open the menu.
    await trigger.click();
    const menu = page.getByTestId("network-dropdown-menu");
    await expect(menu).toBeVisible();

    // Three rows in dev mode (0G, Sepolia, Localhost).
    const rows = menu.getByRole("menuitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("0G Galileo Testnet");
    await expect(rows.nth(1)).toContainText("Sepolia");
    await expect(rows.nth(2)).toContainText("Hardhat Localhost");

    // Active row marked.
    await expect(rows.nth(0)).toHaveAttribute("data-active", "true");
    await expect(rows.nth(1)).toHaveAttribute("data-active", "false");
  });

  test("wrong variant: shows 'Wrong network' label", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=wrong");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Wrong network");
  });

  test("switching variant: shows pending state and disables trigger", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=switching");
    await page.waitForLoadState("networkidle");

    const trigger = page.getByTestId("network-dropdown-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Switching");
    await expect(trigger).toBeDisabled();
  });

  test("clicking a non-active row records onSwitch with the right chain id", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("network-dropdown-trigger").click();
    await page.getByRole("menuitem", { name: /Sepolia/ }).click();

    // The fixture page renders the last-clicked chain id into a
    // <pre data-testid="last-switch">…</pre> for the test to read.
    await expect(page.getByTestId("last-switch")).toHaveText("11155111");
  });

  test("Escape closes the menu", async ({ page }) => {
    await page.goto("/test-network-dropdown?variant=active");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("network-dropdown-trigger").click();
    await expect(page.getByTestId("network-dropdown-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("network-dropdown-menu")).toHaveCount(0);
  });
});

test.describe("NetworkDropdown (wagmi-aware wrapper)", () => {
  test("home page: dropdown is not rendered when disconnected", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The Connect button is visible (no wallet → "Install MetaMask"
    // or "Connect wallet" depending on injection state). The dropdown
    // is gated on isConnected so it must not appear.
    await expect(page.getByTestId("network-dropdown-trigger")).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the spec to confirm it fails**

Run: `pnpm --filter frontend test:e2e network-dropdown`
Expected: tests fail because `/test-network-dropdown` returns 404 and `network-dropdown-trigger` doesn't exist anywhere. Specifically the `goto` calls return 404 and `toBeVisible()` times out.

---

## Task 3: Create `NetworkDropdownView` (presentational)

**Files:**
- Create: `frontend/app/NetworkDropdownView.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/app/NetworkDropdownView.tsx`:

```typescript
"use client";

// Presentational component for the network dropdown.
//
// Pure props — no wagmi, no `useSwitchChain`. The wagmi-aware wrapper
// (`NetworkDropdown`) feeds it derived state. This split makes the
// rendering testable on a fixture page without standing up a mock
// wallet, and keeps the dropdown's UI logic free of side effects.
//
// `data-testid` attributes are stable selectors for Playwright. Don't
// rename without updating `frontend/tests/network-dropdown.spec.ts`.

import { useEffect, useRef, useState } from "react";

import type { ChainEntry } from "./chains";

interface Props {
  /** Active chain id from `useChainId()`. May be a chain not in
   *  `selectableChains` (e.g. mainnet); in that case the trigger
   *  shows "Wrong network". */
  activeChainId: number;
  /** Chains the user can pick from — usually `useSelectableChains()`. */
  selectableChains: ChainEntry[];
  /** True while a `switchChain` call is in flight. Disables the trigger. */
  isPending?: boolean;
  /** Optional error from the last `switchChain` attempt. */
  error?: string | null;
  /** Called when the user clicks a row. The wrapper translates this
   *  into a wagmi `switchChain({ chainId })` call. */
  onSwitch: (chainId: number) => void;
}

export function NetworkDropdownView({
  activeChainId,
  selectableChains,
  isPending = false,
  error = null,
  onSwitch,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const activeEntry = selectableChains.find(
    (c) => c.chain.id === activeChainId,
  );
  const onWrongChain = !activeEntry;

  // Trigger label.
  let triggerLabel: string;
  if (isPending) {
    triggerLabel = "Switching…";
  } else if (onWrongChain) {
    triggerLabel = "Wrong network";
  } else {
    triggerLabel = activeEntry.chain.name;
  }

  // Trigger color: amber when wrong chain (matches the previous nudge),
  // neutral otherwise.
  const triggerClass = [
    "inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-medium",
    "border",
    onWrongChain
      ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-600"
      : "border-zinc-300 text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900",
    "disabled:opacity-60",
  ].join(" ");

  return (
    <div ref={rootRef} className="relative flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="network-dropdown-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isPending}
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
      >
        {triggerLabel}
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <ul
          data-testid="network-dropdown-menu"
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[12rem] overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
        >
          {selectableChains.map((entry) => {
            const isActive = entry.chain.id === activeChainId;
            return (
              <li key={entry.chain.id}>
                <button
                  type="button"
                  role="menuitem"
                  data-active={isActive ? "true" : "false"}
                  onClick={() => {
                    onSwitch(entry.chain.id);
                    setOpen(false);
                  }}
                  className={[
                    "flex w-full items-center gap-2 px-3 py-2 text-left",
                    "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                    isActive
                      ? "font-semibold text-zinc-900 dark:text-zinc-50"
                      : "text-zinc-700 dark:text-zinc-300",
                  ].join(" ")}
                >
                  <span aria-hidden className="w-3">
                    {isActive ? "✓" : ""}
                  </span>
                  {entry.chain.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: no errors.

---

## Task 4: Create the fixture page

**Files:**
- Create: `frontend/app/test-network-dropdown/page.tsx`

- [ ] **Step 1: Write the fixture page**

Create `frontend/app/test-network-dropdown/page.tsx`:

```typescript
"use client";

// Fixture page for `NetworkDropdownView` Playwright coverage.
//
// Renders the presentational dropdown with controlled props so the
// rendering can be exercised without standing up a mock wagmi config.
// Variants are selected with `?variant=…` — see the test spec for the
// supported values.
//
// This page is non-production. It must not be linked from the main UI
// and Vercel/CI builds may safely include or exclude it.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { useSelectableChains } from "../chains";
import { NetworkDropdownView } from "../NetworkDropdownView";

export default function TestNetworkDropdownPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const params = useSearchParams();
  const variant = params.get("variant") ?? "active";

  const selectableChains = useSelectableChains();
  const [lastSwitch, setLastSwitch] = useState<number | null>(null);

  // Variant → derived props.
  let activeChainId = 16602; // 0G Galileo Testnet
  let isPending = false;
  if (variant === "wrong") activeChainId = 1; // Mainnet, not in registry
  if (variant === "switching") isPending = true;

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 p-12 dark:bg-black">
      <h1 className="text-lg font-semibold">
        NetworkDropdownView fixture — variant={variant}
      </h1>
      <NetworkDropdownView
        activeChainId={activeChainId}
        selectableChains={selectableChains}
        isPending={isPending}
        onSwitch={(id) => setLastSwitch(id)}
      />
      <pre
        data-testid="last-switch"
        className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-900"
      >
        {lastSwitch === null ? "" : String(lastSwitch)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Run the spec — fixture variants should now pass**

Run: `pnpm --filter frontend test:e2e network-dropdown`
Expected:
- The five fixture-page tests pass.
- The wrapper test ("home page: dropdown is not rendered when disconnected") passes already because the dropdown component doesn't exist yet — the assertion is "no element with that testid", which is trivially true.

If a fixture-page test still fails, debug the fixture or view component before moving on.

---

## Task 5: Create the wagmi-aware `NetworkDropdown` wrapper

**Files:**
- Create: `frontend/app/NetworkDropdown.tsx`

- [ ] **Step 1: Write the wrapper**

Create `frontend/app/NetworkDropdown.tsx`:

```typescript
"use client";

// Wagmi-aware wrapper around `NetworkDropdownView`.
//
// Renders nothing when the wallet is disconnected — the dropdown's
// purpose is wallet-mediated chain switching, so without a wallet
// there's nothing to drive. When connected, it pulls the active chain
// from `useChainId()` (kept in sync with the wallet's `chainChanged`
// event by wagmi, so MetaMask-originated switches update the trigger
// label automatically) and feeds the view.

import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { useSelectableChains } from "./chains";
import { NetworkDropdownView } from "./NetworkDropdownView";

export function NetworkDropdown() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const selectableChains = useSelectableChains();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected) return null;

  return (
    <NetworkDropdownView
      activeChainId={chainId}
      selectableChains={selectableChains}
      isPending={isPending}
      error={error?.message ?? null}
      onSwitch={(id) => switchChain({ chainId: id })}
    />
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: no errors.

---

## Task 6: Update `ConnectButton` to use `NetworkDropdown`

**Files:**
- Modify: `frontend/app/ConnectButton.tsx`

- [ ] **Step 1: Read the current file**

Open `frontend/app/ConnectButton.tsx` and review the current connected-state branch (lines 26 onward — `const { switchChain, isPending: switchPending } = useSwitchChain();` through the end).

- [ ] **Step 2: Replace the file contents**

Replace the entire file with:

```typescript
"use client";

// Phase 12: connect / disconnect button + network dropdown.
//
// Three states:
//   1. No wallet detected (no injected connector)  → "Install MetaMask"
//   2. Wallet detected, not connected              → "Connect wallet"
//   3. Connected                                   → network dropdown
//      (replaces the old amber "Switch to X" nudge), profile badge,
//      disconnect button.

import { useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";

import { NetworkDropdown } from "./NetworkDropdown";
import { ProfileBadge } from "./ProfileBadge";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();

  const injectedConnector = connectors.find((c: Connector) => c.type === "injected");

  if (!isConnected) {
    if (!injectedConnector) {
      return (
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Install MetaMask
        </a>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => connect({ connector: injectedConnector })}
          disabled={connectPending}
          className="inline-flex h-10 items-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {connectPending ? "Connecting…" : "Connect wallet"}
        </button>
        {connectError ? (
          <span className="text-xs text-red-600 dark:text-red-400">
            {connectError.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <NetworkDropdown />
      {address ? <ProfileBadge address={address} /> : null}
      <button
        type="button"
        onClick={() => disconnect()}
        className="inline-flex h-9 items-center rounded-full border border-zinc-300 px-3 text-xs font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
      >
        Disconnect
      </button>
    </div>
  );
}
```

What changed from the original:
- Removed `useChainId`, `useSwitchChain` imports.
- Removed the `CHAIN_REGISTRY` import (no longer needed here — the dropdown owns chain logic).
- Removed the `SUPPORTED_CHAIN_IDS` set and the `onWrongChain` / `targetChain` block with the amber switch button.
- Added `<NetworkDropdown />` in the connected-state row.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: no errors.

---

## Task 7: Add `<ConnectButton>` to the match page header

**Files:**
- Modify: `frontend/app/match/page.tsx` (header block, lines 247-260)

- [ ] **Step 1: Update the imports**

In `frontend/app/match/page.tsx`, find the imports (top of file, after the file header comment). Add `ConnectButton`:

```typescript
import { Board } from "../Board";
import { ConnectButton } from "../ConnectButton";
import { DiceRoll } from "../DiceRoll";
```

- [ ] **Step 2: Restructure the header**

Find the existing header block (around lines 247-260):

```tsx
{/* Header */}
<header className="flex items-center justify-between border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
  <Link
    href="/"
    className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
  >
    ← Agents
  </Link>
  <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
    Agent #{agentId} · {game.match_length}-pt match
  </span>
  <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
    {game.score[0]} – {game.score[1]}
  </span>
</header>
```

Replace it with:

```tsx
{/* Header — back link, match meta + score, connect/network controls. */}
<header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-8 py-4 dark:border-zinc-800">
  <Link
    href="/"
    className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
  >
    ← Agents
  </Link>
  <div className="flex flex-1 items-center justify-center gap-4">
    <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
      Agent #{agentId} · {game.match_length}-pt match
    </span>
    <span className="font-mono text-sm text-zinc-900 dark:text-zinc-50">
      {game.score[0]} – {game.score[1]}
    </span>
  </div>
  <ConnectButton />
</header>
```

What changed: the score moved from its own right slot into the center group with the agent meta, and `<ConnectButton />` now occupies the right slot.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter frontend exec tsc --noEmit`
Expected: no errors.

---

## Task 8: Run the full Playwright suite

**Files:** none

- [ ] **Step 1: Run the new spec on its own**

Run: `pnpm --filter frontend test:e2e network-dropdown`
Expected: all 6 tests pass (5 fixture variants + 1 disconnected home page).

- [ ] **Step 2: Run the full suite**

Run: `pnpm --filter frontend test:e2e`
Expected: all tests pass — including the existing `dice-size.spec.ts` and `match-flow-methods.spec.ts`.

If `match-flow-methods` regresses, the most likely cause is the match page header restructure in Task 7. Re-read that task carefully. The regression test only routes API calls; it doesn't assert on the header DOM, so layout changes alone shouldn't break it. If it does fail, check whether `ConnectButton` is mounting and triggering wagmi network requests that the test doesn't expect.

---

## Task 9: Run the production build to confirm Localhost is hidden

**Files:** none

- [ ] **Step 1: Build**

Run: `pnpm --filter frontend build`
Expected: build succeeds. The build command pins `--webpack` per Frontend Policy 3, so don't add or remove flags.

- [ ] **Step 2: Smoke-check the dev variant still works**

Run: `pnpm --filter frontend dev` (in another terminal) then visit `http://localhost:3000/test-network-dropdown?variant=active` in a browser.
Expected: three rows in the dropdown (0G, Sepolia, Localhost). Stop the dev server when done.

(There is no automated production-mode dropdown test — the spec lives in dev mode. If you want to lock down the production filter, add a separate Playwright project that runs `next start` against the build output. This is out of scope for v1.)

---

## Task 10: Show the owner the diff and a draft commit message

**Files:** none — this is a stop-and-wait checkpoint.

Per the project's git policy (`feedback_git_policy` memory and `CONTEXT.md` § "Git Policy"):

> The flow at the end of every phase is **always**:
> 1. Show the owner a summary of changed files and a draft commit message
> 2. Paste the commit message verbatim into `log.md` as the new phase entry
> 3. **Stop and wait.**
> 4. Only when the owner explicitly says "commit", run the commit.

This change is **not a numbered phase**, so the `log.md` step is skipped. Still:

- [ ] **Step 1: Show the diff summary**

Run: `git status` and `git diff --stat`
Print the output to the user.

- [ ] **Step 2: Draft a commit message**

Show the user this draft commit message (copy verbatim — do not run `git commit`):

```
frontend: network dropdown in navbar (Sepolia / 0G / Localhost in dev)

Replaces the one-shot "Switch to X" amber nudge inside ConnectButton with
a persistent network dropdown that displays the active chain's name and
lets the user switch chains directly. The dropdown also appears in the
match page header so it is reachable mid-match. Wallet-originated
switches (e.g. the user clicking a network in MetaMask) propagate to the
trigger label through wagmi's existing `chainChanged` listener — the
dropdown is one of two equally-valid UIs over the same wagmi state.

Selectable chains:
- 0G Galileo Testnet (chainId 16602) — always shown
- Sepolia (chainId 11155111) — always shown
- Hardhat Localhost (chainId 31337) — shown only when NODE_ENV !== "production"

NetworkDropdownView (frontend/app/NetworkDropdownView.tsx, new):
- Pure presentational component. Props: activeChainId, selectableChains,
  isPending, error, onSwitch. No wagmi imports.
- Trigger shows chain.name on a registered chain, "Wrong network" (amber)
  on an unregistered chain, "Switching…" while a switch is pending.
- Menu rows carry data-active="true|false" for the current selection;
  active row also gets a leading checkmark and bold weight.
- Closes on outside click and Escape.

NetworkDropdown (frontend/app/NetworkDropdown.tsx, new):
- Wagmi-aware wrapper. Reads useAccount / useChainId / useSwitchChain
  and useSelectableChains, passes derived props to NetworkDropdownView.
- Returns null when the wallet is disconnected — the dropdown is wallet-
  mediated, so without a wallet there is nothing to drive.

useSelectableChains hook (frontend/app/chains.ts, updated):
- Returns the user-facing chain list filtered against CHAIN_REGISTRY.
- Always includes 0G Galileo Testnet and Sepolia. Includes Hardhat
  Localhost only when NODE_ENV !== "production".

ConnectButton (frontend/app/ConnectButton.tsx, updated):
- Removed useSwitchChain import, SUPPORTED_CHAIN_IDS set, and the amber
  "Switch to X" button. Renders <NetworkDropdown /> in the connected
  state instead.

Match page header (frontend/app/match/page.tsx, updated):
- Added <ConnectButton /> to the right slot. Score moves into the center
  group with the "Agent #N · M-pt match" meta line.

Test-only fixture page (frontend/app/test-network-dropdown/page.tsx, new):
- Renders <NetworkDropdownView> in three controlled variants
  (?variant=active|wrong|switching) so Playwright can exercise the
  presentational UI without a mock wallet.

Tests (frontend/tests/):
- network-dropdown.spec.ts (new, 6 tests):
  - active variant: trigger label + menu rows + active marker
  - wrong variant: "Wrong network" trigger label
  - switching variant: trigger disabled + "Switching…" label
  - clicking a non-active row records the chosen chainId via onSwitch
  - Escape closes the menu
  - home page disconnected: dropdown is not rendered

All frontend Playwright tests pass.
```

- [ ] **Step 3: Stop**

Do NOT run `git commit`. Wait for the owner to approve. When they say "commit" (or equivalent), run:

```bash
git add frontend/app/chains.ts \
        frontend/app/NetworkDropdownView.tsx \
        frontend/app/NetworkDropdown.tsx \
        frontend/app/test-network-dropdown/page.tsx \
        frontend/app/ConnectButton.tsx \
        frontend/app/match/page.tsx \
        frontend/tests/network-dropdown.spec.ts \
        docs/superpowers/specs/2026-04-28-network-dropdown-design.md \
        docs/superpowers/plans/2026-04-28-network-dropdown.md
git commit -m "$(cat <<'EOF'
[paste the message above]
EOF
)"
```

---

## Self-review notes (recorded by plan author)

- **Spec coverage:** every section of the spec maps to a task — `useSelectableChains` (Task 1), `NetworkDropdownView` (Task 3), `NetworkDropdown` wrapper (Task 5), `ConnectButton` integration (Task 6), match page header (Task 7), Playwright spec (Tasks 2/4/8). The "wallet-originated switches are equivalent" guarantee from the spec is realized by the wrapper reading `useChainId()` directly — no extra task needed.
- **Type consistency:** `NetworkDropdownView`'s prop names (`activeChainId`, `selectableChains`, `onSwitch`) are used identically in Task 3 (definition), Task 4 (fixture page), and Task 5 (wagmi wrapper).
- **Placeholder check:** every code step contains the actual code. Commands are exact. No "TODO" or "implement later".
- **Skipped:** unit tests for the hook — the project doesn't have a frontend unit-test runner; the hook is exercised transitively through the dropdown's Playwright spec.
- **Skipped:** a production-mode Playwright project to verify Localhost is hidden — flagged as v1 out-of-scope in the spec; manual smoke check is in Task 9 Step 2.
