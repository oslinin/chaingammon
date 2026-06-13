# Parametric Options Marketplace — Audited Hackathon Plan (ETHGlobal 2026)

> **Status:** Audited. The core architecture is sound and well-targeted at the
> 1inch Aqua/SwapVM prize, but it needs fixes before it qualifies for the
> Uniswap prize and is over-scoped for a hackathon. Read the **Audit Verdict**
> and **Must-Fix Findings** first, then the **Revised 15-Commit Plan**.

---

## Audit Verdict

**Thesis (keep it):** Use **1inch Aqua + SwapVM** as the primary/underwriting
market and a fully-collateralized vault, so LP capital stays self-custodied in
the LP's wallet until a buyer triggers a Just-In-Time fill. This is exactly what
Aqua is for — "each wallet becomes its own self-custodial liquidity pool" — and
options are a named example in the bounty. Targeting SwapVM is correct: projects
that use SwapVM are explicitly scored higher.

**Three things will sink this plan if not fixed:**

1. **The Uniswap path is valid but the specific "API key" sub-prize needs more.**
   Uniswap v4 **hooks qualify** — building with any part of the Uniswap stack
   (hooks, periphery, open-source) is an accepted way to submit for the rewards,
   so Phase 3's hook work is *not* wasted. The nuance: the **"Best Uniswap API
   Integration" ($7,000)** line specifically reads "Projects must integrate the
   Uniswap API with a valid API key," so to win *that exact* sub-prize you also
   need a real Trading-API integration (key + captured onchain transaction IDs).
   **Recommendation:** keep the v4 hook *and* add a thin Trading-API integration
   so you're eligible for both the hooks/stack track and the API sub-prize.
   (See Finding A.)
2. **Hedera (Commit 11) is off-target scope creep.** No Hedera prize is in
   scope, and the commit also mis-describes Hedera Consensus Service. Cut it.
   (See Finding C.)
3. **The plan is too big for a hackathon.** Custom SwapVM bytecode + Aqua vault
   + v4 hooks (with CREATE2 mining) + Hedera + a four-screen Next.js app is more
   than a weekend. Cut to the prize-critical path. (See Finding D.)

**Prize fit after fixes:**

| Prize | Amount | Fit | Notes |
|---|---|---|---|
| 1inch — Build an Aqua App | $5,000 (2.5k/1.5k/1k) | **Strong** | Options on Aqua+SwapVM; SwapVM scored higher |
| Uniswap — hooks / stack track | (per event) | **Valid** | v4 hook qualifies; building with the stack is accepted |
| Uniswap — Best Uniswap **API** Integration | $7,000 (4k/2k/1k) | **Add Trading API** | This sub-prize also needs a valid API key + onchain tx IDs |
| 1inch / Uniswap Continuity Track | $2,000 / $3,000 | Optional | Continuity-Track participants only — confirm eligibility |

---

## Hackathon Requirements (captured from the event page)

**1inch — "Build an Aqua App" ($5,000):**
- Build a custom Aqua app implementing a *sophisticated DeFi position*.
- If you use SwapVM you may modify SwapVM opcodes / define your own instructions.
- Final positions must be demonstrated through **tests, scripts, or UI**.
- **Projects that utilize SwapVM are scored higher.**
- Examples: leverage, AMM, lending, **options**.
- **Qualification:** onchain execution of token transfers shown during the demo
  (**local forks OK**); **proper git commit history — no single-commit entries
  on the final day**.

**Uniswap Foundation — "Best Uniswap API Integration" ($7,000):**
- Integrate the **Uniswap API** with a **valid API key** from the Uniswap
  Developer Platform for core functionality: trade execution, routing, payments,
  liquidity provision, or coordination between agents/systems.
- **Qualification:** **Transaction IDs** demonstrating real onchain execution
  (testnet and/or mainnet); a public GitHub repo with open-source code and a
  clear `README.md`; a **demo video (max 3 minutes)**; a completed Uniswap
  Developer Feedback Form.
- A separate **"Best Uniswap Stack Contribution" ($3,000)** is Continuity-Track
  only.

