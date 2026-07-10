#[test_only]
/// Tests for chaingammon::agent (Task 2; Task 7 adds seal_approve). Abort
/// codes are asserted as raw literals rather than `agent::ENotOwner` etc. —
/// Move constants are private to their declaring module (there is no
/// `public const`), so a separate test module can't reference them by
/// path. The mapping:
///   0 = ENotOwner, 1 = EInsufficientBalance, 2 = EZeroAmount, 3 = ENoAccess
/// (see sui/move/chaingammon/sources/agent.move's Errors section).
module chaingammon::agent_tests {
    use sui::coin;
    use sui::sui::SUI;
    use sui::test_scenario;

    use chaingammon::agent::{Self, Agent};

    const OWNER: address = @0xA11CE;
    const OTHER: address = @0xB0B;

    #[test]
    fun mint_sets_expected_fields() {
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let a = agent::new(b"gnubg-classic", 1, ctx);

        assert!(agent::owner(&a) == OWNER, 0);
        assert!(agent::tier(&a) == 1, 1);
        assert!(agent::elo(&a) == 1500, 2); // chaingammon::elo::initial()
        assert!(agent::match_count(&a) == 0, 3);
        assert!(agent::experience_version(&a) == 0, 4);
        assert!(agent::bankroll_value(&a) == 0, 5);
        assert!(!agent::has_weights(&a), 6);

        transfer::public_transfer(a, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    fun deposit_and_withdraw_round_trip() {
        let mut scenario = test_scenario::begin(OWNER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"agent", 0, ctx);
            transfer::public_transfer(a, OWNER);
        };

        test_scenario::next_tx(&mut scenario, OWNER);
        {
            let mut a = test_scenario::take_from_sender<Agent>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let payment = coin::mint_for_testing<SUI>(1000, ctx);
            agent::deposit(&mut a, payment, ctx);
            assert!(agent::bankroll_value(&a) == 1000, 0);

            let out = agent::withdraw(&mut a, 400, ctx);
            assert!(coin::value(&out) == 400, 1);
            assert!(agent::bankroll_value(&a) == 600, 2);

            transfer::public_transfer(out, OWNER);
            test_scenario::return_to_sender(&scenario, a);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 1)] // EInsufficientBalance
    fun withdraw_more_than_balance_aborts() {
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut a = agent::new(b"agent", 0, ctx);

        // Bankroll is 0 — any positive withdrawal must abort.
        let out = agent::withdraw(&mut a, 1, ctx);

        transfer::public_transfer(out, OWNER);
        transfer::public_transfer(a, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 0)] // ENotOwner
    fun non_owner_cannot_withdraw() {
        let mut scenario = test_scenario::begin(OWNER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"agent", 0, ctx);
            transfer::public_transfer(a, OWNER);
        };

        test_scenario::next_tx(&mut scenario, OTHER);
        {
            // test_scenario::take_from_address is a test-only escape hatch —
            // on the real network OTHER's transaction could never reference
            // OWNER's owned object at all. This test exists to prove
            // agent::withdraw's OWN `agent.owner` check is what blocks the
            // call (not Sui's native object-custody rule), since that field
            // check is the only enforcement left once an Agent moves into a
            // Kiosk (Task 8), where Sui-level custody belongs to the Kiosk.
            let mut a = test_scenario::take_from_address<Agent>(&scenario, OWNER);
            let ctx = test_scenario::ctx(&mut scenario);

            let out = agent::withdraw(&mut a, 0, ctx); // amount irrelevant — owner check fires first

            transfer::public_transfer(out, OTHER);
            test_scenario::return_to_address(OWNER, a);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun set_weights_records_blob_ref() {
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut a = agent::new(b"agent", 0, ctx);

        assert!(!agent::has_weights(&a), 0);
        agent::set_weights(&mut a, b"walrus-blob-id", b"content-hash", ctx);
        assert!(agent::has_weights(&a), 1);

        transfer::public_transfer(a, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 0)] // ENotOwner
    fun non_owner_cannot_set_weights() {
        let mut scenario = test_scenario::begin(OWNER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"agent", 0, ctx);
            transfer::public_transfer(a, OWNER);
        };

        test_scenario::next_tx(&mut scenario, OTHER);
        {
            let mut a = test_scenario::take_from_address<Agent>(&scenario, OWNER);
            let ctx = test_scenario::ctx(&mut scenario);
            agent::set_weights(&mut a, b"blob", b"hash", ctx);
            test_scenario::return_to_address(OWNER, a);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun record_result_bumps_elo_and_match_count() {
        // record_result is `public(package)` — callable directly from any
        // module in the same `chaingammon` package, which this test module
        // is, so no test-only wrapper is needed on the agent.move side.
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut a = agent::new(b"agent", 0, ctx);

        agent::record_result(&mut a, 1516);
        assert!(agent::elo(&a) == 1516, 0);
        assert!(agent::match_count(&a) == 1, 1);

        agent::record_result(&mut a, 1500);
        assert!(agent::elo(&a) == 1500, 2);
        assert!(agent::match_count(&a) == 2, 3);

        transfer::public_transfer(a, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    fun seal_approve_succeeds_for_owner_with_matching_id() {
        // seal_approve is `public(package) entry` — callable directly from
        // this test module (same package), the same pattern
        // game_match_tests.move uses for game_match::roll. A real Seal key
        // server instead dry-runs a PTB calling this via the app/script;
        // this test exercises the exact same logic without needing a live
        // key server (untestable from this sandbox — see the Task 7
        // CHANGELOG/README entries).
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let a = agent::new(b"agent", 0, ctx);
        let agent_id = agent::id(&a);

        agent::seal_approve(object::id_to_bytes(&agent_id), &a, ctx);

        transfer::public_transfer(a, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 3)] // ENoAccess
    fun seal_approve_rejects_mismatched_id() {
        // A caller who owns `a` but requests approval under a DIFFERENT
        // identity (e.g. another Agent's id) must be denied — otherwise
        // owning any one Agent would unlock every Agent's weights blob.
        let mut scenario = test_scenario::begin(OWNER);
        let ctx = test_scenario::ctx(&mut scenario);
        let a = agent::new(b"agent", 0, ctx);
        let other = agent::new(b"other-agent", 0, ctx);
        let other_id = agent::id(&other);

        agent::seal_approve(object::id_to_bytes(&other_id), &a, ctx);

        transfer::public_transfer(a, OWNER);
        transfer::public_transfer(other, OWNER);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 3)] // ENoAccess
    fun seal_approve_rejects_non_owner() {
        let mut scenario = test_scenario::begin(OWNER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"agent", 0, ctx);
            transfer::public_transfer(a, OWNER);
        };

        test_scenario::next_tx(&mut scenario, OTHER);
        {
            let a = test_scenario::take_from_address<Agent>(&scenario, OWNER);
            let ctx = test_scenario::ctx(&mut scenario);
            let agent_id = agent::id(&a);

            agent::seal_approve(object::id_to_bytes(&agent_id), &a, ctx);

            test_scenario::return_to_address(OWNER, a);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun claim_ownership_syncs_owner_to_new_holder() {
        // Models the real post-trade flow (Task 8): the Agent is
        // legitimately transferred to OTHER (mirroring what
        // kiosk::purchase + confirm_request hands the buyer), then OTHER
        // — now the genuine Sui-level holder, via take_from_sender, not
        // the take_from_address escape hatch used in the non-owner tests
        // above — calls claim_ownership on their own object.
        let mut scenario = test_scenario::begin(OWNER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let a = agent::new(b"agent", 0, ctx);
            assert!(agent::owner(&a) == OWNER, 0);
            transfer::public_transfer(a, OTHER);
        };

        test_scenario::next_tx(&mut scenario, OTHER);
        {
            let mut a = test_scenario::take_from_sender<Agent>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            agent::claim_ownership(&mut a, ctx);
            assert!(agent::owner(&a) == OTHER, 1);

            // The synced owner field is what set_weights/seal_approve/
            // withdraw now check — prove OTHER (not the original OWNER)
            // can exercise an owner-gated function post-claim.
            agent::set_weights(&mut a, b"blob", b"hash", ctx);
            assert!(agent::has_weights(&a), 2);

            test_scenario::return_to_sender(&scenario, a);
        };
        test_scenario::end(scenario);
    }
}
