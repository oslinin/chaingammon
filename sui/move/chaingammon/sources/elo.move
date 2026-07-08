/// elo.move — pure ELO rating math, ported from contracts/src/EloMath.sol.
///
/// Move has no native signed integer type, so every place the Solidity
/// source does signed arithmetic (rating differences, the win/loss delta)
/// is rewritten as an explicit (is_negative: bool, magnitude: u64) pair and
/// recombined at the end. The control flow and constants are otherwise a
/// line-for-line mirror of EloMath.sol so the two can be diffed by eye.
///
/// No objects, no state — Task 2/3 (agent.move, match.move) call these as
/// plain functions when settling a match.
module chaingammon::elo {
    use std::vector;

    const K: u64 = 32;
    const INITIAL: u64 = 1500;

    public fun k(): u64 { K }
    public fun initial(): u64 { INITIAL }

    /// The same 33-entry piecewise-linear lookup table as EloMath.sol's
    /// `table` local. Not a module `const` — vector<u64> constants are a
    /// newer Move feature this port avoids relying on, since the toolchain
    /// could not be verified locally when this was written (see
    /// sui/README.md). Rebuilt on each call; the table is 33 u64s, trivial
    /// cost next to the rest of a match-settlement transaction.
    fun lookup_table(): vector<u64> {
        vector[
            1, 1, 2, 2, 3, 4, 5, 7, 9, 12, 15, 19, 24, 30, 36, 43,
            50,
            57, 64, 70, 76, 81, 85, 88, 91, 93, 95, 96, 97, 98, 98, 99, 99,
        ]
    }

    /// Expected score for player A as a percentage (0-100). Mirrors
    /// EloMath.expectedScorePct: E_a = 1 / (1 + 10^((R_b - R_a)/400)),
    /// evaluated via the 33-point lookup table above.
    public fun expected_score_pct(rating_a: u64, rating_b: u64): u64 {
        // diff = rating_a - rating_b, kept as (is_negative, magnitude)
        // since u64 cannot represent a negative value directly.
        let (diff_neg, diff_mag) = if (rating_a >= rating_b) {
            (false, rating_a - rating_b)
        } else {
            (true, rating_b - rating_a)
        };

        // Solidity: `if (diff <= -800) return 1; if (diff >= 800) return 99;`
        if (diff_mag >= 800) {
            return if (diff_neg) { 1 } else { 99 }
        };

        // shifted = diff + 800, computed from the sign/magnitude split.
        // diff_mag < 800 here (the >= 800 case returned above), so this
        // never underflows.
        let shifted: u64 = if (diff_neg) { 800 - diff_mag } else { 800 + diff_mag };
        let idx: u64 = shifted / 50;
        let rem: u64 = shifted % 50;

        let table = lookup_table();
        if (rem == 0 || idx == 32) {
            return *vector::borrow(&table, idx)
        };

        let lo = *vector::borrow(&table, idx);
        let hi = *vector::borrow(&table, idx + 1);
        if (hi >= lo) {
            lo + ((hi - lo) * rem) / 50
        } else {
            lo - ((lo - hi) * rem) / 50
        }
    }

    /// New rating after a match. Mirrors EloMath.newRating:
    /// delta = K * (S - E) / 100, where S = 100 if won else 0, E =
    /// expected_pct. Floors at 0 — a rating can never go negative.
    public fun new_rating(current_rating: u64, expected_pct: u64, won: bool): u64 {
        let actual: u64 = if (won) { 100 } else { 0 };

        // (actual - expected_pct), sign/magnitude split — this is the
        // Move equivalent of Solidity's `int256 actual - int256(expectedPct)`.
        let (diff_neg, diff_mag) = if (actual >= expected_pct) {
            (false, actual - expected_pct)
        } else {
            (true, expected_pct - actual)
        };

        // Splitting the sign out before dividing makes this integer
        // division equivalent to Solidity's truncate-toward-zero signed
        // division — both round the magnitude down, then reapply the sign.
        let delta_mag: u64 = (K * diff_mag) / 100;

        if (!diff_neg) {
            current_rating + delta_mag
        } else if (delta_mag >= current_rating) {
            0
        } else {
            current_rating - delta_mag
        }
    }
}
