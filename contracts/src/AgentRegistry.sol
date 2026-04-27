// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IMatchRegistry {
    function agentElo(uint256 agentId) external view returns (uint256);
}

/// @title AgentRegistry — iNFT registry for AI backgammon agents on 0G.
/// @notice ERC-721 base + ERC-7857-compatible shape for embedded intelligence.
/// @dev Each agent carries a tier (immutable, set at mint) plus two data hashes:
///        dataHashes[0] = baseWeightsHash (shared across all agents — the
///                        encrypted gnubg base weights blob on 0G Storage)
///        dataHashes[1] = overlayHash    (unique per agent — the agent's
///                        learned experience overlay on 0G Storage)
///      Full ERC-7857 transfer-with-reencryption-proof flow is out of scope
///      for v1; this contract implements the data-hash *shape* compatible
///      with ERC-7857.
contract AgentRegistry is ERC721, Ownable {
    uint8 public constant MAX_TIER = 3;

    uint256 public agentCount;
    IMatchRegistry public immutable matchRegistry;

    /// @notice Hash of the encrypted gnubg base weights on 0G Storage.
    ///         Shared across all agents; set by the owner (server) and
    ///         updateable when weights are uploaded in Phase 8.
    bytes32 public baseWeightsHash;

    struct AgentData {
        uint8 tier;
        bytes32 overlayHash;       // dataHashes[1]: per-agent learned experience
        uint32 matchCount;         // increments per match played
        uint32 experienceVersion;  // increments when overlay updates
    }

    mapping(uint256 => string) private _agentMetadata;
    mapping(uint256 => AgentData) private _agentData;

    event AgentMinted(uint256 indexed agentId, address indexed owner, uint8 tier, string metadataURI);
    event OverlayUpdated(uint256 indexed agentId, bytes32 overlayHash, uint32 experienceVersion);
    event BaseWeightsHashSet(bytes32 baseWeightsHash);

    constructor(address matchRegistryAddress, bytes32 initialBaseWeightsHash)
        ERC721("Chaingammon Agent", "CGAGENT")
        Ownable(msg.sender)
    {
        matchRegistry = IMatchRegistry(matchRegistryAddress);
        baseWeightsHash = initialBaseWeightsHash;
        emit BaseWeightsHashSet(initialBaseWeightsHash);
    }

    /// @notice Mint a new agent iNFT. Returns the agentId (starts at 1).
    function mintAgent(address to, string calldata metadataURI, uint8 tier_)
        external
        onlyOwner
        returns (uint256 agentId)
    {
        require(tier_ <= MAX_TIER, "AgentRegistry: tier out of range");
        agentCount += 1;
        agentId = agentCount;
        _safeMint(to, agentId);
        _agentMetadata[agentId] = metadataURI;
        _agentData[agentId].tier = tier_;
        // overlayHash, matchCount, experienceVersion default to 0
        emit AgentMinted(agentId, to, tier_, metadataURI);
    }

    /// @notice Set the shared base weights hash on 0G Storage.
    ///         Called by the owner once weights are uploaded (Phase 8).
    function setBaseWeightsHash(bytes32 newHash) external onlyOwner {
        baseWeightsHash = newHash;
        emit BaseWeightsHashSet(newHash);
    }

    /// @notice Update an agent's experience overlay hash. Called by the
    ///         server (owner) after each match. Increments matchCount and
    ///         experienceVersion together (one bump per match).
    function updateOverlayHash(uint256 agentId, bytes32 newOverlayHash) external onlyOwner {
        require(_ownerOf(agentId) != address(0), "AgentRegistry: agent does not exist");
        AgentData storage data = _agentData[agentId];
        data.overlayHash = newOverlayHash;
        data.matchCount += 1;
        data.experienceVersion += 1;
        emit OverlayUpdated(agentId, newOverlayHash, data.experienceVersion);
    }

    // --- iNFT views (ERC-7857-compatible shape) ---

    /// @notice Returns [baseWeightsHash, overlayHash] — the agent's data hashes.
    function dataHashes(uint256 agentId) external view returns (bytes32[2] memory) {
        return [baseWeightsHash, _agentData[agentId].overlayHash];
    }

    function tier(uint256 agentId) external view returns (uint8) {
        return _agentData[agentId].tier;
    }

    function matchCount(uint256 agentId) external view returns (uint32) {
        return _agentData[agentId].matchCount;
    }

    function experienceVersion(uint256 agentId) external view returns (uint32) {
        return _agentData[agentId].experienceVersion;
    }

    function agentMetadata(uint256 agentId) external view returns (string memory) {
        return _agentMetadata[agentId];
    }

    function agentElo(uint256 agentId) external view returns (uint256) {
        return matchRegistry.agentElo(agentId);
    }
}
