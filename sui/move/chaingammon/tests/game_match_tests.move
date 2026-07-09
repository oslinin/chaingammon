#[test_only]
/// Tests for chaingammon::game_match (Task 3, extended in Task 5 for the
/// HumanProfile ELO hook). Abort codes are asserted as raw literals — see
/// agent_tests.move's header comment for why (Move constants are private to
/// their declaring module). The mapping:
///   0 EWrongState, 1 EBadSigA, 2 EBadSigB, 3 EInvalidWinner,
///   4 EZeroStake, 5 EStakeMismatch, 6 ECannotJoinOwnMatch,
///   7 ENotCreator, 8 ETooEarly, 9 ENoAgentsRecorded, 10 EAgentMismatch,
///   11 ENoProfilesRecorded, 12 EProfileMismatch
/// (see sui/move/chaingammon/sources/game_match.move's Errors section).
///
/// SESSION_PK_A/B, SIG_A/B, CREATOR, APP_MATCH_ID, DOMAIN below were
/// generated (not hand-derived) by `node --experimental-strip-types
/// sui/scripts/gen_fixtures.ts`, run against real @mysten/sui Ed25519
/// keypairs, and are real, independently-computed ed25519 signatures over
/// the exact BCS-encoded bytes chaingammon::game_match's ResultMsg produces for
/// (domain, app_match_id="chaingammon-test-match-001", winner=@0xA11CE) --
/// matching the OWNER constant in agent_tests.move. Only the Move-side
/// reconstruction (bcs::to_bytes + ed25519_verify) is unverified until CI
/// runs `sui move test`; the TS-side signing was actually executed, not
/// guessed.
module chaingammon::game_match_tests {
    use sui::coin;
    use sui::sui::SUI;
    use sui::test_scenario;

    use chaingammon::agent::{Self, Agent};
    use chaingammon::game_match::{Self, Match};
    use chaingammon::profile::{Self, HumanProfile, ProfileRegistry};

    const CREATOR: address = @0xA11CE; // matches agent_tests.move's OWNER
    const JOINER: address = @0xB0B;    // matches agent_tests.move's OTHER
    const STAKE: u64 = 1000;

    const APP_MATCH_ID: vector<u8> = b"chaingammon-test-match-001";
    // The fixture generator signed against winner=@0xA11CE, i.e. CREATOR --
    // use CREATOR directly below rather than a second constant, so nothing
    // depends on `@0xA11CE` and `@0xa11ce` being the same address (they are,
    // Move hex address literals are case-insensitive, but there's no reason
    // to lean on that when reusing CREATOR is just as clear and removes the
    // question entirely).
    const SESSION_PK_A: vector<u8> =
        x"bc7cbcb5636375fa1d82434d466724d92377f53b980695dd49d26d0ce12205a5";
    const SESSION_PK_B: vector<u8> =
        x"55154f42065ea5a1bea05463826be2684eb92df92c100027aabaae57ca554207";
    const SIG_A: vector<u8> =
        x"5552061e76944ef7d996cf4faa65320ba6ff486b142df185aa8a040fec313f0de0841145c39659fa9e1319952834db8975dda8fa87f13a30d049f8dce4089606";
    const SIG_B: vector<u8> =
        x"baf49730fbd8a7680c89bd32a141c6fedc82cbef9a5da3efa20a85cffd8fdcfefb53d3e5d71f2c584806e43e74e2fbea240594d1466eb7aab9140957ce2cd300";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Opens (as CREATOR) and joins (as JOINER) a rated match with equal
    /// STAKE on both sides and the fixture session pubkeys, leaving it in
    /// state PLAYING and available via test_scenario::take_shared.
    fun open_and_join(scenario: &mut test_scenario::Scenario) {
        test_scenario::next_tx(scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(stake, SESSION_PK_A, true, APP_MATCH_ID, option::none(), option::none(), ctx);
        };
        test_scenario::next_tx(scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(scenario);
            let ctx = test_scenario::ctx(scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::join(&mut m, stake, SESSION_PK_B, option::none(), option::none(), ctx);
            test_scenario::return_shared(m);
        };
    }

    // ── Happy path ────────────────────────────────────────────────────────

    #[test]
    fun happy_path_open_join_settle_winner_gets_full_pot() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            assert!(game_match::state(&m) == game_match::state_playing(), 0);
            assert!(game_match::stake_value(&m) == STAKE * 2, 1);

            let ctx = test_scenario::ctx(&mut scenario);
            game_match::settle_cosigned(&mut m, CREATOR, SIG_A, SIG_B, ctx);
            assert!(game_match::state(&m) == game_match::state_settled(), 2);
            assert!(game_match::stake_value(&m) == 0, 3);
            test_scenario::return_shared(m);
        };