> The two prizes have **different verification bars**: 1inch accepts local forks;
> Uniswap wants real testnet/mainnet **transaction IDs**. Plan demos for both.

---

## Commit Hygiene (judge-facing — this is graded)

The 1inch qualification explicitly rejects "single-commit entries on the final
day," so the commit log is part of the score. Rules for this repo:

- **One logical change per commit.** A commit adds *one* contract, *one* test
  file, or *one* component — never "everything."
- **Short, imperative messages.** `add OptionToken ERC-20 with protocol-only mint`
  not `WIP` / `fixes` / `stuff`. No model names, no tooling chatter in messages.
- **Each commit builds and its tests pass.** Never commit red. A judge should be
  able to `git checkout` any commit and run `forge build`.
- **Spread commits across the event days**, not a final-day dump. Aim for the
  Phase order below; commit as each piece lands.
- **No giant lockfile/asset commits mixed with code.** Keep dependency bumps in
  their own commit.
- Target **~15 small commits**; if a step is too big for one clean commit, split
  it (e.g. "scaffold hook" then "wire beforeSwap").

---

## Must-Fix Findings

### Finding A — Uniswap: keep the hook, and add the Trading API for the API sub-prize
v4 **hooks qualify** for the Uniswap rewards — building with any part of the
stack (hooks, periphery, open-source) is an accepted submission path, so Phase 3
is legitimate prize work. The only catch is the **"Best Uniswap API Integration"
($7,000)** sub-prize, whose text requires integrating the **Uniswap API with a
valid API key** and showing **real onchain transaction IDs**.
**Fix:** keep the v4 hook for the hooks/stack track, *and* add a thin Trading-API
integration in the trade flow (quote → routing → swap, or the liquidity
endpoints) using a real Developer-Platform key, capturing the resulting tx IDs.
That makes you eligible for both the hooks track and the API sub-prize instead of
just one. (My earlier draft was wrong to call the hook "wasted" — it isn't.)

### Finding B — SwapVM is stateless; the "global volatility" loop is stateful  *(critical)*
Commit 3 correctly calls the SwapVM pricing script **stateless**, but Commit 8
stores and mutates `σ_global` across swaps. A stateless script cannot hold that
state. **Fix:** put any mutable demand/vol state in a **stateful contract**
(the Aqua vault or a small `VolState` contract / the v4 hook if you keep one),
and have the SwapVM script *read* it as an input parameter. Be explicit about
where each variable lives: spot/strike/expiry/side are call inputs; `σ_global`
is contract storage.

### Finding C — Drop Hedera (Commit 11)  *(critical for scope, not just polish)*
No Hedera prize is in scope. The commit also mischaracterizes Hedera Consensus
Service (HCS is consensus ordering/timestamps, not a keeper/cron; "scheduled
transactions" are a separate feature) and Hedera's EVM may not support all the
Cancun opcodes the rest of the plan relies on (TSTORE/TLOAD). **Fix:** remove
the Hedera commit entirely. If you need periodic "marking," do it with a simple
script/keeper or an onchain `poke()` anyone can call — no new dependency.

### Finding D — Cut to the prize-critical path  *(critical)*
Custom Yul bytecode + Aqua vault + v4 hooks (CREATE2 mining) + Hedera + four UI
screens will not finish cleanly. **Fix priorities:**
1. **Must-have (1inch $5k):** OptionToken → SwapVM pricing assembled from the
   instruction library → Aqua JIT collateral vault → a script/test that performs
   a real onchain token transfer (buy → mint → settle).
2. **Prize-relevant (Uniswap):** the v4 hook secondary market qualifies for the
   hooks/stack track; add a Trading-API integration with captured tx IDs to also
   reach the API sub-prize. Either path is a valid Uniswap submission — do the
   hook if that's your strength, the API if you want the $7k sub-prize, both if
   time allows.
3. **Nice-to-have:** dynamic-vol loop, LP dashboard. Build after the above.
4. **Always:** README + ≤3-min video + Uniswap feedback form.

### Finding E — Prefer assembling SwapVM instructions over hand-writing Yul
1inch's own framing is "assemble strategies from a **library of instructions**"
via routers (`SwapVMRouter`, `LimitSwapVMRouter`, `AquaSwapVMRouter`). Writing
raw Yul opcodes (original Commit 3) is high-risk for a hackathon. **Fix:** start
from `AquaSwapVMRouter` and the existing opcode set; only define a *custom*
opcode if the pricing genuinely needs one (and that custom opcode is itself a
strong "scored higher" story — keep it small and well-tested).

---

## Other Findings (worth addressing)

- **F. The pricing formula is missing.** Commit 4 references a "Parametric
  Volatility equation" but no equation is given. Full Black–Scholes onchain
  (exp/ln/normal-CDF) is expensive and imprecise in fixed point. **Fix:** specify
  a concrete, cheap **parametric approximation** (e.g. a piecewise/quadratic vol
  smile in `moneyness = K/S`, premium via a bounded closed-form) and state the
  fixed-point format (e.g. 1e18). Write the math in the README so judges can read
  it.
- **G. Settlement model is mixed.** Commit 10 cash-settles a call as `S − K`
  while collateral is locked as 1 ETH — that needs an oracle and conversion.
  **Fix:** pick one model and state it. Physical settlement (buyer pays K USDC,
  receives the 1 ETH) is simpler and cleaner to demo for a fully-collateralized
  call than cash `S − K`.
- **H. `beforeSwap` hard-revert is a blunt instrument.** Reverting whenever pool
  price deviates from "fair" can make the pool look broken in a live demo and
  blocks legitimate price discovery. **Fix:** use a wide tolerance band or a
  dynamic fee rather than an outright revert; if you keep a revert, demo it on a
  clearly toxic trade only.
- **I. "No market makers" vs. needing v4 LPs.** A tradeable v4 pool per option
  series still needs someone to seed liquidity, which is in tension with the
  "eliminate active market makers" pitch. **Fix:** be precise in the README —
  the *primary* market (Aqua JIT) needs no active MM; the *secondary* v4 market,
  if present, is optional peer liquidity.
- **J. CREATE2 hook-address mining (Phase 5)** is real but necessary work — v4
  requires the hook address to encode its permission flags, so keep the salt
  miner if you ship the hook.
- **K. `evm_version = "cancun"` (Commit 1) is correct** for v4 transient
  storage — keep it, and confirm your demo chain/fork supports TSTORE/TLOAD.
- **L. Don't forget the non-code deliverables.** The Uniswap prize needs a
  ≤3-min video and the feedback form; both prizes need a clean README. Schedule
  these as their own commits/tasks (see Commit 15).

---

## Revised 15-Commit Plan

Phases reordered so the two prize-critical paths (1inch vault, Uniswap API) land
before the optional v4 hook work. Hedera removed. Each bullet is one clean,
short commit.

### Phase 1 — Foundation
1. **Scaffold Foundry repo.** `foundry.toml` (`evm_version = "cancun"`),
   `remappings.txt`, `.gitignore`; install `@uniswap/v4-core`,
   `@uniswap/v4-periphery`, `@openzeppelin/contracts`. *Verify:* `forge build`
   is clean. *(Dependency install is its own commit.)*
2. **`OptionToken.sol` + test.** ERC-20 with immutable `underlying`,
   `strikePrice`, `expiry`, `isCall`; protocol-only `mint`/`burn`. *Verify:*
   only the vault can mint/burn; metadata reads back.

### Phase 2 — Underwriting (1inch Aqua + SwapVM)  ← prize-critical
3. **SwapVM pricing skeleton.** Start from `AquaSwapVMRouter` / the existing
   instruction set; define the entry path taking `S, K, T, side(BUY/SELL)`.
   *Verify:* interface compiles; mock call returns a number.
4. **Parametric pricing + asymmetric spread.** Implement a concrete cheap vol
   smile (document the formula + fixed-point format) and the ±2% BUY/SELL
   modifier. Read `σ_global` as an **input** (state lives elsewhere — Finding B).
   *Verify:* OTM/ITM scale vol; BUY/SELL return asymmetric bid/ask.
5. **`AquaCollateralVault.sol` — JIT fill.** Track LP virtual balances; on a
   buyer paying the exact SwapVM premium, lock 1 ETH (call) or K USDC (put) from
   the LP, route the premium to the LP, mint an OptionToken to the buyer.
   *Verify:* forge test of the full JIT mint with a **real token transfer**.

### Phase 3 — Uniswap Trading-API integration  ← unlocks the API sub-prize
6. **Trading-API client + key wiring.** Add a thin client (frontend or a small
   service) that calls the Uniswap Trading API for quotes/routing using a real
   API key from the Developer Platform. *Verify:* a live quote round-trips.
7. **Execute a real swap via the API.** Use the API to execute the
   premium-asset acquisition (or secondary sale) onchain and **capture the
   transaction ID**. *Verify:* tx hash recorded; visible on an explorer.

### Phase 4 — Lifecycle & settlement
8. **Expiration engine.** Lock the final settlement spot once
   `block.timestamp > expiry` via oracle. *Verify:* settlement blocked before T,
   frozen after T.
9. **Fully-collateralized payout.** OTM → release full collateral to LP; ITM →
   settle (pick physical per Finding G) and return remainder to LP. *Verify:*
   vault returns to zero-liability; capital distributes cleanly.

### Phase 5 — Secondary market (v4 hook)  ← qualifies for Uniswap hooks/stack track
10. **Scaffold `OptionPricingHook.sol`** (BaseHook, `beforeSwap`/`afterSwap`
    flags) + CREATE2 salt miner. *Verify:* hook attaches to a fresh pool.
11. **Dynamic-vol feedback in the hook.** Store/update `σ_global` here (the
    stateful home from Finding B); `afterSwap` nudges it by ±γ on buy/sell;
    `beforeSwap` uses a **tolerance band**, not a hard revert (Finding H).
    *Verify:* back-to-back swaps reprice; toxic trade is the only thing blocked.

### Phase 6 — Frontend & demo deliverables
12. **Next.js + wallet boilerplate.** Next.js, tailwind, wagmi, viem against the
    EVM RPC/fork. *Verify:* `npm run dev`, wallet connects.
13. **Option matrix UI.** Grid of strikes calling the SwapVM pricing read; shows
    a real bid/ask smile. *Verify:* options chain renders with smile tails.
14. **One-click trade orchestrator.** Approve premium asset → JIT route through
    Aqua/SwapVM → (uses the Uniswap API path from Phase 3 where relevant) →
    update UI on confirm. *Verify:* "Buy Call" mints a token to the wallet in one
    flow.
15. **LP dashboard + README + demo assets.** LP "Total Value Unlocked" view;
    `README.md` explaining the Aqua/SwapVM architecture and the math; record the
    **≤3-min demo video** and submit the **Uniswap feedback form**. *Verify:*
    full test suite green; both prize submissions complete.

---

## Pre-Submission Checklist
- [ ] 1inch: onchain token transfer demoed (local fork OK), SwapVM used.
- [ ] Uniswap: v4 hook submitted (hooks/stack track) and/or Trading API
      integrated with a real key + **tx IDs captured** (API sub-prize).
- [ ] Public repo, clean `README.md` with the pricing math.
- [ ] ≤3-min demo video recorded.
- [ ] Uniswap Developer Feedback Form submitted.
- [ ] Commit log: many small, building commits across days — no final-day dump.
- [ ] Hedera removed; scope trimmed to the must-haves.

---

### Sources
- [1inch launches Aqua (developers)](https://blog.1inch.com/aqua-developer-release/)
- [1inch/swap-vm (SwapVM routers & instruction set)](https://github.com/1inch/swap-vm)
- [Uniswap Trading API overview](https://docs.uniswap.org/api/trading/overview)
- [Uniswap Developer Platform is live](https://blog.uniswap.org/uniswap-developer-platform-is-live)
- [Uniswap developer docs](https://developers.uniswap.org/docs) — building with any part of the stack, including hooks, qualifies
