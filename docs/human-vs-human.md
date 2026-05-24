# Plan: "Play a human" — serverless human-vs-human over WebRTC, signaled via Nostr

## Context

Today Chaingammon only supports human-vs-AI, and the entire match runs inside one
browser tab: the opponent move is computed locally by the ONNX net
(`getBestMove`, `frontend/lib/match_engine.ts:163`, called at
`frontend/app/team-demo/page.tsx:871`), dice are rolled locally (`frontend/app/dice.ts`),
and the only network activity is *post-game* (upload the record to 0G via
`/upload-game-record` at `team-demo/page.tsx:96`, then on-chain settlement via
`MatchRegistry.settleWithSessionKeys`). **There is no move relay and no
human-vs-human path** — the previously-added `FindHumanButton.tsx` does matchmaking
discovery only, and its connect link is a dead end.

The user wants a basic-mode button that pairs you with another human who is *also
searching*, with **no server they run and nothing volatile written on-chain**.
Exploration confirmed the stack has no usable rendezvous channel: 0G KV is
server-only and not testnet-ready (`server/app/og_storage_client.py:110-157`), ENS is
too slow/permanent for real-time signaling, and there is no pub/sub anywhere.

**Decision (confirmed with user): use WebRTC for the peer connection and Nostr public
relays for both presence and the WebRTC signaling handshake.** Identity/ELO stay in
ENS; the volatile "searching + connect" layer moves entirely to Nostr.

## Scope

**In:** one-press **ELO-biased** auto-matchmaking over Nostr presence (replacing the
on-chain `searching` flag), WebRTC connect (Nostr-signaled + free public STUN), live move
relay, drand-derived verifiable dice
(wiring drand into the roll, replacing today's local dice for H-vs-H), a human-opponent
board mode, and automatic two-signature settlement (ELO + escrow + style — see *End-game &
settlement*).

**Out (explicit follow-ups, not this plan):**
- (Settlement is now **in scope** — both players pre-authorize at game start and the
  result auto-settles at game-end. See *End-game & settlement* below.)
- TURN relay for restrictive/symmetric NATs (start with public STUN; add TURN only if
  real-world testing shows direct connection failing).
- Signed/encrypted Nostr messages and a persistent Nostr identity (v1 uses an ephemeral
  per-session keypair; hardening is a follow-up).
- Commit-reveal dice — unnecessary given drand (which neither player controls and both can
  verify); kept only as a possible offline fallback, per `agent/drand_dice.py`'s own note.

## Architecture

Matchmaking is **one-press and automatic**: the human presses Play and gets connected to
someone else who pressed Play — **no list of searchers is shown** and there's no opponent
to pick. Pairing runs over Nostr presence with no server: each searcher publishes presence
(its ephemeral session pubkey **and its ENS `elo`**); each client sorts the currently-seen
searchers (including itself) **by ELO** (tiebreak by pubkey) and pairs **adjacent ranks**,
so each player meets an ELO-neighbor — biasing toward similar skill. Within a pair the
lower-pubkey peer is the WebRTC **offerer** (deterministic → no glare). Clients verify a
candidate's claimed ELO against its ENS record before pairing (cheap resolver read; stops
sandbagging). Both members of a pair derive the same pairing from
the same set, and the handshake confirms it (offer → answer → data-channel open). To absorb
churn (someone joins/leaves mid-handshake), act only after a short stabilization window and
re-derive on failure/timeout; the first pair whose channel opens wins and both stop
publishing presence. This auto-pairing handshake is the one piece carrying real complexity
— the cost of the fewest-steps UX.

New modules (all client-only — `"use client"`, browser APIs):

