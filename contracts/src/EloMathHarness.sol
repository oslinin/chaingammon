// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EloMath.sol";

/// @notice Test-only wrapper exposing EloMath library functions externally.
contract EloMathHarness {
    function K() external pure returns (int256) {
        return EloMath.K;
    }

    function INITIAL() external pure returns (uint256) {
        return EloMath.INITIAL;
    }

    function expectedScorePct(int256 ratingA, int256 ratingB) external pure returns (uint256) {
        return EloMath.expectedScorePct(ratingA, ratingB);
    }

    function newRating(uint256 currentRating, uint256 expectedPct, bool won) external pure returns (uint256) {
        return EloMath.newRating(currentRating, expectedPct, won);
    }
}