        // Winner (CREATOR) received a Coin<SUI> worth 2x the per-side stake.
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let payout = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&payout) == STAKE * 2, 0);
            transfer::public_transfer(payout, CREATOR);
        };
        test_scenario::end(scenario);
    }

    // ── Signature verification ───────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = 1)] // EBadSigA
    fun wrong_sig_a_aborts() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // SIG_B was signed by session B's key, not A's.
            game_match::settle_cosigned(&mut m, CREATOR, SIG_B, SIG_B, ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 2)] // EBadSigB
    fun wrong_sig_b_aborts() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // sig_a (SIG_A) verifies fine; sig_b is SIG_A too, signed by
            // session A's key rather than B's — this is the "one right,
            // one wrong" case: the first assert alone would not catch it.
            game_match::settle_cosigned(&mut m, CREATOR, SIG_A, SIG_A, ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 0)] // EWrongState
    fun double_settle_aborts() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            game_match::settle_cosigned(&mut m, CREATOR, SIG_A, SIG_B, ctx);
            // Second call: state is now SETTLED, not PLAYING.
            game_match::settle_cosigned(&mut m, CREATOR, SIG_A, SIG_B, ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    // ── Join / stake validation ───────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = 5)] // EStakeMismatch
    fun unequal_stake_join_aborts() {
        let mut scenario = test_scenario::begin(CREATOR);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(stake, SESSION_PK_A, true, APP_MATCH_ID, option::none(), option::none(), ctx);
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE / 2, ctx); // half the required stake
            game_match::join(&mut m, stake, SESSION_PK_B, option::none(), option::none(), ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 6)] // ECannotJoinOwnMatch
    fun creator_cannot_join_own_match() {
        let mut scenario = test_scenario::begin(CREATOR);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(stake, SESSION_PK_A, true, APP_MATCH_ID, option::none(), option::none(), ctx);
        };
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::join(&mut m, stake, SESSION_PK_B, option::none(), option::none(), ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    // ── Cancellation / timeout ───────────────────────────────────────────

    #[test]
    fun cancel_unjoined_refunds_creator() {
        let mut scenario = test_scenario::begin(CREATOR);
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(stake, SESSION_PK_A, true, APP_MATCH_ID, option::none(), option::none(), ctx);
        };
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            game_match::cancel_unjoined(&mut m, ctx);
            assert!(game_match::state(&m) == game_match::state_cancelled(), 0);
            test_scenario::return_shared(m);
        };
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let refund = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&refund) == STAKE, 0);
            transfer::public_transfer(refund, CREATOR);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 8)] // ETooEarly
    fun abandon_before_timeout_aborts() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            game_match::abandon(&mut m, ctx);
            test_scenario::return_shared(m);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun abandon_after_timeout_splits_pot() {
        let mut scenario = test_scenario::begin(CREATOR);
        open_and_join(&mut scenario);

        // Advance 7 epochs so ABANDON_EPOCHS has elapsed since join.
        let mut i = 0;
        while (i < 7) {
            test_scenario::next_epoch(&mut scenario, JOINER);
            i = i + 1;
        };

        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            game_match::abandon(&mut m, ctx);
            assert!(game_match::state(&m) == game_match::state_cancelled(), 0);
            assert!(game_match::stake_value(&m) == 0, 1);
            test_scenario::return_shared(m);
        };

        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let joiner_share = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&joiner_share) == STAKE, 0); // even total: exact half
            transfer::public_transfer(joiner_share, JOINER);
        };
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let creator_share = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&creator_share) == STAKE, 0);
            transfer::public_transfer(creator_share, CREATOR);
        };
        test_scenario::end(scenario);
    }

    // ── Agent ELO wiring ───────────────────────────────────────────────

    #[test]
    fun settle_with_agents_updates_both_elos() {
        let mut scenario = test_scenario::begin(CREATOR);

        // Mint one agent per side, owned by CREATOR/JOINER respectively.
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"creator-agent", 0, ctx);
            transfer::public_transfer(a, CREATOR);
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"joiner-agent", 0, ctx);
            transfer::public_transfer(a, JOINER);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        let agent_a_id = {
            let a = test_scenario::take_from_sender<Agent>(&scenario);
            let id = agent::id(&a);
            test_scenario::return_to_sender(&scenario, a);
            id
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        let agent_b_id = {
            let a = test_scenario::take_from_sender<Agent>(&scenario);
            let id = agent::id(&a);
            test_scenario::return_to_sender(&scenario, a);
            id
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(stake, SESSION_PK_A, true, APP_MATCH_ID, option::some(agent_a_id), option::none(), ctx);
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::join(&mut m, stake, SESSION_PK_B, option::some(agent_b_id), option::none(), ctx);
            test_scenario::return_shared(m);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let mut agent_a_obj = test_scenario::take_from_address<Agent>(&scenario, CREATOR);
            let mut agent_b_obj = test_scenario::take_from_address<Agent>(&scenario, JOINER);
            let ctx = test_scenario::ctx(&mut scenario);

            game_match::settle_cosigned_with_agents(
                &mut m, CREATOR, SIG_A, SIG_B, &mut agent_a_obj, &mut agent_b_obj, ctx,
            );

            // Winner is CREATOR, so agent_a (the creator's agent) won: equal
            // starting ratings (1500 each) -> gains K/2 = 16; the loser
            // drops by the same amount, mirroring elo_tests.move's own
            // equal-ratings vectors.
            assert!(agent::elo(&agent_a_obj) == 1516, 0);
            assert!(agent::elo(&agent_b_obj) == 1484, 1);
            assert!(agent::match_count(&agent_a_obj) == 1, 2);
            assert!(agent::match_count(&agent_b_obj) == 1, 3);

            test_scenario::return_shared(m);
            test_scenario::return_to_address(CREATOR, agent_a_obj);
            test_scenario::return_to_address(JOINER, agent_b_obj);
        };

        // Consume the settlement payout so the scenario ends cleanly.
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let payout = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            transfer::public_transfer(payout, CREATOR);
        };
        test_scenario::end(scenario);
    }

    // ── Human profile ELO wiring (Task 5) ────────────────────────────────

    #[test]
    fun settle_with_profiles_updates_both_elos() {
        let mut scenario = test_scenario::begin(CREATOR);
        let ctx = test_scenario::ctx(&mut scenario);
        let registry_id = profile::new_registry_for_testing(ctx);

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut registry = test_scenario::take_shared_by_id<ProfileRegistry>(&scenario, registry_id);
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"creator", ctx);
            test_scenario::return_shared(registry);
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut registry = test_scenario::take_shared_by_id<ProfileRegistry>(&scenario, registry_id);
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"joiner", ctx);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        let profile_a_id = {
            let registry = test_scenario::take_shared_by_id<ProfileRegistry>(&scenario, registry_id);
            let id = profile::profile_id_for(&registry, CREATOR);
            test_scenario::return_shared(registry);
            id
        };
        test_scenario::next_tx(&mut scenario, CREATOR);
        let profile_b_id = {
            let registry = test_scenario::take_shared_by_id<ProfileRegistry>(&scenario, registry_id);
            let id = profile::profile_id_for(&registry, JOINER);
            test_scenario::return_shared(registry);
            id
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::open(
                stake, SESSION_PK_A, true, APP_MATCH_ID,
                option::none(), option::some(profile_a_id), ctx,
            );
        };
        test_scenario::next_tx(&mut scenario, JOINER);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let stake = coin::mint_for_testing<SUI>(STAKE, ctx);
            game_match::join(
                &mut m, stake, SESSION_PK_B,
                option::none(), option::some(profile_b_id), ctx,
            );
            test_scenario::return_shared(m);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut m = test_scenario::take_shared<Match>(&scenario);
            // Two HumanProfile shared objects exist by this point (one per
            // side) — take_shared<T> can't disambiguate between same-type
            // shared objects, so fetch each by its specific id instead.
            let mut profile_a_obj = test_scenario::take_shared_by_id<HumanProfile>(&scenario, profile_a_id);
            let mut profile_b_obj = test_scenario::take_shared_by_id<HumanProfile>(&scenario, profile_b_id);
            let ctx = test_scenario::ctx(&mut scenario);

            game_match::settle_cosigned_with_profiles(
                &mut m, CREATOR, SIG_A, SIG_B, &mut profile_a_obj, &mut profile_b_obj, ctx,
            );

            // Same equal-starting-ratings vectors as the agent test above.
            assert!(profile::elo(&profile_a_obj) == 1516, 0);
            assert!(profile::elo(&profile_b_obj) == 1484, 1);
            assert!(profile::match_count(&profile_a_obj) == 1, 2);
            assert!(profile::match_count(&profile_b_obj) == 1, 3);

            test_scenario::return_shared(m);
            test_scenario::return_shared(profile_a_obj);
            test_scenario::return_shared(profile_b_obj);
        };

        // Consume the settlement payout so the scenario ends cleanly.
        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let payout = test_scenario::take_from_sender<coin::Coin<SUI>>(&scenario);
            transfer::public_transfer(payout, CREATOR);
        };
        test_scenario::end(scenario);
    }
}
