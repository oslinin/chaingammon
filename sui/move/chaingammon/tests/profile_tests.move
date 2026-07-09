#[test_only]
/// Tests for chaingammon::profile (Task 5). Abort codes are asserted as raw
/// literals — see agent_tests.move's header comment for why (Move constants
/// are private to their declaring module). The mapping:
///   0 = EProfileAlreadyExists
/// (see sui/move/chaingammon/sources/profile.move's Errors section).
module chaingammon::profile_tests {
    use sui::test_scenario;

    use chaingammon::profile::{Self, HumanProfile};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;

    #[test]
    fun create_profile_sets_expected_fields() {
        let mut scenario = test_scenario::begin(ALICE);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut registry = profile::new_registry_for_testing(ctx);

        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"alice", ctx);
        };

        assert!(profile::has_profile(&registry, ALICE), 0);
        assert!(!profile::has_profile(&registry, BOB), 1);

        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let p = test_scenario::take_shared<HumanProfile>(&scenario);
            assert!(profile::owner(&p) == ALICE, 2);
            assert!(profile::elo(&p) == 1500, 3);
            assert!(profile::match_count(&p) == 0, 4);
            assert!(profile::id(&p) == profile::profile_id_for(&registry, ALICE), 5);
            test_scenario::return_shared(p);
        };

        transfer::share_object(registry);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 0)] // EProfileAlreadyExists
    fun create_profile_twice_aborts() {
        let mut scenario = test_scenario::begin(ALICE);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut registry = profile::new_registry_for_testing(ctx);

        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"alice", ctx);
        };
        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"alice-again", ctx);
        };

        transfer::share_object(registry);
        test_scenario::end(scenario);
    }

    #[test]
    fun record_result_bumps_elo_and_match_count() {
        // record_result is `public(package)` — callable directly from any
        // module in the same package, mirroring agent_tests.move's test of
        // agent::record_result.
        let mut scenario = test_scenario::begin(ALICE);
        let ctx = test_scenario::ctx(&mut scenario);
        let mut registry = profile::new_registry_for_testing(ctx);

        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            profile::create_profile(&mut registry, b"alice", ctx);
        };

        test_scenario::next_tx(&mut scenario, ALICE);
        {
            let mut p = test_scenario::take_shared<HumanProfile>(&scenario);
            profile::record_result(&mut p, 1516);
            assert!(profile::elo(&p) == 1516, 0);
            assert!(profile::match_count(&p) == 1, 1);

            profile::record_result(&mut p, 1500);
            assert!(profile::elo(&p) == 1500, 2);
            assert!(profile::match_count(&p) == 2, 3);
            test_scenario::return_shared(p);
        };

        transfer::share_object(registry);
        test_scenario::end(scenario);
    }
}
