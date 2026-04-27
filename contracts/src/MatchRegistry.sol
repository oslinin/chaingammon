// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./EloMath.sol";

/// @title MatchRegistry — records backgammon matches and updates ELO.
/// @dev Permissioning: deployer (server) only can recordMatch; this is
///      the trust boundary documented in the v1 plan. Decentralizes in v2.
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
