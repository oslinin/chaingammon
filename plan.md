# Parametric Options Marketplace — Audited Hackathon Plan (ETHGlobal 2026)

> **Status:** Audited. The core architecture is sound: **1inch Aqua/SwapVM mints
> the option, and Uniswap v4 is the trading + price-discovery layer** traders see
> and interact with. Both are central and both target a bounty. The plan is
> over-scoped for a hackathon and a few technical points need fixing. Read the
> **Audit Verdict** and **Must-Fix Findings**, then the **Revised 15-Commit Plan**.

---

## Audit Verdict

**Thesis (keep it):** Two markets, two sponsors, both central:
- **1inch Aqua + SwapVM** underwrites and *mints* the option from a
  fully-collateralized vault — LP capital stays self-custodied in the LP's wallet
  until a buyer triggers a Just-In-Time fill. This is exactly what Aqua is for,
  options are a named example in the bounty, and using SwapVM is scored higher.
- **Uniswap v4** is the **trading and price-discovery layer**: each option series
  (e.g. `oETH-3500-CALL / USDC`) gets a v4 pool, the constant-product curve sets
  the price traders see, and an `afterSwap` hook reads the new price, recomputes
  implied volatility, and widens spread/fees under buying pressure. This is how
  traders see prices and trade the option — it is a primary piece, not an add-on.

**Three things to get right:**

1. **Uniswap v4 is core and it qualifies — just confirm which prize you're
   claiming.** Building with the Uniswap stack (hooks, periphery, open-source) is
   an accepted submission path, so your v4 pool + `afterSwap` hook is legitimate,
   front-and-center prize work. One eligibility check: the **"Best Uniswap API
   Integration" ($7,000)** prize text reads "Projects must integrate the Uniswap
   API with a valid API key," and the **"Best Uniswap Stack Contribution"
   ($3,000)** prize is Continuity-Track only. So if you are *not* in the
   Continuity Track, the surest way to claim a Uniswap prize is to *also* wire in
   the **Uniswap Trading API** (real key + captured onchain tx IDs) — cheap
   insurance that costs ~2 commits and turns "hopefully eligible" into
   "unambiguously eligible." Keep the hook as the centerpiece either way.
   (See Finding A.)
2. **Hedera is a *separate* prize track, not a bolt-on.** There are real Hedera
   prizes — **Tokenization on Hedera ($3,000)** and **AI & Agentic Payments on
   Hedera ($6,000)** — so Hedera is worth money (my first draft wrongly said no
   Hedera prize existed). But Uniswap v4 and 1inch Aqua/SwapVM are **not deployed
   on Hedera**, so a Hedera entry is a *parallel build* (HTS option token +
   scheduled settlement), not an extension of the EVM stack. Pursue it only as a
   deliberate second track, and fix the muddled HCS framing. (See Finding C.)
3. **The plan is too big for a hackathon.** Custom SwapVM bytecode + Aqua vault
   + v4 hooks (with CREATE2 mining) + Hedera + a four-screen Next.js app is more
   than a weekend. Cut to the prize-critical path. (See Finding D.)

**Prize fit after fixes:**

| Prize | Amount | Fit | Notes |
|---|---|---|---|
| 1inch — Build an Aqua App | $5,000 (2.5k/1.5k/1k) | **Strong** | Options minted on Aqua+SwapVM; SwapVM scored higher |
| Uniswap — Best Uniswap **API** Integration | $7,000 (4k/2k/1k) | **Primary target** | v4 hook is the core; add a valid API key + onchain tx IDs to lock eligibility |
| Uniswap — Best Uniswap Stack Contribution | $3,000 | **If eligible** | Hooks/stack build qualifies directly — but Continuity-Track only |
| Hedera — Tokenization | $3,000 (up to 2×$1,500) | **Separate track** | Issue OptionToken via HTS + scheduled settlement; coherent fit |
| Hedera — AI & Agentic Payments | $6,000 (up to 2×$3,000) | **Stretch** | Needs autonomous agents (x402 / Agent Kit) settling onchain |
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

**Hedera (separate sponsor — optional second track):**
- **Tokenization on Hedera ($3,000, up to 2 teams × $1,500):** build with the
  **Hedera Token Service (HTS)** — create/configure/manage tokens at the protocol
  level with custom fee schedules, compliance controls, and atomic operations, no
  smart contract required. RWA focus; "settle on maturity via **Scheduled
  Transactions**" is a listed example.
