#[test_only]
/// Parity tests for chaingammon::elo against contracts/src/EloMath.sol.
/// Every vector below was independently computed by replicating EloMath's
/// exact integer semantics (piecewise table + truncate-toward-zero signed
/// division) in Python — not just eyeballed against the looser `within()`
/// ranges in contracts/test/phase2_EloMath.test.js — so these assert exact
/// equality rather than a tolerance band. See docs/superpowers/plans/
/// 2026-07-08-sui-port.md Task 1 for how the vectors were derived.
module chaingammon::elo_tests {
    use chaingammon::elo;

    #[test]
    fun constants_match_evm() {
        assert!(elo::k() == 32, 0);
        assert!(elo::initial() == 1500, 1);
    }

    // ── expected_score_pct ──────────────────────────────────────────────

    #[test]
    fun expected_equal_ratings_is_50() {
        assert!(elo::expected_score_pct(1500, 1500) == 50, 0);
    }

    #[test]
    fun expected_higher_by_100_is_64() {
        assert!(elo::expected_score_pct(1600, 1500) == 64, 0);
    }

    #[test]
    fun expected_higher_by_400_is_91() {
        assert!(elo::expected_score_pct(1900, 1500) == 91, 0);
    }

    #[test]
    fun expected_lower_by_100_is_36() {
        assert!(elo::expected_score_pct(1500, 1600) == 36, 0);
    }

    #[test]
    fun expected_large_gap_clamps_high() {
        assert!(elo::expected_score_pct(2500, 1000) == 99, 0);
    }

    #[test]
    fun expected_large_gap_clamps_low() {
        assert!(elo::expected_score_pct(1000, 2500) == 1, 0);
    }

    #[test]
    fun expected_exact_minus_800_boundary_clamps() {
        // diff == -800 exactly: EloMath's `diff <= -800` branch, not the
        // table lookup — this is the boundary the sign/magnitude split in
        // expected_score_pct must hit without underflowing.
        assert!(elo::expected_score_pct(1500, 2300) == 1, 0);
    }

    #[test]
    fun expected_exact_plus_800_boundary_clamps() {
        assert!(elo::expected_score_pct(2300, 1500) == 99, 0);
    }

    #[test]
    fun expected_small_diff_interpolates() {
        // diff = 10 -> shifted = 810 -> idx 16, rem 10 -> interpolate
        // between table[16]=50 and table[17]=57: 50 + (57-50)*10/50 = 51.
        assert!(elo::expected_score_pct(1510, 1500) == 51, 0);
    }

    // ── new_rating ──────────────────────────────────────────────────────

    #[test]
    fun new_rating_equal_win_gains_half_k() {
        assert!(elo::new_rating(1500, 50, true) == 1516, 0);
    }

    #[test]
    fun new_rating_equal_loss_loses_half_k() {
        assert!(elo::new_rating(1500, 50, false) == 1484, 0);
    }

    #[test]
    fun new_rating_favorite_winning_gains_little() {
        assert!(elo::new_rating(1900, 91, true) == 1902, 0);
    }

    #[test]
    fun new_rating_underdog_winning_gains_a_lot() {
        assert!(elo::new_rating(1500, 9, true) == 1529, 0);
    }

    #[test]
    fun new_rating_floors_at_zero() {
        assert!(elo::new_rating(10, 50, false) == 0, 0);
    }

    #[test]
    fun new_rating_zero_stays_zero_on_loss() {
        assert!(elo::new_rating(0, 50, false) == 0, 0);
    }

    #[test]
    fun new_rating_max_loss_vs_certain_opponent() {
        assert!(elo::new_rating(1500, 100, false) == 1468, 0);
    }

    #[test]
    fun new_rating_max_gain_as_certain_underdog() {
        assert!(elo::new_rating(1500, 0, true) == 1532, 0);
    }

    // ── symmetry: winner gain == loser loss ──────────────────────────────

    #[test]
    fun symmetry_equal_ratings_sum_unchanged() {
        let winner_new = elo::new_rating(1500, 50, true);
        let loser_new = elo::new_rating(1500, 50, false);
        assert!(winner_new + loser_new == 3000, 0);
    }

    #[test]
    fun symmetry_400_gap_upset_sum_unchanged() {
        let winner_exp = elo::expected_score_pct(1500, 1900); // 9
        let loser_exp = elo::expected_score_pct(1900, 1500);  // 91
        assert!(winner_exp == 9, 0);
        assert!(loser_exp == 91, 1);
        let winner_new = elo::new_rating(1500, winner_exp, true);
        let loser_new = elo::new_rating(1900, loser_exp, false);
        assert!(winner_new == 1529, 2);
        assert!(loser_new == 1871, 3);
        assert!(winner_new + loser_new == 3400, 4);
    }
}
