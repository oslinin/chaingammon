// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./EloMath.sol";

/// @title MatchRegistry — records backgammon matches and updates ELO.
/// @dev Two settlement paths:
///
///      1. `recordMatch` (owner-only) — used by the server or KeeperHub
///         workflow for trusted settlement. v1 trust boundary.
///
///      2. `settleWithSessionKeys` (permissionless) — trustless session-key
///         state channel. At game start the human's wallet authorises an
///         ephemeral in-browser session key (one MetaMask popup). At game
///         end, the same wallet submits the session-key-signed result; the
///         contract verifies both signatures. Neither the Chaingammon server
///         nor any operator key is in the critical path.
///
///         Message format (EIP-191 personal_sign applied before ECDSA.recover):
///
///           humanAuthHash = keccak256(
///               "Chaingammon:open",
///               block.chainid, address(this),
///               nonce, agentId, matchLength, sessionKey
///           )
///           resultHash = keccak256(
///               "Chaingammon:result",
///               block.chainid, address(this),
///               nonce, agentId, humanWins (uint8), gameRecordHash
///           )
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

    /// @notice Per-human monotonic nonce for `settleWithSessionKeys`.
    ///         Starts at 0; each successful settlement increments by 1.
    mapping(address => uint256) public nonces;

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

    constructor() Ownable(msg.sender) {}

    function agentElo(uint256 agentId) public view returns (uint256) {
        return _agentSeen[agentId] ? _agentElo[agentId] : EloMath.INITIAL;
    }

    function humanElo(address human) public view returns (uint256) {
        return _humanSeen[human] ? _humanElo[human] : EloMath.INITIAL;
    }

    function getMatch(uint256 matchId) external view returns (MatchInfo memory) {
        return matches[matchId];
    }

    /// @notice Trusted settlement — owner (server / KeeperHub) records the match.
    function recordMatch(
        uint256 winnerAgentId,
        address winnerHuman,
        uint256 loserAgentId,
        address loserHuman,
        uint16 matchLength,
        bytes32 gameRecordHash
    ) external onlyOwner returns (uint256 matchId) {
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

    /// @notice Trustless settlement via session-key state channel.
    ///
    /// @dev Verification flow:
    ///   1. Reconstruct `humanAuthHash` from caller-supplied params and verify
    ///      `humanAuthSig` recovers to the CLAIMED `human` address. (Without
    ///      binding the auth recovery to a claimed address, a tampered auth
    ///      sig recovers to a random address whose nonce defaults to zero —
    ///      passes the require, records a match for a garbage address.)
    ///   2. Verify `resultSig` recovers to `sessionKey` over `resultHash`.
    ///      `resultHash` includes the SAME `human` and `agentId` as the auth,
    ///      so a result signed for a different opponent fails.
    ///   3. Consume the nonce stored under `human`.
    ///   4. Record the match — human as winner or loser vs the specified agent.
    ///
    /// Either player (or any relayer) can submit — the result is binding once
    /// both signatures are valid for the claimed `human`.
    ///
    /// Encoding: both messages use `abi.encode` (NOT `abi.encodePacked`) so
    /// hashes are unambiguous across types and dynamic data; ECDSA recovery
    /// uses `MessageHashUtils.toEthSignedMessageHash` to match raw-bytes
    /// `personal_sign` from EIP-191.
    ///
    /// @param human         Address whose wallet signed `humanAuthSig`. The
    ///                       recovered signer is checked against this value;
    ///                       a mismatch reverts.
    /// @param agentId       ERC-7857 token ID of the opponent agent (> 0).
    /// @param matchLength   Match-point target (e.g. 3).
    /// @param humanWins     True when the human wallet is the winner.
    /// @param gameRecordHash 0G Storage Merkle root hash of the game archive.
    /// @param nonce         Human's current nonce (must equal `nonces[human]`).
    /// @param sessionKey    Ephemeral address whose private key lives in the browser.
    /// @param humanAuthSig  EIP-191 personal_sign over `humanAuthHash` by the human wallet.
    /// @param resultSig     EIP-191 personal_sign over `resultHash` by the session key.
    function settleWithSessionKeys(
        address human,
        uint256 agentId,
        uint16 matchLength,
        bool humanWins,
        bytes32 gameRecordHash,
        uint256 nonce,
        address sessionKey,
        bytes calldata humanAuthSig,
        bytes calldata resultSig
    ) external returns (uint256 matchId) {
        require(human != address(0), "human must not be zero");
        require(agentId != 0, "agentId must be non-zero");

        // ── 1. Verify the claimed `human` signed the auth ─────────────────────
        bytes32 authHash = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(
                "Chaingammon:open",
                block.chainid,
                address(this),
                human,
                nonce,
                agentId,
                matchLength,
                sessionKey
            ))
        );
        require(
            ECDSA.recover(authHash, humanAuthSig) == human,
            "humanAuthSig not from human"
        );

        // ── 2. Verify session key signed this result for the same human + agent
        bytes32 resultHash = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(
                "Chaingammon:result",
                block.chainid,
                address(this),
                human,
                nonce,
                agentId,
                humanWins,
                gameRecordHash
            ))
        );
        require(
            ECDSA.recover(resultHash, resultSig) == sessionKey,
            "resultSig not from sessionKey"
        );

        // ── 3. Consume nonce (replay protection) ─────────────────────────────
        require(nonces[human] == nonce, "nonce mismatch");
        nonces[human] += 1;

        // ── 4. Record the match ───────────────────────────────────────────────
        if (humanWins) {
            return _doRecord(0, human, agentId, address(0), matchLength, gameRecordHash);
        } else {
            return _doRecord(agentId, address(0), 0, human, matchLength, gameRecordHash);
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Core ELO update and storage write, shared by both settlement paths.
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
