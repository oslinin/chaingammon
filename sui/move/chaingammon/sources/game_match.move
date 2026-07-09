/// game_match.move — match lifecycle and co-signed settlement.
///
/// Named `game_match` (not `match`) because `match` is a reserved keyword
/// in Move (it has a native `match` expression for pattern matching), so
/// `module chaingammon::match` fails to parse. The `Match` struct name
/// itself is unaffected — only bare lowercase `match` collides.
///
/// Replaces the co-signed HvH settlement path in
/// frontend/app/play-human/PlayHumanClient.tsx (finishGame/settleMatch,
/// ~lines 308-386) and the on-chain half of MatchRegistry.settleWithSessionKeys.
/// Rules/move validation stays entirely off-chain (WebRTC + the client rules
/// engine) exactly as today — this module only locks stakes, verifies both
/// players' session-key signatures over the final result, and pays out.
///
/// State machine: OPEN -> PLAYING -> SETTLED, with CANCELLED reachable from
/// OPEN (cancel_unjoined) or PLAYING (abandon). There is no ADJUDICATING
/// state in v1 — the spec's Nautilus adjudication path
/// (docs/superpowers/specs/2026-07-07-sui-port-design.md §7) stays
/// design-only per the owner's 2026-07-08 decision; `abandon` is the interim
/// griefing relief valve (50/50 split after a timeout).
///
/// `Match` is a SHARED object (`key` only, no `store` — it is never
/// individually owned/traded, only ever referenced by both players and
/// whoever submits the settling transaction).
module chaingammon::game_match {
    use std::bcs;
    use std::vector;

    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::ed25519;
    use sui::event;
    use sui::random::{Self, Random};
    use sui::sui::SUI;

    use chaingammon::agent::{Self, Agent};
    use chaingammon::elo;
    use chaingammon::profile::{Self, HumanProfile};

    // ── Errors ──────────────────────────────────────────────────────────
    // Numeric, not named-export — see agent.move's Errors section for why
    // Move has no `public const`.
    const EWrongState: u64 = 0;
    const EBadSigA: u64 = 1;
    const EBadSigB: u64 = 2;
    const EInvalidWinner: u64 = 3;
    const EZeroStake: u64 = 4;
    const EStakeMismatch: u64 = 5;
    const ECannotJoinOwnMatch: u64 = 6;
    const ENotCreator: u64 = 7;
    const ETooEarly: u64 = 8;
    const ENoAgentsRecorded: u64 = 9;
    const EAgentMismatch: u64 = 10;
    const ENoProfilesRecorded: u64 = 11;
    const EProfileMismatch: u64 = 12;
    const ENotRated: u64 = 13;
    const EWrongRoller: u64 = 14;

    // ── State machine ─────────────────────────────────────────────────
    const STATE_OPEN: u8 = 0;
    const STATE_PLAYING: u8 = 1;
    const STATE_SETTLED: u8 = 2;
    const STATE_CANCELLED: u8 = 3;

    /// Epochs that must pass after `join` before anyone may call `abandon`.
    /// An epoch on Sui is ~24h, so 7 epochs is roughly a week — generous
    /// enough that a real game (minutes, not days) never legitimately hits
    /// this, while bounding how long a griefed stake can stay locked.
    const ABANDON_EPOCHS: u64 = 7;

    // ── Types ───────────────────────────────────────────────────────────