1. **`frontend/lib/nostr.ts`** — thin wrapper over `nostr-tools` `SimplePool`:
   - A fixed set of public relays.
   - `publishPresence()` — ephemeral event (kind in the 20000–29999 ephemeral range)
     tagged `#t = "chaingammon-match"`, content = `{ ensLabel, address, sessionPubkey, elo }`
     (ELO from the player's ENS record). Re-published on a ~15s heartbeat while searching;
     stopping = stop publishing
     (ephemeral events vanish on their own — no cleanup write, unlike ENS).
   - `subscribePresence(cb)` — filter `{ kinds, "#t":["chaingammon-match"], since }`;
     feed the **auto-matcher** the set of peers seen in the last ~20s (internal only —
     never rendered). This replaces the ENS `searching` poll.
   - `sendSignal(peerPubkey, matchId, payload)` / `subscribeSignals(myPubkey, cb)` —
     ephemeral events tagged `#p = peerPubkey`, `#d = matchId`, carrying SDP / ICE.

2. **`frontend/lib/webrtc_match.ts`** — `RTCPeerConnection` (config: public STUN, e.g.
   `stun:stun.l.google.com:19302`) + an ordered `RTCDataChannel`. The offerer (chosen by
   the matcher) creates the channel + offer; the responder answers; ICE candidates trickle
   over `nostr.ts`. Exposes a
   typed `send(msg)` / `onMessage(cb)` / `onState(cb)` interface so the game layer never
   touches Nostr or SDP directly.

3. **`frontend/lib/drand_dice.ts`** — verifiable dice via **drand**, the project's intended
   primitive (designed but not yet wired into the browser; today the board rolls locally
   via `rollDice`). Port `derive_dice` from `agent/drand_dice.py`:
   `dice = keccak256(round_digest ‖ turn_index_be8) mod 36 → (d1,d2)`. Both clients fetch
   the **same** drand round from a public endpoint (League of Entropy / drand quicknet) and
   derive identical dice — neither player controls the roll and either can verify it against
   drand's group public key. drand is a public decentralized beacon, so it satisfies the
   serverless / off-chain constraint exactly like the Nostr relays.

4. **H-vs-H game surface** — a new component/route (e.g.
   `frontend/app/play-human/[matchId]/`) that hosts the board for two humans. It
   **reuses** `match_engine.ts` (`newMatch`, `applyMoveToState`, `skipTurn`,
   `hasLegalMoves`, `offerDouble`/`acceptDouble`/`dropDouble`) and the same board view
   component `team-demo/page.tsx` renders (identify and reuse it — do **not** retrofit the
   AI-centric `team-demo` page). The opponent move arrives over the data channel instead
   of from `getBestMove`.

Reworked file:

5. **`frontend/app/FindHumanButton.tsx`** — drop the ENS `searching` `setText` write, the
   resolver polling, **and the searcher list entirely**. It becomes a single Play/Stop
   toggle: press Play → publish presence + run the auto-matcher (above) → on a successful
   pairing, hand the open data channel to the H-vs-H surface and route there. No list, no
   opponent pick — the only human step is pressing Play. (ELO drives the *pairing bias*
   above; the opponent's identity/ELO can also be shown inside the game — both read from ENS.)

Dependency: add **`nostr-tools`** to `frontend/package.json`.

## Sync protocol (data channel messages)

Deterministic, tiny — moves never desync because `applyMoveToState` is pure:

- `hello` — exchange identities; agree sides deterministically (lower `sessionPubkey` =
  side 0) and `match_length`. Both call `newMatch()`.
- Per turn: agree the drand round (mover sends `{ type:"roll", round_number }`; both fetch
  that round's digest from drand and derive dice via `drand_dice.ts`). Bind the round to the
  turn so neither side can shop for a roll — accept only a freshly-published round near turn
  start (rounds are unpredictable before publication). The mover then validates + applies
  its move locally via `applyMoveToState` (uses `isLegal`) and sends
  `{ type:"move", move, positionId }`. Receiver derives the same dice, applies the same
  move, and asserts `positionId === MatchState.position_id` (from `encodePositionId`) to
  detect desync.
- `double` / `accept` / `drop`, `resign`, and `bar-dance skip` map to the existing
  `match_engine` functions.

## End-game & settlement (decided)

Reuses the existing `settleWithSessionKeys` pattern, generalized to two humans, and stays
gasless for players:

- **Pre-game, both players sign.** On match start each wallet signs a `humanAuthSig`
  authorizing an ephemeral **session key** for this `matchId` (the EIP-191 auth
  `settleWithSessionKeys` already uses; per-human `nonce` guards replay). Staked matches
  also deposit to `MatchEscrow` here.
- **Play is serverless** (Nostr + WebRTC + drand).
- **On game-end, settlement is automatic.** Both session keys auto-sign the agreed final
  result (winner + score + `gameRecordHash`) over the data channel — no human prompt.
  Either player or any relayer submits; the contract already permits "either player or any
  relayer" (`MatchRegistry.sol:229,330`).
- **Gas from Privy or the pot.** Privy is already integrated (`@privy-io/react-auth`,
  `@privy-io/wagmi`), so the submitter uses a Privy embedded / sponsored tx; for staked
  matches gas can instead be drawn from the escrow pot at payout.
- **ELO + escrow need no new economics.** `recordMatch` / `recordMatchAndSplit(winnerHuman,
  …, loserHuman, …)` already update `_humanElo[address]` via `EloMath` and split the pot
  (`MatchRegistry.sol:52,148,187`, `MatchEscrow.payoutSplit`). The **one new contract
  piece** is a two-human variant of `settleWithSessionKeys` (today it hard-requires
  `agentId != 0` + an agent session key, `MatchRegistry.sol:259-260,294`):
  `settleHumanVsHuman(matchId, a, sessionKeyA, authSigA, b, sessionKeyB, authSigB, result,
  resultSigA, resultSigB, nonceA, nonceB)` that verifies both auth chains + both result
  sigs agree on the winner, then records + splits.
- **Style vectors.** Add the human-overlay path (`chaingammon/overlay/human/{address}`,
  reserved in `og_storage_client.py:24` but unbuilt — `_update_agent_overlay_kv` skips
  `agent_id == 0`, `main.py:256`) computed from the agreed `GameRecord` via the existing
  `classify_move` / `update_overlay`. CAVEAT: this writes to 0G **KV**, a localhost JSON
  mock that **errors on testnet** until the 0G SDK ships a KV client
  (`og_storage_client.py:113-116`); the write is non-fatal, so style persists on localhost
  and no-ops on testnet — a pre-existing limitation, not specific to H-vs-H.

The contract addition (+ redeploy + review) is the heaviest, least sandbox-verifiable part
— sequence realtime play first, then settlement.

## Constraints / risks

- **Cannot build or verify in this sandbox** — `frontend/node_modules` isn't installed
  and package downloads are blocked here, so `nostr-tools` can't be added and nothing can
  be type-checked, built, or e2e-tested in this environment. Implement + verify in a
  deps-available env.
- **`frontend/AGENTS.md` warns this is a non-standard Next.js** ("read
  `node_modules/next/dist/docs/` before writing code"). All new pieces are client-only
  browser code; ensure no SSR execution of WebRTC/Nostr (guard with `"use client"` and
  client-mount checks), and consult those docs during implementation.
- WebRTC without TURN won't connect for a minority of NATs — acceptable for v1, flagged
  as a follow-up.

## Verification (in a deps-available env)

1. `pnpm --filter frontend install` (adds `nostr-tools`), then `pnpm --filter frontend dev`.
2. Two browser profiles, two ENS identities, both in **basic (elo)** mode → both press
   **"Play a human"** and nothing else. Confirm they **auto-connect** (no list, no click)
   and the data channel opens.
3. Confirm a full match plays: moves relay both ways, both sides derive identical dice from
   the shared drand round (and can verify it), `position_id` matches on both sides each
   turn, and game-over/score are detected identically.
4. Repeat **across two machines / networks** to exercise STUN/NAT (not just same-host
   tabs); note whether TURN is needed.
5. Edge cases: 3+ concurrent searchers of varied ELO each pair with their ELO-neighbor
   (skill bias) and no one is left stuck; a candidate advertising a false ELO is rejected
   (ENS check); churn during the handshake re-pairs; peer refresh/disconnect mid-game; a
   relay being down (multi-relay fallback); pressing Stop clears presence.
6. `pnpm --filter frontend test:e2e` for regressions; add a presence/connect test where
   feasible (full two-peer WebRTC e2e may stay manual).

## Documentation updates

The repo keeps docs in lockstep with code (per `CONTEXT.md` conventions and the
phase-log style of `log.md` / `CHANGELOG.md`), so this feature updates:

- **`README.md`**
  - *How it works → Per-turn sequence* (`:27`): add the human-vs-human turn flow
    (drand-derived dice + move relay over the WebRTC data channel) beside the AI flow. The
    existing drand sequence (`:21`, `:42-43`) is KeeperHub-driven; document that in
    serverless H-vs-H each browser fetches the drand round directly (and aligns with the
    Phase-37 browser-verification TODO in `LogClient.tsx:14`).
  - *Architecture* (`:61`): add the serverless P2P transport — WebRTC data channel for
    moves, Nostr public relays for presence + signaling; note nothing routes through a
    server you run or onto the chain.
  - *Frontend routes* (`:504`): add `/play-human/[matchId]`; note `/` matchmaking now uses
    Nostr presence instead of an on-chain `searching` flag.
  - *Roadmap* (`:537-539`): **fix the inaccuracy** — line 539 lists "human-vs-human" as a
    shipped feature today; re-label it in-progress until this lands, then mark done. Add
    H-vs-H on-chain settlement (two-sig) and TURN as roadmap items.
- **`CONTEXT.md`**: *Architecture* (`:25`) text/diagram and *Key Files* (`:152`) — list
  `frontend/lib/nostr.ts`, `webrtc_match.ts`, `dice_commit_reveal.ts`, and the play-human
  route; state that Nostr presence replaces the on-chain searching flag.
- **`frontend/README.md`** (`:3`, `:8`, `:80`): update the matchmaking description + route
  table for Nostr presence + the play-human route; **correct the stale claim** that
  gameplay delegates move evaluation / match state to the FastAPI server (it runs
  in-browser via `match_engine.ts`).
- **`log.md` / `CHANGELOG.md`**: add a phase entry for the WebRTC + Nostr H-vs-H feature,
  matching the existing entry style.

## Critical files

- New: `frontend/lib/nostr.ts`, `frontend/lib/webrtc_match.ts`,
  `frontend/lib/drand_dice.ts` (ports `agent/drand_dice.py`),
  `frontend/app/play-human/[matchId]/` (board host).
- Modified: `frontend/app/FindHumanButton.tsx` (Nostr presence + connect),
  `frontend/package.json` (add `nostr-tools`).
- Reused: `frontend/lib/match_engine.ts`, `frontend/lib/rules_engine.ts`,
  `agent/drand_dice.py` (the dice-derivation scheme to port to TS), the board view
  component used by `frontend/app/team-demo/page.tsx`,
  `frontend/app/useChaingammonProfile.ts` (ELO).