- **AI & Agentic Payments on Hedera ($6,000, up to 2 teams × $3,000):** build AI
  agents that move value autonomously (sub-second finality, sub-cent fees) using
  the Hedera Agent Kit, OpenClaw Agent Commerce Protocol, or the x402 standard.

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

### Finding A — Uniswap v4 is the centerpiece; lock prize eligibility with the API
Your v4 pool + `afterSwap` hook is the trading and price-discovery layer — how
traders see prices and trade option tokens — so it is correctly central, and
building with the Uniswap stack is an accepted submission path. The only thing to
nail down is *which* Uniswap prize pays out for it at this event:
- **Best Uniswap Stack Contribution ($3,000)** would reward a pure hooks build
  directly — **but it's Continuity-Track only.** Confirm whether you're in that
  track.
- **Best Uniswap API Integration ($7,000)** is the open prize, and its text says
  "Projects must integrate the Uniswap API with a valid API key" plus real
  onchain **transaction IDs**.

**Fix (cheap insurance):** keep the hook as the core, *and* wire the **Uniswap
Trading API** into the real trade path (e.g. quote/route the premium asset, or
execute the secondary swap) with a Developer-Platform key, capturing tx IDs. Two
small commits convert "I built a hook and hope it counts" into "I integrated the
Uniswap API" — the exact wording the $7k prize asks for — while the hook still
carries the technical story. Don't rely on the hook alone for the $7k unless the
bounty page explicitly says hooks qualify for *that* prize without an API key.

### Finding B — SwapVM is stateless; the "global volatility" loop is stateful  *(critical)*
Commit 3 correctly calls the SwapVM pricing script **stateless**, but Commit 8
stores and mutates `σ_global` across swaps. A stateless script cannot hold that
state. **Fix:** keep the mutable demand/vol state in the **v4 hook** (its natural
home — `afterSwap` already runs there) and have the SwapVM mint script *read* it
as an input parameter. Be explicit about where each variable lives:
spot/strike/expiry/side are call inputs; `σ_global` is hook storage.

### Finding C — Hedera: a viable second track, but rebuild the commit  *(corrected)*
My first draft said "no Hedera prize is in scope" — that was wrong. There are two
Hedera prizes (**Tokenization $3k**, **AI & Agentic Payments $6k**). The original
Commit 11 was still technically muddled, though: it leaned on **Hedera Consensus
Service (HCS)** for scheduling, but HCS is consensus ordering/timestamps, not a
scheduler. The correct primitives are:
- **Hedera Token Service (HTS):** mint/manage the OptionToken as a *native* token
  from Solidity via the HTS precompile (HIP-206/358), with **custom fee schedules**
  (the premium spread can be a native custom fee) and built-in compliance/KYC.
- **Hedera Schedule Service (HSS):** schedule the **expiry settlement** as a
  native scheduled transaction/contract call — the tokenization bounty's own
  "settle on maturity via Scheduled Transactions" example is structurally
  identical to an option settling at expiry.

**Key constraint:** Uniswap v4 and 1inch Aqua/SwapVM do **not** run on Hedera, so
this is a *parallel* deployment, not a cross-call from the EVM contracts. Treat a
Hedera entry as its own focused submission (HTS option token + HSS settlement →
Tokenization prize), and only attempt the $6k Agentic-Payments prize if you add a
real autonomous-agent layer (x402 / Hedera Agent Kit) — that is a separate
product, not a feature toggle. **Recommendation:** if you want Hedera, target the
**Tokenization $3k** with the HTS+HSS build and treat 1inch as your primary; do
not try to win all three sponsors at depth in one hackathon. Also verify Hedera's
EVM supports any Cancun opcodes you rely on before porting EVM contracts.

### Finding D — Cut to the prize-critical path  *(critical)*
Custom Yul bytecode + Aqua vault + v4 hooks (CREATE2 mining) + Hedera + four UI
screens will not finish cleanly. **Two co-equal must-haves, then trim:**
1. **Must-have (Uniswap $7k):** v4 pool per option series + `afterSwap` IV
   repricing hook (the price-discovery core) **and** a Uniswap Trading-API
   touchpoint with a real key + captured tx IDs to lock eligibility.
2. **Must-have (1inch $5k):** OptionToken → SwapVM pricing assembled from the
   instruction library → Aqua JIT collateral vault → a script/test that performs
   a real onchain token transfer (buy → mint).