    public struct Match has key {
        id: UID,
        // Off-chain-agreed match identifier (the Nostr/WebRTC match id,
        // hex-decoded to bytes) — deliberately NOT `object::id(&self)`.
        // Binding the real Sui object id into the signed result message
        // would make offline-generated fixtures (tests, demos) depend on
        // however the test/runtime framework happens to assign object ids;
        // an app-supplied identifier set once at `open` and never mutated
        // gives the same anti-replay property (settle_cosigned can only
        // succeed once per Match, since it requires state == PLAYING and
        // immediately flips to SETTLED) without that coupling.
        app_match_id: vector<u8>,
        state: u8,
        creator: address,
        // @0x0 sentinel until `join` — a real joiner address can never
        // legitimately be the zero address, so this is unambiguous.
        joiner: address,
        session_pk_a: vector<u8>,
        session_pk_b: vector<u8>, // empty until `join`
        stake: Balance<SUI>,
        rated: bool,
        created_epoch: u64,
        // None until `join`; Option (not a sentinel) because epoch 0 is a
        // real, reachable epoch value early in a chain's life.
        joined_epoch: Option<u64>,
        // Set (independently) by whichever side supplies it at open/join
        // time — the creator can only ever set agent_a for themselves, the
        // joiner only agent_b, so the pairing is correct by construction;
        // nobody can attribute an agent to the wrong side.
        agent_a: Option<ID>,
        agent_b: Option<ID>,
        // Same pattern as agent_a/agent_b, for the human-profile ELO hook
        // (Task 5). A given side sets at most one of {agent_x, profile_x} —
        // a match participant is either an agent or a human, never both.
        profile_a: Option<ID>,
        profile_b: Option<ID>,
        // On-chain dice (Task 6, rated matches only — unrated play uses the
        // fully off-chain commit-reveal scheme and never touches `roll`).
        // Monotonic counter, incremented once per successful `roll` call;
        // also determines whose turn it is to roll (see `roll`'s doc
        // comment) — the anti-grinding property this whole mechanism
        // exists for depends on turn_index only ever moving forward by
        // exactly one per call, which is why `roll` never accepts it as a
        // caller-supplied argument.
        turn_index: u64,
    }

    /// The bytes actually signed by both session keys. `winner` is the
    /// address (creator or joiner) the two players agree won the match;
    /// everything else pins this signature to one specific match and
    /// protocol version so it can't be replayed elsewhere.
    public struct ResultMsg has drop {
        domain: vector<u8>,
        app_match_id: vector<u8>,
        winner: address,
    }

    // ── Events ──────────────────────────────────────────────────────────

    public struct Opened has copy, drop {
        match_uid: ID,
        app_match_id: vector<u8>,
        creator: address,
        stake: u64,
        rated: bool,
    }

    public struct Joined has copy, drop {
        match_uid: ID,
        joiner: address,
        stake: u64,
    }

    public struct Settled has copy, drop {
        match_uid: ID,
        winner: address,
        amount: u64,
    }

    public struct Cancelled has copy, drop {
        match_uid: ID,
        reason: vector<u8>,
    }

    public struct DiceRolled has copy, drop {
        match_uid: ID,
        turn_index: u64,
        d1: u8,
        d2: u8,
    }

    // ── Canonical message ────────────────────────────────────────────────

