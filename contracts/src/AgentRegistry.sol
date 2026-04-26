// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IMatchRegistry {
    function agentElo(uint256 agentId) external view returns (uint256);
}

/// @title AgentRegistry — iNFT registry for AI backgammon agents on 0G.
/// @dev v1 uses ERC-721; ERC-7857 (iNFT) upgrade tracked in roadmap.
contract AgentRegistry is ERC721, Ownable {
    uint256 public agentCount;
    IMatchRegistry public immutable matchRegistry;

    mapping(uint256 => string) private _agentMetadata;

    event AgentMinted(uint256 indexed agentId, address indexed owner, string metadataURI);

    constructor(address matchRegistryAddress)
        ERC721("Chaingammon Agent", "CGAGENT")
        Ownable(msg.sender)
    {
        matchRegistry = IMatchRegistry(matchRegistryAddress);
    }

    /// @notice Mint a new agent iNFT. Returns the agentId (starts at 1).
    function mintAgent(address to, string calldata metadataURI) external onlyOwner returns (uint256 agentId) {
        agentCount += 1;
        agentId = agentCount;
        _safeMint(to, agentId);
        _agentMetadata[agentId] = metadataURI;
        emit AgentMinted(agentId, to, metadataURI);
    }

    function agentMetadata(uint256 agentId) external view returns (string memory) {
        return _agentMetadata[agentId];
    }

    function agentElo(uint256 agentId) external view returns (uint256) {
        return matchRegistry.agentElo(agentId);
    }
}