3. **Nice-to-have:** full lifecycle/settlement automation, LP dashboard. Build
   after the two must-haves demo end-to-end.
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
- **I. "No market makers" vs. needing v4 LPs (be precise in the README).** Your
  v4 pools still need someone to seed initial liquidity, which is in tension with
  the "eliminate active market makers" pitch. **Fix:** state it cleanly — the
  *primary* market (Aqua JIT mint) needs no active MM; the *secondary* Uniswap v4
  market is where price discovery happens and needs only passive/seed liquidity,
  not an active quoting desk. Also decide who seeds each pool for the demo (you
  can seed it yourself with the minted tokens).
- **J. CREATE2 hook-address mining (Phase 3)** is real but necessary work — v4
  requires the hook address to encode its permission flags, so keep the salt
  miner; it's part of standing up the centerpiece, not optional.
- **K. `evm_version = "cancun"` (Commit 1) is correct** for v4 transient
  storage — keep it, and confirm your demo chain/fork supports TSTORE/TLOAD.
- **L. Don't forget the non-code deliverables.** The Uniswap prize needs a
  ≤3-min video and the feedback form; both prizes need a clean README. Schedule
  these as their own commits/tasks (see Commit 15).

---

## Revised 15-Commit Plan

Ordered so the option is **minted** (Aqua/SwapVM) and then **traded** (Uniswap v4
— the centerpiece) before anything optional. Each bullet is one clean, short
commit. **Hedera is an optional parallel track** (see the add-on after Phase 6) —
include it only if you commit to a second sponsor; it does not slot into the EVM
contracts.

### Phase 1 — Foundation
1. **Scaffold Foundry repo.** `foundry.toml` (`evm_version = "cancun"`),
   `remappings.txt`, `.gitignore`; install `@uniswap/v4-core`,
   `@uniswap/v4-periphery`, `@openzeppelin/contracts`. *Verify:* `forge build`
   is clean. *(Dependency install is its own commit.)*
2. **`OptionToken.sol` + test.** ERC-20 with immutable `underlying`,
   `strikePrice`, `expiry`, `isCall`; protocol-only `mint`/`burn`. *Verify:*
   only the vault can mint/burn; metadata reads back.

### Phase 2 — Minting (1inch Aqua + SwapVM)
3. **SwapVM pricing skeleton.** Start from `AquaSwapVMRouter` / the existing
   instruction set; define the entry path taking `S, K, T, side(BUY/SELL)`.
   *Verify:* interface compiles; mock call returns a number.
4. **Parametric pricing + asymmetric spread.** Implement a concrete cheap vol
   smile (document the formula + fixed-point format) and the ±2% BUY/SELL
   modifier. Read `σ_global` as an **input** (state lives in the hook — Finding B).
   *Verify:* OTM/ITM scale vol; BUY/SELL return asymmetric bid/ask.
5. **`AquaCollateralVault.sol` — JIT mint.** Track LP virtual balances; on a
   buyer paying the exact SwapVM premium, lock 1 ETH (call) or K USDC (put) from
   the LP, route the premium to the LP, mint an OptionToken to the buyer.
   *Verify:* forge test of the full JIT mint with a **real token transfer**.

### Phase 3 — Trading & price discovery (Uniswap v4)  ← centerpiece
6. **Pool + hook scaffold.** `OptionPricingHook.sol` (BaseHook with
   `beforeSwap`/`afterSwap` flags) + CREATE2 salt miner; initialize a v4 pool for
   an `oETH-3500-CALL / USDC` series. *Verify:* hook attaches; pool initializes.
7. **`afterSwap` IV repricing + `beforeSwap` band.** `afterSwap` reads the new
   pool price, recomputes implied volatility, and widens spread/fee under buying
   pressure (this is the **stateful home** for `σ_global`, Finding B);
   `beforeSwap` guards with a **tolerance band**, not a hard revert (Finding H).
   *Verify:* back-to-back buys reprice upward; only a toxic trade is blocked.

### Phase 4 — Uniswap API integration (lock $7k eligibility)
8. **Trading-API client + key wiring.** Thin client (frontend or small service)
   calling the Uniswap Trading API for quotes/routing with a real Developer-
   Platform key. *Verify:* a live quote round-trips.