    fun canonical_result_bytes(app_match_id: vector<u8>, winner: address): vector<u8> {
        let msg = ResultMsg {
            domain: b"Chaingammon:result-sui-hvh",
            app_match_id,
            winner,
        };
        bcs::to_bytes(&msg)
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// Open a match: locks the creator's stake, registers their session
    /// pubkey, shares the Match object. `agent_a` is `option::some(id)` when
    /// the creator is playing as an agent (their own agent — see the struct
    /// doc comment on `agent_a`/`agent_b`), `option::none()` for a human.
    /// `profile_a` is the mirror image for a human creator with a
    /// `HumanProfile` (Task 5) — leave both `option::none()` for a human who
    /// hasn't created a profile yet (settle_cosigned still works; only the
    /// ELO-updating variants require a profile/agent to be recorded).
    public fun open(
        stake_coin: Coin<SUI>,
        session_pk: vector<u8>,
        rated: bool,
        app_match_id: vector<u8>,
        agent_a: Option<ID>,
        profile_a: Option<ID>,
        ctx: &mut TxContext,
    ) {
        let creator = tx_context::sender(ctx);
        let stake_value = coin::value(&stake_coin);
        assert!(stake_value > 0, EZeroStake);

        let match_obj = Match {
            id: object::new(ctx),
            app_match_id,
            state: STATE_OPEN,
            creator,
            joiner: @0x0,
            session_pk_a: session_pk,
            session_pk_b: vector::empty<u8>(),
            stake: coin::into_balance(stake_coin),
            rated,
            created_epoch: tx_context::epoch(ctx),
            joined_epoch: option::none(),
            agent_a,
            agent_b: option::none(),
            profile_a,
            profile_b: option::none(),
            turn_index: 0,
        };
        event::emit(Opened {
            match_uid: object::id(&match_obj),
            app_match_id: match_obj.app_match_id,
            creator,
            stake: stake_value,
            rated,
        });
        transfer::share_object(match_obj);
    }

    /// Join an OPEN match. Stake must exactly match the creator's. Rejects
    /// joining your own match — a match needs two independent signers for
    /// co-signed settlement to mean anything.
    public fun join(
        match_obj: &mut Match,
        stake_coin: Coin<SUI>,
        session_pk: vector<u8>,
        agent_b: Option<ID>,
        profile_b: Option<ID>,
        ctx: &TxContext,
    ) {
        assert!(match_obj.state == STATE_OPEN, EWrongState);
        let joiner = tx_context::sender(ctx);
        assert!(joiner != match_obj.creator, ECannotJoinOwnMatch);
        let stake_value = coin::value(&stake_coin);
        assert!(stake_value == balance::value(&match_obj.stake), EStakeMismatch);

        balance::join(&mut match_obj.stake, coin::into_balance(stake_coin));
        match_obj.joiner = joiner;
        match_obj.session_pk_b = session_pk;
        match_obj.agent_b = agent_b;
        match_obj.profile_b = profile_b;
        match_obj.joined_epoch = option::some(tx_context::epoch(ctx));
        match_obj.state = STATE_PLAYING;

        event::emit(Joined { match_uid: object::id(match_obj), joiner, stake: stake_value });
    }

    /// On-chain dice for RATED matches (design spec §5) — the anti-grinding
    /// property the EVM version never had: the roller cannot see d1/d2
    /// before this call lands on-chain, and cannot pick which roll to keep
    /// by retrying, since the roll comes from `sui::random`, not the
    /// client. Unrated matches never call this — they use the fully
    /// off-chain, zero-gas commit-reveal scheme instead (see
    /// `sui/app/lib/commit_reveal_dice.ts`).
    ///
    /// `public(package)` + `entry`: `entry` so this is invokable as a PTB
    /// entrypoint from the app (client SDKs dispatch entry functions
    /// directly, bypassing normal Move cross-module visibility);
    /// `public(package)` so `game_match_tests` (a different module in this
    /// same package) can call it directly too, the same way `sui move
    /// test` exercises every other function here — a bare (fully private)
    /// `entry fun` would be PTB-callable but not callable from test code in
    /// another module. Per the Random docs, this must NOT be plain
    /// `public`: a public function taking `&Random` could be composed into
    /// another package's own function, defeating the "no aborting after
    /// seeing the random result" protection Sui's PTB-level restrictions
    /// enforce specifically around `entry` functions.
    ///
    /// Roller alternates strictly by `turn_index` parity (even → creator,
    /// odd → joiner) — this is what "alternating roller" means here, not
    /// whose turn it is in the backgammon game itself (the two can diverge
    /// after a skipped/bar-danced turn; the app tracks the real game turn
    /// separately off-chain and simply calls `roll` once per ply regardless
    /// of who is about to move). `turn_index` itself is never a caller
    /// argument — only ever read from on-chain state and incremented by
    /// exactly one per call — so nobody can replay, skip, or rewind it.
    public(package) entry fun roll(match_obj: &mut Match, r: &Random, ctx: &mut TxContext) {
        assert!(match_obj.state == STATE_PLAYING, EWrongState);
        assert!(match_obj.rated, ENotRated);
        let expected_roller = if (match_obj.turn_index % 2 == 0) { match_obj.creator } else { match_obj.joiner };
        assert!(tx_context::sender(ctx) == expected_roller, EWrongRoller);

        let mut generator = random::new_generator(r, ctx);
        let d1 = random::generate_u8_in_range(&mut generator, 1, 6);
        let d2 = random::generate_u8_in_range(&mut generator, 1, 6);

        event::emit(DiceRolled {
            match_uid: object::id(match_obj),
            turn_index: match_obj.turn_index,
            d1,
            d2,
        });
        match_obj.turn_index = match_obj.turn_index + 1;
    }

    /// Happy path: either player (or a sponsor submitting on their behalf)
    /// calls this with both session-key signatures over the canonical
    /// result bytes. Move reconstructs those bytes itself from on-chain
    /// state — the caller supplies only the signatures, so nobody can claim
    /// a result the two session keys didn't actually sign. Pays the full
    /// pot to `winner`. Use `settle_cosigned_with_agents` instead when the
    /// match records agent ids (see that function's doc comment).
    public fun settle_cosigned(
        match_obj: &mut Match,
        winner: address,
        sig_a: vector<u8>,
        sig_b: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(match_obj.state == STATE_PLAYING, EWrongState);
        assert!(winner == match_obj.creator || winner == match_obj.joiner, EInvalidWinner);

        let msg = canonical_result_bytes(match_obj.app_match_id, winner);
        assert!(ed25519::ed25519_verify(&sig_a, &match_obj.session_pk_a, &msg), EBadSigA);
        assert!(ed25519::ed25519_verify(&sig_b, &match_obj.session_pk_b, &msg), EBadSigB);

        match_obj.state = STATE_SETTLED;
        let amount = balance::value(&match_obj.stake);
        let payout = balance::split(&mut match_obj.stake, amount);
        transfer::public_transfer(coin::from_balance(payout, ctx), winner);

        event::emit(Settled { match_uid: object::id(match_obj), winner, amount });
    }

    /// Same verification and payout as `settle_cosigned`, plus updates both
    /// agents' ELO. Requires the match to have recorded BOTH agent ids at
    /// open/join time, and the caller to supply the matching `&mut Agent`
    /// objects (which, since Agent isn't Kiosk-placed in v1, means the
    /// caller must already natively own both — realistic for the existing
    /// operator-run tournament pattern where one address manages a fleet of
    /// agents; revisit this assumption once Task 8 puts agents in Kiosks).
    public fun settle_cosigned_with_agents(
        match_obj: &mut Match,
        winner: address,
        sig_a: vector<u8>,
        sig_b: vector<u8>,
        agent_a_obj: &mut Agent,
        agent_b_obj: &mut Agent,
        ctx: &mut TxContext,
    ) {
        assert!(option::is_some(&match_obj.agent_a), ENoAgentsRecorded);
        assert!(option::is_some(&match_obj.agent_b), ENoAgentsRecorded);
        assert!(*option::borrow(&match_obj.agent_a) == agent::id(agent_a_obj), EAgentMismatch);
        assert!(*option::borrow(&match_obj.agent_b) == agent::id(agent_b_obj), EAgentMismatch);

        // Read ratings and which side won before settle_cosigned mutates
        // state — creator/joiner fields themselves don't change there.
        let elo_a = agent::elo(agent_a_obj);
        let elo_b = agent::elo(agent_b_obj);
        let a_won = winner == match_obj.creator;

        settle_cosigned(match_obj, winner, sig_a, sig_b, ctx);

        let exp_a = elo::expected_score_pct(elo_a, elo_b);
        let exp_b = elo::expected_score_pct(elo_b, elo_a);
        agent::record_result(agent_a_obj, elo::new_rating(elo_a, exp_a, a_won));
        agent::record_result(agent_b_obj, elo::new_rating(elo_b, exp_b, !a_won));
    }

    /// Same verification and payout as `settle_cosigned`, plus updates both
    /// humans' ELO on their `HumanProfile` objects. Requires the match to
    /// have recorded BOTH profile ids at open/join time (see `profile_a`/
    /// `profile_b`'s struct doc comment) — a client looks these up via
    /// `chaingammon::profile::profile_id_for` before building the settling
    /// PTB. Unlike agents, `HumanProfile` is a shared object (not owned), so
    /// either player or a sponsor can supply both `&mut HumanProfile`
    /// arguments regardless of who submits this transaction.
    public fun settle_cosigned_with_profiles(
        match_obj: &mut Match,
        winner: address,
        sig_a: vector<u8>,
        sig_b: vector<u8>,
        profile_a_obj: &mut HumanProfile,
        profile_b_obj: &mut HumanProfile,
        ctx: &mut TxContext,
    ) {
        assert!(option::is_some(&match_obj.profile_a), ENoProfilesRecorded);
        assert!(option::is_some(&match_obj.profile_b), ENoProfilesRecorded);
        assert!(*option::borrow(&match_obj.profile_a) == profile::id(profile_a_obj), EProfileMismatch);
        assert!(*option::borrow(&match_obj.profile_b) == profile::id(profile_b_obj), EProfileMismatch);

        let elo_a = profile::elo(profile_a_obj);
        let elo_b = profile::elo(profile_b_obj);
        let a_won = winner == match_obj.creator;

        settle_cosigned(match_obj, winner, sig_a, sig_b, ctx);

        let exp_a = elo::expected_score_pct(elo_a, elo_b);
        let exp_b = elo::expected_score_pct(elo_b, elo_a);
        profile::record_result(profile_a_obj, elo::new_rating(elo_a, exp_a, a_won));
        profile::record_result(profile_b_obj, elo::new_rating(elo_b, exp_b, !a_won));
    }

    /// Creator-only, OPEN-only refund — no timeout needed since nobody else
    /// has a stake in an unjoined match.
    public fun cancel_unjoined(match_obj: &mut Match, ctx: &mut TxContext) {
        assert!(match_obj.state == STATE_OPEN, EWrongState);
        assert!(tx_context::sender(ctx) == match_obj.creator, ENotCreator);

        match_obj.state = STATE_CANCELLED;
        let amount = balance::value(&match_obj.stake);
        let refund = balance::split(&mut match_obj.stake, amount);
        transfer::public_transfer(coin::from_balance(refund, ctx), match_obj.creator);

        event::emit(Cancelled { match_uid: object::id(match_obj), reason: b"unjoined" });
    }

    /// Permissionless griefing relief valve: once `ABANDON_EPOCHS` have
    /// passed since `join` with no settlement, ANYONE may call this to
    /// split the pot 50/50 between creator and joiner. Safe to leave
    /// permissionless — the split is fixed regardless of who calls it, and
    /// the epoch check prevents calling it early.
    public fun abandon(match_obj: &mut Match, ctx: &mut TxContext) {
        assert!(match_obj.state == STATE_PLAYING, EWrongState);
        let joined_at = *option::borrow(&match_obj.joined_epoch);
        assert!(tx_context::epoch(ctx) >= joined_at + ABANDON_EPOCHS, ETooEarly);

        match_obj.state = STATE_CANCELLED;
        let total = balance::value(&match_obj.stake);
        let half = total / 2;
        // Creator gets the extra unit on an odd total — arbitrary,
        // deterministic tie-break.
        let joiner_share = half;
        let creator_share = total - half;
        let joiner_balance = balance::split(&mut match_obj.stake, joiner_share);
        let creator_balance = balance::split(&mut match_obj.stake, creator_share);
        transfer::public_transfer(coin::from_balance(joiner_balance, ctx), match_obj.joiner);
        transfer::public_transfer(coin::from_balance(creator_balance, ctx), match_obj.creator);

        event::emit(Cancelled { match_uid: object::id(match_obj), reason: b"abandoned" });
    }

    // ── Read-only accessors ───────────────────────────────────────────────

    public fun uid(m: &Match): ID { object::id(m) }
    public fun app_match_id(m: &Match): vector<u8> { m.app_match_id }
    public fun state(m: &Match): u8 { m.state }
    public fun creator(m: &Match): address { m.creator }
    public fun joiner(m: &Match): address { m.joiner }
    public fun stake_value(m: &Match): u64 { balance::value(&m.stake) }
    public fun rated(m: &Match): bool { m.rated }
    public fun turn_index(m: &Match): u64 { m.turn_index }

    public fun state_open(): u8 { STATE_OPEN }
    public fun state_playing(): u8 { STATE_PLAYING }
    public fun state_settled(): u8 { STATE_SETTLED }
    public fun state_cancelled(): u8 { STATE_CANCELLED }
}
