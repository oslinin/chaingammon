# Demo video shot list (Overflow 2026 submission)

Matches the design spec's §S7 checklist (`docs/superpowers/specs/2026-07-07-sui-port-design.md` line 155): *"3-min video (zkLogin sign-in → unrated game → mint agent → agent plays rated staked match → trade agent in Kiosk, buyer decrypts weights)."*

**Recording the video is the owner's step** (per the implementation plan's Task 9 Step 3) — this script makes it a read-through: each beat below names the exact UI action or CLI command to run and what should be visible on screen. Total target: ~3 minutes.

**Prerequisite:** the Move package deployed to Sui testnet and `sui/app` pointed at it (see `sui/README.md`'s "Deployed addresses" section) — none of the beats below work against localnet alone except beat 2 (unrated play has zero chain dependency by design).

---

## Beat 1 — Sign in (0:00–0:20)

- Open the deployed app's home page.
- Click **"Sign in."**
- **On screen:** address + `ELO 1500` render under `SignInPanel` (Task 5). If Enoki keys are configured by the time of recording, this is a real Google zkLogin round-trip; otherwise it's the `mock` identity path (still a real Sui address, no wallet extension) — say which one out loud, since that's a real, disclosed limitation (see `sui/submission/one-pager.md`).

## Beat 2 — Unrated game (0:20–0:50)

- Open a second browser profile/window, sign in as a second player.
- Both click **"Play unrated."**
- **On screen:** Nostr matchmaking pairs the two within a few seconds, both land on `/play`, play a few turns with commit-reveal dice visibly rolling, one side wins. Call out: *zero chain dependency for this whole flow* — matchmaking, moves, and dice are peer-to-peer.

## Beat 3 — Mint an agent (0:50–1:20)

Run on camera (terminal), from `sui/scripts`:

```bash
SUI_NETWORK=testnet SUI_PACKAGE_ID=<deployed-package-id> \
SUI_PRIVATE_KEY=<owner-bech32-key> \
SEAL_KEY_SERVER_OBJECT_IDS=<verified-testnet-key-server-ids> \
node --experimental-strip-types mint_agent.ts path/to/model.onnx "demo-agent" 1
```

- **On screen:** the script's own log lines — mint tx digest, Seal-encrypt, Walrus `blobId`, `set_weights` tx digest. Cut to a block explorer showing the new `Agent` object.

## Beat 4 — Agent plays a rated staked match (1:20–2:20)

- Two players (or one player + the minted agent, if agent-vs-human play is wired by demo time — flagged as **not implemented** in `sui/README.md`'s Task 7 section as of this script's writing; if still true at recording time, run two human `/play-rated` sessions instead and narrate that the on-chain mechanics — stake lock, `sui::random` dice, cosigned settle — are identical either way) click **"Play rated (0.1 SUI)."**
- **On screen:** the "Locking your stake on-chain…" phase banner, dice rolling with a visible on-chain roll each turn (call out that this is `sui::random` via `game_match::roll`, not commit-reveal), game to completion, "Settled on-chain — pot paid to …" banner. Cut to a block explorer showing the `Settled` event and both `HumanProfile`s' ELO having moved.

## Beat 5 — Trade the agent in a Kiosk, buyer decrypts (2:20–3:00)

Run on camera:

```bash
SUI_NETWORK=testnet SUI_PACKAGE_ID=<deployed-package-id> \
SUI_AGENT_TRANSFER_POLICY_ID=<policy-id> \
SEAL_KEY_SERVER_OBJECT_IDS=<verified-testnet-key-server-ids> \
SELLER_PRIVATE_KEY=<seller-key> BUYER_PRIVATE_KEY=<buyer-key> \
node --experimental-strip-types trade_agent.ts <agent-object-id> 100000000
```

- **On screen:** the script's own log — Kiosk created, listed, purchased, `claim_ownership` tx, then the loud final block:
  ```
  [trade_agent] BUYER (...) decrypt: OK
  [trade_agent] SELLER (...) decrypt: DENIED (correct) — ...
  [trade_agent] PASS: buyer decrypts OK, seller now denied — ...
  ```
- Narrate this is the whole point: no centralized re-encryption service, just an on-chain policy checking who currently owns the object.

## Closing card (last few seconds)

- Repo pointer: `sui` branch of `oslinin/chaingammon`.
- One line: "Native randomness, Seal + Kiosk, zkLogin — Sui deletes the three hardest problems the EVM version had open."
