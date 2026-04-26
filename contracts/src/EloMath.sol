// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library EloMath {
    int256 internal constant K = 32;
    uint256 internal constant INITIAL = 1500;

    /// @notice Expected score for player A as percentage 0-100.
    ///         E_a = 1 / (1 + 10^((R_b - R_a)/400)), evaluated by piecewise
    ///         linear interpolation of a 50-point lookup table.
    function expectedScorePct(int256 ratingA, int256 ratingB) internal pure returns (uint256) {
        int256 diff = ratingA - ratingB;
        if (diff <= -800) return 1;
        if (diff >= 800) return 99;

        int256 shifted = diff + 800;       // 0..1600
        uint256 idx = uint256(shifted) / 50; // 0..32
        uint256 rem = uint256(shifted) % 50; // 0..49

        uint8[33] memory table = [
            1, 1, 2, 2, 3, 4, 5, 7, 9, 12, 15, 19, 24, 30, 36, 43,
            50,
            57, 64, 70, 76, 81, 85, 88, 91, 93, 95, 96, 97, 98, 98, 99, 99
        ];

        if (rem == 0 || idx == 32) return uint256(table[idx]);

        uint256 lo = uint256(table[idx]);
        uint256 hi = uint256(table[idx + 1]);
        // linear interp: lo + (hi - lo) * rem / 50, signed-safely
        if (hi >= lo) {
            return lo + ((hi - lo) * rem) / 50;
        } else {
            return lo - ((lo - hi) * rem) / 50;
        }
    }

    /// @notice New rating after a match. delta = K * (S - E) / 100, where
    ///         S = 100 if won else 0, E is expectedPct (0-100). Floors at 0.
    function newRating(uint256 currentRating, uint256 expectedPct, bool won) internal pure returns (uint256) {
        int256 actual = won ? int256(100) : int256(0);
        int256 delta = (K * (actual - int256(expectedPct))) / int256(100);

        if (delta >= 0) {
            return currentRating + uint256(delta);
        }
        uint256 decrease = uint256(-delta);
        if (decrease >= currentRating) return 0;
        return currentRating - decrease;
    }
}
