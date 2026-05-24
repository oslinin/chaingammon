// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./EloMath.sol";

/// @dev The slice of MatchEscrow's API that MatchRegistry calls. Defined
///      inline so MatchRegistry doesn't depend on the full escrow source
///      tree (and so the wiring can later target a different escrow
///      implementation that conforms to this slice).
interface IMatchEscrow {
    function payoutSplit(
        bytes32 matchId,
        address[] calldata winners,
        uint256[] calldata shares
    ) external;
}

/// @title MatchRegistry — records backgammon matches and updates ELO.
/// @dev Two settlement paths:
///
///      1. `recordMatch` (owner-only) — used by the server or KeeperHub
///         workflow for trusted settlement. v1 trust boundary.
///
///      2. `settle` / `settleAndSplit` (permissionless) — trustless
///         session-key state channel. Handles both human-vs-agent (PvE)
///         and human-vs-human (HvH) in a single interface; the mode is
///         determined by `params.agentId`:
///
///           agentId != 0 → PvE mode (one human, one agent)
///           agentId == 0 → HvH mode (two humans, both pre-authorize
///                          session keys before the game starts)
///
///         Message formats (EIP-191 personal_sign before ECDSA.recover):
///
///         PvE auth (playerA wallet):
///           keccak256(abi.encode(
///               "Chaingammon:open",
///               block.chainid, address(this),
///               playerA, nonceA, agentId, matchLength, sessionKeyA
///           ))
///
///         PvE result (sessionKeyA):
///           keccak256(abi.encode(
///               "Chaingammon:result",
///               block.chainid, address(this),
///               playerA, nonceA, agentId, aWins, gameRecordHash
///           ))
///
///         HvH auth per player (each wallet signs its own):
///           keccak256(abi.encode(
///               "Chaingammon:open-hvh",
///               block.chainid, address(this),
///               self, opponent, nonce, matchLength, sessionKey
///           ))
///
///         HvH result (both session keys sign identical bytes):
///           keccak256(abi.encode(
///               "Chaingammon:result-hvh",
///               block.chainid, address(this),
///               playerA, nonceA, playerB, nonceB, aWins, gameRecordHash
///           ))
///
///         A per-address monotonic nonce prevents replay.
contract MatchRegistry is Ownable {
    struct MatchInfo {
        uint64 timestamp;
        uint256 winnerAgentId; // 0 if winner is human
        address winnerHuman;   // zero address if winner is agent
        uint256 loserAgentId;
        address loserHuman;
        uint16 matchLength;
        bytes32 gameRecordHash; // 0G Storage hash of the full game record; bytes32(0) if unset
    }

    uint256 public matchCount;
    mapping(uint256 => MatchInfo) public matches;

    /// @notice Per-human monotonic nonce for `settle` / `settleAndSplit`.
    ///         Starts at 0; each successful settlement increments by 1.
    mapping(address => uint256) public nonces;

    /// @notice Optional escrow contract for atomic record-and-payout.
    ///         Zero address (default) disables the on-chain payout
    ///         path — `recordMatch` and `settle` keep working and just
    ///         don't move money. Wired post-deploy via `setMatchEscrow`
    ///         so MatchEscrow can be deployed independently with
    ///         `settler = MatchRegistry` (see `contracts/script/deploy.js`).
    address public matchEscrow;

    /// @notice Additional address authorized to call `recordMatch` and
    ///         `recordMatchAndSplit` alongside the owner. Zero address
    ///         (default) means owner-only — leaves the original v1
    ///         trust boundary intact. Wired post-deploy via `setSettler`
    ///         so a hosted orchestrator (e.g. KeeperHub Para MPC wallet)
    ///         can submit settlements without holding the deployer key.
    address public settler;

    // Stored ratings; default 1500 returned via getter when unset.
    mapping(uint256 => uint256) private _agentElo;
    mapping(address => uint256) private _humanElo;
    mapping(uint256 => bool) private _agentSeen;
    mapping(address => bool) private _humanSeen;

    event MatchRecorded(
        uint256 indexed matchId,
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint256 newWinnerElo,
        uint256 newLoserElo
    );
    event EloUpdated(uint256 indexed agentId, address indexed human, uint256 oldElo, uint256 newElo);
    event GameRecordStored(uint256 indexed matchId, bytes32 gameRecordHash);
    event MatchEscrowSet(address indexed previous, address indexed current);
    event SettlerSet(address indexed previous, address indexed current);

    error NoEscrowConfigured();
    error NotOwnerOrSettler();

    modifier onlyOwnerOrSettler() {
        if (msg.sender != owner() && msg.sender != settler) revert NotOwnerOrSettler();
        _;
    }

    constructor() Ownable(msg.sender) {}

    /// @notice Owner-only: wire (or re-wire) the MatchEscrow address.
    function setMatchEscrow(address escrow) external onlyOwner {
        emit MatchEscrowSet(matchEscrow, escrow);
        matchEscrow = escrow;
    }

    /// @notice Owner-only: grant (or revoke, by passing address(0)) an
    ///         additional address that can call `recordMatch` and
    ///         `recordMatchAndSplit`.
    function setSettler(address settler_) external onlyOwner {
        emit SettlerSet(settler, settler_);
        settler = settler_;
    }

    function agentElo(uint256 agentId) public view returns (uint256) {
        return _agentSeen[agentId] ? _agentElo[agentId] : EloMath.INITIAL;
    }

    function humanElo(address human) public view returns (uint256) {
        return _humanSeen[human] ? _humanElo[human] : EloMath.INITIAL;
    }

    function getMatch(uint256 matchId) external view returns (MatchInfo memory) {
        return matches[matchId];
    }

    /// @notice Trusted settlement — owner or settler records the match.
    function recordMatch(
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint16 matchLength,
        bytes32 gameRecordHash
    ) external onlyOwnerOrSettler returns (uint256 matchId) {
        require(
            (winnerAgentId == 0) != (winnerHuman == address(0)),
            "winner must be exactly one of agent or human"
        );
        require(
            (loserAgentId == 0) != (loserHuman == address(0)),
            "loser must be exactly one of agent or human"
        );
        return _doRecord(winnerAgentId, winnerHuman, loserAgentId, loserHuman, matchLength, gameRecordHash);
    }

    /// @notice Trusted settlement + escrow payout — owner or settler only.
    function recordMatchAndSplit(
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint16 matchLength,
        bytes32 gameRecordHash,
        bytes32 escrowMatchId,
        address[] calldata winners,
        uint256[] calldata shares
    ) external onlyOwnerOrSettler returns (uint256 matchId) {
        require(
            (winnerAgentId == 0) != (winnerHuman == address(0)),
            "winner must be exactly one of agent or human"
        );
        require(
            (loserAgentId == 0) != (loserHuman == address(0)),
            "loser must be exactly one of agent or human"
        );

        matchId = _doRecord(
            winnerAgentId, winnerHuman, loserAgentId, loserHuman,
            matchLength, gameRecordHash
        );

        _payoutFromEscrow(escrowMatchId, winners, shares);
    }

    /// @dev Unified parameter struct for `settle` and `settleAndSplit`.
    ///      Packs all non-signature fields into one calldata pointer to
    ///      stay within the EVM's 16-slot accessible-stack limit.
    ///
    ///      Mode is implicit:
    ///        agentId != 0 → PvE (human vs agent); playerB/nonceB/sessionKeyB unused
    ///        agentId == 0 → HvH (two humans);     agentId unused
    ///
    ///      HvH canonical ordering: uint160(playerA) < uint160(playerB).
    struct SettleParams {
        address playerA;      // human (PvE) or lower-address human (HvH)
        address playerB;      // zero for PvE; other human for HvH
        uint256 agentId;      // non-zero for PvE; zero for HvH
        uint16  matchLength;
        bool    aWins;        // true = playerA wins
        bytes32 gameRecordHash;
        uint256 nonceA;
        uint256 nonceB;       // HvH only; 0 for PvE
        address sessionKeyA;
        address sessionKeyB;  // HvH only; zero for PvE
    }

    /// @notice Trustless settlement (no escrow payout). Handles both PvE
    ///         and HvH — see contract docstring for hash formats.
    ///
    ///         PvE: authSigB and resultSigB are unused (pass empty bytes).
    ///         HvH: all four sigs required; both nonces consumed atomically.
    ///
    ///         Either player or any relayer may submit.
    function settle(
        SettleParams calldata p,
        bytes calldata authSigA,
        bytes calldata authSigB,
        bytes calldata resultSigA,
        bytes calldata resultSigB
    ) external returns (uint256 matchId) {
        require(p.playerA != address(0), "zero playerA");

        if (p.agentId != 0) {
            // ── PvE path ──────────────────────────────────────────────────
            require(p.playerB == address(0), "PvE: playerB must be zero");

            // 1. Auth: human wallet signs the session-key authorization
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.agentId, p.matchLength, p.sessionKeyA
                    ))
                );
                require(ECDSA.recover(h, authSigA) == p.playerA, "authSigA bad");
            }

            // 2. Result: session key signs the agreed outcome
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:result",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.agentId, p.aWins, p.gameRecordHash
                    ))
                );
                require(ECDSA.recover(h, resultSigA) == p.sessionKeyA, "resultSigA bad");
            }

            // 3. Consume nonce
            require(nonces[p.playerA] == p.nonceA, "nonce mismatch");
            nonces[p.playerA] += 1;

            // 4. Record
            if (p.aWins) return _doRecord(0, p.playerA, p.agentId, address(0), p.matchLength, p.gameRecordHash);
            else         return _doRecord(p.agentId, address(0), 0, p.playerA, p.matchLength, p.gameRecordHash);

        } else {
            // ── HvH path ──────────────────────────────────────────────────
            require(p.playerB != address(0), "HvH: zero playerB");
            require(uint160(p.playerA) < uint160(p.playerB), "playerA must be lower address");

            // 1. Auth: playerA wallet authorizes its session key
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open-hvh",
                        block.chainid, address(this),
                        p.playerA, p.playerB, p.nonceA, p.matchLength, p.sessionKeyA
                    ))
                );
                require(ECDSA.recover(h, authSigA) == p.playerA, "authSigA bad");
            }

            // 2. Auth: playerB wallet authorizes its session key
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open-hvh",
                        block.chainid, address(this),
                        p.playerB, p.playerA, p.nonceB, p.matchLength, p.sessionKeyB
                    ))
                );
                require(ECDSA.recover(h, authSigB) == p.playerB, "authSigB bad");
            }

            // 3. Result: both session keys co-sign identical bytes
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:result-hvh",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.playerB, p.nonceB, p.aWins, p.gameRecordHash
                    ))
                );
                require(ECDSA.recover(h, resultSigA) == p.sessionKeyA, "resultSigA bad");
                require(ECDSA.recover(h, resultSigB) == p.sessionKeyB, "resultSigB bad");
            }

            // 4. Consume both nonces atomically
            require(nonces[p.playerA] == p.nonceA, "nonceA mismatch");
            require(nonces[p.playerB] == p.nonceB, "nonceB mismatch");
            nonces[p.playerA] += 1;
            nonces[p.playerB] += 1;

            // 5. Record
            if (p.aWins) return _doRecord(0, p.playerA, 0, p.playerB, p.matchLength, p.gameRecordHash);
            else         return _doRecord(0, p.playerB, 0, p.playerA, p.matchLength, p.gameRecordHash);
        }
    }

    /// @notice Trustless settlement WITH on-chain escrow payout.
    ///         Auth hashes are identical to `settle` (a single wallet
    ///         auth sig covers both paths). Result hashes use distinct
    ///         prefixes to prevent cross-path replay, and bind the
    ///         escrowMatchId + splitHash so a relayer cannot tamper with
    ///         the split.
    ///
    ///         PvE result prefix:  "Chaingammon:result-with-split"
    ///         HvH result prefix:  "Chaingammon:result-hvh-split"
    function settleAndSplit(
        SettleParams calldata p,
        bytes calldata authSigA,
        bytes calldata authSigB,
        bytes calldata resultSigA,
        bytes calldata resultSigB,
        bytes32 escrowMatchId,
        address[] calldata winners,
        uint256[] calldata shares
    ) external returns (uint256 matchId) {
        require(p.playerA != address(0), "zero playerA");

        if (p.agentId != 0) {
            // ── PvE path ──────────────────────────────────────────────────
            require(p.playerB == address(0), "PvE: playerB must be zero");

            // 1. Auth: same hash as settle()
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.agentId, p.matchLength, p.sessionKeyA
                    ))
                );
                require(ECDSA.recover(h, authSigA) == p.playerA, "authSigA bad");
            }

            // 2. Result with split binding
            {
                bytes32 splitHash = keccak256(abi.encode(winners, shares));
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:result-with-split",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.agentId, p.aWins, p.gameRecordHash,
                        escrowMatchId, splitHash
                    ))
                );
                require(ECDSA.recover(h, resultSigA) == p.sessionKeyA, "resultSigA bad");
            }

            // 3. Consume nonce
            require(nonces[p.playerA] == p.nonceA, "nonce mismatch");
            nonces[p.playerA] += 1;

            // 4. Record
            if (p.aWins) matchId = _doRecord(0, p.playerA, p.agentId, address(0), p.matchLength, p.gameRecordHash);
            else         matchId = _doRecord(p.agentId, address(0), 0, p.playerA, p.matchLength, p.gameRecordHash);

        } else {
            // ── HvH path ──────────────────────────────────────────────────
            require(p.playerB != address(0), "HvH: zero playerB");
            require(uint160(p.playerA) < uint160(p.playerB), "playerA must be lower address");

            // 1. Auth A: same hash as settle()
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open-hvh",
                        block.chainid, address(this),
                        p.playerA, p.playerB, p.nonceA, p.matchLength, p.sessionKeyA
                    ))
                );
                require(ECDSA.recover(h, authSigA) == p.playerA, "authSigA bad");
            }

            // 2. Auth B: same hash as settle()
            {
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:open-hvh",
                        block.chainid, address(this),
                        p.playerB, p.playerA, p.nonceB, p.matchLength, p.sessionKeyB
                    ))
                );
                require(ECDSA.recover(h, authSigB) == p.playerB, "authSigB bad");
            }

            // 3. Result with split binding (both session keys co-sign)
            {
                bytes32 splitHash = keccak256(abi.encode(winners, shares));
                bytes32 h = MessageHashUtils.toEthSignedMessageHash(
                    keccak256(abi.encode(
                        "Chaingammon:result-hvh-split",
                        block.chainid, address(this),
                        p.playerA, p.nonceA, p.playerB, p.nonceB, p.aWins, p.gameRecordHash,
                        escrowMatchId, splitHash
                    ))
                );
                require(ECDSA.recover(h, resultSigA) == p.sessionKeyA, "resultSigA bad");
                require(ECDSA.recover(h, resultSigB) == p.sessionKeyB, "resultSigB bad");
            }

            // 4. Consume both nonces atomically
            require(nonces[p.playerA] == p.nonceA, "nonceA mismatch");
            require(nonces[p.playerB] == p.nonceB, "nonceB mismatch");
            nonces[p.playerA] += 1;
            nonces[p.playerB] += 1;

            // 5. Record
            if (p.aWins) matchId = _doRecord(0, p.playerA, 0, p.playerB, p.matchLength, p.gameRecordHash);
            else         matchId = _doRecord(0, p.playerB, 0, p.playerA, p.matchLength, p.gameRecordHash);
        }

        // 6. Pay out from escrow
        _payoutFromEscrow(escrowMatchId, winners, shares);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _payoutFromEscrow(
        bytes32 escrowMatchId,
        address[] calldata winners,
        uint256[] calldata shares
    ) internal {
        if (matchEscrow == address(0)) revert NoEscrowConfigured();
        IMatchEscrow(matchEscrow).payoutSplit(escrowMatchId, winners, shares);
    }

    function _doRecord(
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint16 matchLength,
        bytes32 gameRecordHash
    ) internal returns (uint256 matchId) {
        uint256 winnerOld = winnerAgentId != 0 ? agentElo(winnerAgentId) : humanElo(winnerHuman);
        uint256 loserOld = loserAgentId != 0 ? agentElo(loserAgentId) : humanElo(loserHuman);

        uint256 winnerExp = EloMath.expectedScorePct(int256(winnerOld), int256(loserOld));
        uint256 loserExp = EloMath.expectedScorePct(int256(loserOld), int256(winnerOld));

        uint256 winnerNew = EloMath.newRating(winnerOld, winnerExp, true);
        uint256 loserNew = EloMath.newRating(loserOld, loserExp, false);

        if (winnerAgentId != 0) {
            _agentElo[winnerAgentId] = winnerNew;
            _agentSeen[winnerAgentId] = true;
            emit EloUpdated(winnerAgentId, address(0), winnerOld, winnerNew);
        } else {
            _humanElo[winnerHuman] = winnerNew;
            _humanSeen[winnerHuman] = true;
            emit EloUpdated(0, winnerHuman, winnerOld, winnerNew);
        }

        if (loserAgentId != 0) {
            _agentElo[loserAgentId] = loserNew;
            _agentSeen[loserAgentId] = true;
            emit EloUpdated(loserAgentId, address(0), loserOld, loserNew);
        } else {
            _humanElo[loserHuman] = loserNew;
            _humanSeen[loserHuman] = true;
            emit EloUpdated(0, loserHuman, loserOld, loserNew);
        }

        matchId = matchCount;
        matches[matchId] = MatchInfo({
            timestamp: uint64(block.timestamp),
            winnerAgentId: winnerAgentId,
            winnerHuman: winnerHuman,
            loserAgentId: loserAgentId,
            loserHuman: loserHuman,
            matchLength: matchLength,
            gameRecordHash: gameRecordHash
        });
        matchCount = matchId + 1;

        emit MatchRecorded(matchId, winnerAgentId, winnerHuman, loserAgentId, loserHuman, winnerNew, loserNew);
        emit GameRecordStored(matchId, gameRecordHash);
    }
}
