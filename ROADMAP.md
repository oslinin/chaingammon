# Chaingammon — Roadmap

What's shipped vs. what's next. The hackathon scope landed on a working backgammon protocol with on-chain ELO, ENS profiles, encrypted weights, and a per-agent learning overlay. The items below are the natural extensions — most of them have been deliberately deferred to keep v1 focused.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component descriptions and data flows of what's currently live, [plan.md](plan.md) for the original phase plan (note: stale post-pivot for Phases 16–22), and [CHANGELOG.md](CHANGELOG.md) for a Keep-a-Changelog summary of what's landed.

---

## Now (remaining for hackathon submission)

### Match-flow polish

- [ ] Coach narration in match page — sub-project B (calls `coach_service` `/hint` after each turn, renders the LLM's blurb under the dice).
- [ ] Settlement story — sub-project C (two-sig settlement OR a deferred decision; design TBD; see the "two-sig vs state channel" discussion in the brainstorm log).
- [ ] Match replay page — verify post-pivot. The page renders from a 0G Storage `gameRecordHash`; confirm the game record format produced by the new browser-driven match flow round-trips correctly.
- [ ] Audit trail display — was framed for KeeperHub (now dropped). Reframe as a settlement-receipt view (showing the on-chain tx + signed match record) or drop entirely.

### Demo + submission

- [ ] Smoke-test the live stack end-to-end on real 0G testnet post-pivot (gnubg + coach + frontend).
- [ ] `web_readme.html` updates for Phases 17 and 18 (per phase-commit policy).
- [ ] Reconstruct the STATUS & ROADMAP slide in `chaingammon.pptx` (lost in an earlier session).
- [ ] Demo video recording.
- [ ] ETHGlobal submission form.

---

## Shipped (v1)

| Capability | Phase | Where it lives |
|---|---|---|
| gnubg subprocess wrapper | 1 | `server/app/gnubg_client.py` |
| EloMath (fixed-point K=32) | 2 | `contracts/src/EloMath.sol` |
| MatchRegistry + AgentRegistry (ERC-7857-shaped iNFT) | 2–5 | `contracts/src/{MatchRegistry,AgentRegistry}.sol` |
| 0G Storage round-trip via Node bridge | 6 | `og-bridge/`, `server/app/og_storage_client.py` |
| GameRecord archived to 0G Storage on `/finalize` | 7 | `server/app/game_record.py`, `server/app/main.py` |
| gnubg base weights encrypted (AES-256-GCM) on 0G Storage | 8 | `server/app/weights.py`, `server/scripts/upload_base_weights.py` |
| Per-agent experience overlay (light learning loop) | 9 | `server/app/agent_overlay.py` |
| ENS subname registrar contract | 10 | `contracts/src/PlayerSubnameRegistrar.sol` |
| Server-side text record updates (`elo`, `last_match_id`) | 11 | `server/app/ens_client.py`, `server/app/main.py` |
| Frontend wallet connect + agents list + match flow + replay | 12–14, 20 | `frontend/app/` |
| Frontend ENS name resolution + Claim Name flow | 15 | `frontend/app/{ProfileBadge,useChaingammonName,useChaingammonProfile}.{tsx,ts}` |

---

## Near-term (post-hackathon, weeks)

### Verifiable dice — commit-reveal VRF

Today the server is the trusted dice roller (gnubg's `roll_dice`). Every roll is logged in the GameRecord but a colluding server could re-roll until the agent gets a favorable position. Fix: each turn both players commit to a random nonce, reveal after the roll, and the chain-stored dice is `keccak256(nonceA ‖ nonceB) mod 36`. No external VRF dependency, no off-chain randomness, no MEV surface.

### Agent-vs-agent matches

The architecture already supports it (both sides can be agent_id; `winner_human` / `loser_human` go to the zero address). A match-of-the-week tournament between top-ELO iNFTs would be a compelling use of the experience-overlay learning loop. Needs: a runner that schedules matches, a leaderboard view, and a way for agent owners to opt their iNFTs in.

### KeeperHub-orchestrated settlement (Phases 16–19)

Replace the server's direct `recordMatch` web3 call with a KeeperHub workflow that runs the four settlement steps (recordMatch, ENS text record updates, overlay update, audit emission) with retry, gas optimization, and a public audit trail. The KeeperHub audit JSON would be mirrored to 0G Storage so it's viewable through the app even though KeeperHub's UI is auth-walled.

Currently blocked on KeeperHub account + CLI install — see Phase 16 in `plan.md`.

### Settle-on-chain button wired

The match-end banner in `/match?agentId=N` shows a disabled "Settle on-chain (coming Phase 17)" button. Once KeeperHub workflow exists, that button POSTs the workflow trigger and shows the run status. Today the server settles automatically on `/finalize`; the wired button gives the human player explicit control.

### Match replay polish

`/match/<matchId>` (Phase 20) renders the position at each move but doesn't animate the checker movement or highlight the dice → move mapping visually. Worth doing for the demo deck.

---

## Medium-term (months)

### ZK move proofs

Today the server validates moves by submitting them to gnubg and trusting the result. A motivated cheater with server access could submit illegal moves. A Groth16 / Plonky2 circuit proving "given this position and these dice, this move is legal" lets us drop the server from the trust path. The circuit is small — backgammon move legality is mechanical (point ownership, blot rules, bear-off conditions) — and the per-move proving cost is bounded.

### Anti-cheat for moves

Even with ZK move-legality, an agent could be replaced with a stronger one mid-match. Mitigation: the GameRecord pins `dataHashes` (base weights + overlay) at game start, and a verifier runs gnubg on the same hash + position + dice to confirm the move belongs to that agent's distribution. Probabilistic, but tight enough to deter swapping.

### Betting + cube doubling

Backgammon's doubling cube is fundamental to real play; we render it as a static badge but don't let players double yet. Add `cubeAction` to MoveEntry, surface a doubling UI, settle on the cube value at match end. Once doubling is live, a `MatchEscrow` contract holds both players' stakes; on `MatchRegistry.recordMatch(sig1, sig2)` the escrow releases to the winner. The existing two-signature settlement is the foundation — the on-chain result is already trustless. `MatchRegistry` already has room for stake metadata alongside `gameRecordHash`.

### Spectator prediction markets

Every match is committed on-chain before it starts (game record hash, player ELOs). A separate `MatchPredict` contract lets spectators buy outcome tokens before `recordMatch` settles — the final on-chain result resolves the market with no oracle. ELO history and overlay experience version are public inputs any pricing model can consume.

### Agent-as-income-stream

A high-ELO agent iNFT earns its owner money directly: opponent stake → agent wins → escrow releases to owner address. Owner proceeds can fund compute for further training. The loop closes: agents that win pay for the resources that make them win more. Agent-vs-agent tournaments (see Near-term) are a natural complement — automated round-robins with staked buy-ins, no human needed to schedule or settle.

### Liquidity provision — match escrow AMM

An LP pool can fund match escrows and collect a fee (e.g. 1–2% of each settled stake). LPs choose risk exposure by ELO tier: high-ELO matches have lower variance (tighter spreads), low-ELO matches are higher variance (wider spreads). The pool is permissionless — anyone can deposit and earn yield proportional to settled match volume.

### Derivatives — agent ELO as collateral

iNFT ELO is on-chain and read by `MatchRegistry.agentElo(agentId)`. Lending markets can collateralize against an agent's ELO + recent match history. A liquidation event happens when the agent's rolling ELO drops below the collateralization threshold. Longer-dated instruments are also natural: a binary option on "agent ELO ≥ 1600 in 30 days" settles by reading the on-chain value at expiry — no oracle, no counterparty risk beyond the contract. Niche but interesting because the underlying asset (an agent that plays games) is genuinely productive: it earns or loses ELO every match.

### Style profile aggregator (`style_uri`)

Phase 11 deferred `style_uri` — a per-player aggregate (e.g. "% openings as 24/18 13/11", "cube tendency: aggressive", "bear-off speed: median 3.2 turns"). Computing this needs walking every GameRecord blob for a given player. Either compute lazily on profile-page load, or run a periodic indexer that writes the rolled-up blob and pins it as the `style_uri` text record.

### Server replaceable by 0G Compute

The server is the trusted gnubg operator and the deployer-key signer. 0G Compute (planned, post-hackathon) lets us run gnubg inside a TEE / verifiable-compute environment and have the result signed by the network. The trust model collapses: anyone can settle a match without trusting our specific server.

---

## Long-term (year+)

### Full ENS integration on a real-ENS chain

Today's `PlayerSubnameRegistrar` is self-contained on 0G testnet (no canonical ENS root). v2 deploys to Sepolia / Linea Durin / mainnet, where `chaingammon.eth` is a real registered name and our registrar is the resolver behind it. Reads work through standard ENS hooks (`ens.idriss.xyz`, the canonical ENS app, etherscan name lookups). Migration path: snapshot the v1 mapping, mint each subname under the new registrar, point the resolver record.

### Tournament protocol + standings

Permissionless tournaments registered on-chain — each tournament is a contract that locks in a bracket, settles each match through the existing flow, and emits a final standings list. Chess.com / FIDE for backgammon, but with portable identity by default.

### Cross-platform reputation imports

Most serious backgammon players have a rating on at least one closed platform (XG, Backgammon Galaxy, BGroom). A signed attestation (or just a screen-recording for now) that a rating exists at platform X lets us mint a "verified rating" badge and seed the player's chaingammon ELO. Doesn't solve the lock-in for the platform that issued it, but lets people import their history into the open protocol.

### Match certification from gnubg PR

Backgammon analysis already has a quality metric: gnubg's "PR" (performance rating). Once a match is in 0G Storage, anyone can run gnubg over it and produce a per-player PR. Pin the PR as a text record (`pr` next to `elo`). Now the protocol carries not just outcome ratings but skill ratings.

---

## Won't do

These come up in conversations but don't fit the protocol thesis:

- **Closed-source agents.** The whole point is that an iNFT's intelligence is verifiable. A closed agent that just exposes a "play move" oracle isn't an iNFT, it's an API behind an NFT skin.
- **Mandatory subscriptions.** ENS subnames are issued free; matches cost only the on-chain tx fees. We've avoided every "premium tier" pattern by design.
- **Server-side rating manipulation knobs.** No "boost", "promotion", "verified" tiers above ELO. The number is the number.