9. **Execute a real swap via the API.** Route a real trade (premium asset or the
   secondary option-token swap) through the API onchain and **capture the
   transaction ID**. *Verify:* tx hash recorded; visible on an explorer.

### Phase 5 — Lifecycle & settlement
10. **Expiration engine.** Lock the final settlement spot once
    `block.timestamp > expiry` via oracle. *Verify:* blocked before T, frozen
    after T.
11. **Fully-collateralized payout.** OTM → release full collateral to LP; ITM →
    settle (pick physical per Finding G) and return remainder to LP. *Verify:*
    vault returns to zero-liability; capital distributes cleanly.

### Phase 6 — Frontend & demo deliverables
12. **Next.js + wallet boilerplate.** Next.js, tailwind, wagmi, viem against the
    EVM RPC/fork. *Verify:* `npm run dev`, wallet connects.
13. **Option matrix UI.** Grid of strikes showing **live prices from the Uniswap
    v4 pools** (secondary) alongside the SwapVM mint quote (primary). *Verify:*
    options chain renders with a real bid/ask smile that moves as the pool trades.
14. **One-click trade orchestrator.** Buy: either mint via Aqua/SwapVM (primary)
    or swap on the v4 pool via the Trading API (secondary), approve + execute in
    one flow. *Verify:* "Buy Call" lands a token in the wallet; price updates.
15. **LP dashboard + README + demo assets.** LP "Total Value Unlocked" view;
    `README.md` explaining how Aqua/SwapVM mint and Uniswap v4 trade/reprice
    compose (with the math); record the **≤3-min demo video** and submit the
    **Uniswap feedback form**. *Verify:* full test suite green; both submissions
    complete.

### Optional add-on — Hedera Tokenization track (parallel build)
Only if you choose Hedera as a second sponsor. These are *additional* commits in
a separate `hedera/` deployment, not edits to the EVM contracts above.
- **H1. HTS option token.** Mint/configure the OptionToken as a native HTS token
  from a Solidity contract via the HTS precompile, encoding the premium spread as
  a **custom fee** and (optionally) KYC/compliance flags. *Verify:* token created
  + a real onchain transfer on Hedera testnet (tx ID captured).
- **H2. Scheduled expiry settlement.** Use the Hedera Schedule Service to schedule
  the settlement transaction at expiry (the bounty's "settle on maturity via
  Scheduled Transactions" pattern). *Verify:* scheduled settlement fires and
  distributes/burns the HTS token at maturity.
- **H3. (Stretch, $6k Agentic Payments only)** Add an autonomous agent (x402 /
  Hedera Agent Kit) that discovers, prices, and settles an option position
  without manual steps. *Verify:* agent completes a buy→settle cycle onchain.

---

## Pre-Submission Checklist
- [ ] 1inch: onchain token transfer demoed (local fork OK), SwapVM used.
- [ ] Uniswap (primary): v4 pool + `afterSwap` repricing hook live; **and**
      Trading API integrated with a real key + **tx IDs captured** to lock the
      $7k eligibility. Confirm Continuity-Track status for the $3k Stack prize.
- [ ] Public repo, clean `README.md` with the pricing math.
- [ ] ≤3-min demo video recorded.
- [ ] Uniswap Developer Feedback Form submitted.
- [ ] Commit log: many small, building commits across days — no final-day dump.
- [ ] Hedera: decided in or out. If in, target Tokenization $3k via HTS option
      token + HSS scheduled settlement (parallel build) — not a cross-call from
      the EVM stack. Don't chase all three sponsors at depth.

---

### Sources
- [1inch launches Aqua (developers)](https://blog.1inch.com/aqua-developer-release/)
- [1inch/swap-vm (SwapVM routers & instruction set)](https://github.com/1inch/swap-vm)
- [Uniswap Trading API overview](https://docs.uniswap.org/api/trading/overview)
- [Uniswap Developer Platform is live](https://blog.uniswap.org/uniswap-developer-platform-is-live)
- [Uniswap developer docs](https://developers.uniswap.org/docs) — building with any part of the stack, including hooks, qualifies
- [Hedera Token Service](https://hedera.com/service/token-service/)
- [HIP-206: HTS precompile for smart contracts](https://hips.hedera.com/hip/hip-206) / [HIP-358: token create via precompile](https://hips.hedera.com/hip/hip-358)
- [Hedera system smart contracts (HTS + Schedule Service)](https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts)
