// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Tournament
 * @notice ELO leaderboard contract for the decentralised backgammon RL swarm.
 *
 * Each agent starts at ELO 1500.  After a match, both agents co-sign the
 * result using EIP-712 structured data; either party can submit the
 * co-signed report.  Per-pair nonces prevent replay attacks.
 *
 * ELO formula (K=32, integer arithmetic):
 *   expected_A = 10000 / (10000 + 10^((elo_B - elo_A)/400))  [scaled ×10000]
 *   new_elo_A  = elo_A + 32 * (score_A/n - expected_A/10000)  [×SCALE]
 *
 * topN() returns up to N entries sorted by descending ELO (O(N·S) where S
 * is the number of registered agents — acceptable for hackathon scale).
 */
contract Tournament {
    // ── EIP-712 ──────────────────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant MATCH_TYPEHASH =
        keccak256("Match(address agentA,address agentB,uint8 scoreA,uint8 scoreB,uint256 nonce)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ── Storage ───────────────────────────────────────────────────────────────

    /// @dev ELO ratings, initialised to 1500 on first access.
    mapping(address => int32) public eloRating;

    /// @dev Replay protection: nonce per (agentA XOR agentB) pair key.
    mapping(bytes32 => uint256) public pairNonce;

    /// @dev Registry of agents that have ever played.
    address[] public agents;
    mapping(address => bool) private _known;

    uint32 private constant _ELO_START = 1500;
    int32  private constant _K         = 32;

    // ── Events ────────────────────────────────────────────────────────────────

    event MatchReported(
        address indexed agentA,
        address indexed agentB,
        uint8    scoreA,
        uint8    scoreB,
        int32    newEloA,
        int32    newEloB
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("Tournament"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _elo(address agent) internal view returns (int32) {
        int32 stored = eloRating[agent];
        return stored == 0 ? int32(_ELO_START) : stored;
    }

    function _register(address agent) internal {
        if (!_known[agent]) {
            _known[agent] = true;
            agents.push(agent);
            eloRating[agent] = int32(_ELO_START);
        }
    }

    /**
     * @dev Power of 10 scaled to integer arithmetic for ELO expected-score.
     *      Returns 10^(delta/400) × 10000 where delta = elo_B - elo_A.
     *      Uses a 5-step linear interpolation table for gas efficiency.
     */
    function _pow10scaled(int32 delta) internal pure returns (int32) {
        // Clamp to avoid extreme outcomes dominating forever.
        if (delta > 800)  return 63096;  // ~10^2 × 10000
        if (delta < -800) return     16;  // ~10^-2 × 10000
        // Approximation: 10^(x/400) ≈ e^(x*ln10/400)
        // ln10/400 ≈ 0.005756; e^y ≈ 1+y for small y.
        // We use a lookup-table approach with 200-point steps for precision.
        int32 abs_d = delta >= 0 ? delta : -delta;
        int32 p;
        if (abs_d <= 200)       p = 10000 + (abs_d * 1329) / 100;   // ×1.1329 per 200
        else if (abs_d <= 400)  p = 11329 + ((abs_d - 200) * 1523) / 100;
        else if (abs_d <= 600)  p = 12852 + ((abs_d - 400) * 1726) / 100;
        else                    p = 14578 + ((abs_d - 600) * 1957) / 100;
        return delta >= 0 ? p : int32(100_000_000) / p;
    }

    /**
     * @dev Update ELOs in-place.
     *      score_A is the number of wins for A out of n_games.
     */
    function _updateElo(
        address a,
        address b,
        uint8 scoreA,
        uint8 scoreB
    ) internal {
        uint8 n = scoreA + scoreB;
        if (n == 0) return;

        int32 eA = _elo(a);
        int32 eB = _elo(b);

        // expected_A = 10000 / (10000 + 10^((eB-eA)/400))
        int32 pow_b_over_a = _pow10scaled(eB - eA);
        int32 exp_a_scaled = int32(100_000_000) / (10000 + pow_b_over_a); // ×10000

        // delta_A = K * (actualA - expectedA) = K * (scoreA/n - exp_a_scaled/10000)
        // Scaled: K * (scoreA * 10000 - exp_a_scaled * n) / (n * 10000)
        int32 num_a = _K * (int32(uint32(scoreA)) * 10000 - exp_a_scaled * int32(uint32(n)));
        int32 delta_a = num_a / int32(uint32(n) * 10000);

        int32 new_elo_a = eA + delta_a;
        int32 new_elo_b = eB - delta_a;  // zero-sum

        eloRating[a] = new_elo_a;
        eloRating[b] = new_elo_b;
    }

    // ── EIP-712 signature verification ────────────────────────────────────────

    function _matchHash(
        address agentA,
        address agentB,
        uint8 scoreA,
        uint8 scoreB,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            MATCH_TYPEHASH,
            agentA,
            agentB,
            scoreA,
            scoreB,
            nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Tournament: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        require(v == 27 || v == 28, "Tournament: bad v");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "Tournament: invalid sig");
        return signer;
    }

    // ── Public functions ──────────────────────────────────────────────────────

    /**
     * @notice Report a co-signed match result and update ELO for both agents.
     * @param agentA  Address of agent A.
     * @param agentB  Address of agent B.
     * @param scoreA  Number of games won by agent A.
     * @param scoreB  Number of games won by agent B.
     * @param sigA    EIP-712 signature from agent A over (agentA,agentB,scoreA,scoreB,nonce).
     * @param sigB    EIP-712 signature from agent B over the same data.
     */
    function reportMatch(
        address agentA,
        address agentB,
        uint8   scoreA,
        uint8   scoreB,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        require(agentA != agentB, "Tournament: self-match");

        bytes32 pairKey = bytes32(uint256(uint160(agentA)) ^ uint256(uint160(agentB)));
        uint256 nonce   = pairNonce[pairKey];

        bytes32 hash = _matchHash(agentA, agentB, scoreA, scoreB, nonce);

        require(_recover(hash, sigA) == agentA, "Tournament: bad sig A");
        require(_recover(hash, sigB) == agentB, "Tournament: bad sig B");

        pairNonce[pairKey] = nonce + 1;

        _register(agentA);
        _register(agentB);
        _updateElo(agentA, agentB, scoreA, scoreB);

        emit MatchReported(agentA, agentB, scoreA, scoreB, eloRating[agentA], eloRating[agentB]);
    }

    /**
     * @notice Return the top *n* (address, elo) pairs sorted by descending ELO.
     *         O(agents.length × n) — fine for hackathon-scale leaderboards.
     */
    function topN(uint256 n)
        external
        view
        returns (address[] memory addrs, int32[] memory elos)
    {
        uint256 total = agents.length;
        if (n > total) n = total;

        addrs = new address[](n);
        elos  = new int32[](n);

        // Populate with first n entries.
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = agents[i];
            elos[i]  = _elo(agents[i]);
        }

        // Selection sort the rest.
        for (uint256 i = n; i < total; i++) {
            address a  = agents[i];
            int32   ea = _elo(a);
            // Find the position of the minimum in the result set.
            uint256 minIdx = 0;
            for (uint256 j = 1; j < n; j++) {
                if (elos[j] < elos[minIdx]) minIdx = j;
            }
            if (ea > elos[minIdx]) {
                addrs[minIdx] = a;
                elos[minIdx]  = ea;
            }
        }

        // Bubble sort the result set descending.
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (elos[j] > elos[i]) {
                    (addrs[i], addrs[j]) = (addrs[j], addrs[i]);
                    (elos[i],  elos[j])  = (elos[j],  elos[i]);
                }
            }
        }
    }

    /// @notice Return the number of registered agents.
    function agentCount() external view returns (uint256) {
        return agents.length;
    }
}
