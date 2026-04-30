// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IMatchRegistry {
    function agentElo(uint256 agentId) external view returns (uint256);
}

/// @notice Minimal interface for PlayerSubnameRegistrar — only the two
///         functions AgentRegistry calls on mint.
interface IPlayerSubnameRegistrar {
    function mintSubname(string calldata label, address subnameOwner_) external returns (bytes32 node);
    function setText(bytes32 node, string calldata key, string calldata value) external;
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
///
///      Phase 31 addition: `setSubnameRegistrar` wires up a
///      PlayerSubnameRegistrar so that `mintAgent` atomically issues a
///      subname with `kind="agent"` and `inft_id=<id>` text records.
contract AgentRegistry is ERC721, Ownable {
    uint8 public constant MAX_TIER = 3;

    uint256 public agentCount;
    IMatchRegistry public immutable matchRegistry;

    /// @notice Optional PlayerSubnameRegistrar for atomic subname minting.
    ///         Zero address = disabled (mintAgent proceeds without subname).
    IPlayerSubnameRegistrar public subnameRegistrar;

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
    event SubnameRegistrarSet(address registrar);

    constructor(address matchRegistryAddress, bytes32 initialBaseWeightsHash)
        ERC721("Chaingammon Agent", "CGAGENT")
        Ownable(msg.sender)
    {
        matchRegistry = IMatchRegistry(matchRegistryAddress);
        baseWeightsHash = initialBaseWeightsHash;
        emit BaseWeightsHashSet(initialBaseWeightsHash);
    }

    /// @notice Wire up a PlayerSubnameRegistrar so that mintAgent issues a
    ///         subname atomically. Pass address(0) to disable.
    ///         AgentRegistry must be an authorized minter on the registrar
    ///         before this is useful.
    function setSubnameRegistrar(address registrar_) external onlyOwner {
        subnameRegistrar = IPlayerSubnameRegistrar(registrar_);
        emit SubnameRegistrarSet(registrar_);
    }

    /// @notice Mint a new agent iNFT. Returns the agentId (starts at 1).
    ///         If a subnameRegistrar is configured, also mints a corresponding
    ///         subname with `kind="agent"` and `inft_id=<id>` text records.
    ///         The subname label is the metadataURI with the scheme prefix
    ///         stripped (e.g. "ipfs://gnubg-tier1" → "gnubg-tier1").
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

        // Atomic subname mint — only when a registrar is wired.
        if (address(subnameRegistrar) != address(0)) {
            string memory label = _cleanLabel(metadataURI);
            bytes32 node = subnameRegistrar.mintSubname(label, to);
            subnameRegistrar.setText(node, "kind", "agent");
            subnameRegistrar.setText(node, "inft_id", _toString(agentId));
        }
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

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Strip the scheme prefix from a URI (e.g. "ipfs://foo" → "foo")
    ///      and replace "/" with "-", mirroring the AgentCard.tsx cleaning logic.
    function _cleanLabel(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 start = 0;

        // Find "://" and set start to the character after it
        for (uint256 i = 0; i + 2 < b.length; i++) {
            if (b[i] == ":" && b[i + 1] == "/" && b[i + 2] == "/") {
                start = i + 3;
                break;
            }
        }

        // Copy remaining bytes, replacing "/" with "-"
        uint256 len = b.length - start;
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = b[start + i] == "/" ? bytes1("-") : b[start + i];
        }
        return string(result);
    }

    /// @dev Convert uint256 to its decimal string representation.
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
