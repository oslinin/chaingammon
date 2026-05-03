// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Subset of ENS NameWrapper used by PlayerSubnameRegistrar.
interface INameWrapper {
    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);

    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);

    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry);
}

/// @notice Subset of ENS PublicResolver used by PlayerSubnameRegistrar.
interface IResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @title PlayerSubnameRegistrar — ENS-NameWrapper-backed subname registrar
///        for chaingammon player and agent profiles.
///
/// @dev    This contract delegates all subname state to the canonical ENS
///         NameWrapper and a PublicResolver. It holds no subname storage of
///         its own; namehashes, ownership, and text records all live in ENS.
///
///         The chaingammon parent name (e.g. "chaingammon.eth") must be
///         wrapped in NameWrapper, and the registrar must be approved to
///         create subnodes under it (`NameWrapper.setApprovalForAll(...)`).
///
///         Permissions:
///          - Contract owner (the server post-match) can mint subnames.
///          - Authorized minters (e.g. AgentRegistry) can also mint
///            subnames so that agent minting is atomic.
///          - selfMintSubname remains open: any wallet can claim a subname
///            for its own address.
///          - revokeSubname is owner / authorized-minter only and clears
///            the subname's owner in NameWrapper.
contract PlayerSubnameRegistrar is Ownable {
    /// @notice ENS namehash of the parent name (e.g. "chaingammon.eth").
    bytes32 public immutable parentNode;

    /// @notice ENS NameWrapper address (canonical on Sepolia / mainnet).
    INameWrapper public immutable nameWrapper;

    /// @notice ENS PublicResolver address used for text records.
    address public immutable resolver;

    /// @notice Addresses authorised to call `mintSubname` / `revokeSubname`
    ///         in addition to the contract owner.
    mapping(address => bool) private _authorizedMinters;

    event SubnameMinted(
        string label,
        bytes32 indexed node,
        address indexed subnameOwner,
        uint256 inftId
    );
    event SubnameRevoked(string label, bytes32 indexed node);
    event AuthorizedMinterSet(address indexed minter, bool authorized);

    error EmptyLabel();
    error NotAuthorized();
    error ZeroAddressOwner();

    constructor(bytes32 _parentNode, address _nameWrapper, address _resolver) Ownable(msg.sender) {
        parentNode = _parentNode;
        nameWrapper = INameWrapper(_nameWrapper);
        resolver = _resolver;
    }

    // -------------------------------------------------------------------------
    // Minter management
    // -------------------------------------------------------------------------

    function setAuthorizedMinter(address minter, bool authorized) external onlyOwner {
        _authorizedMinters[minter] = authorized;
        emit AuthorizedMinterSet(minter, authorized);
    }

    function isAuthorizedMinter(address addr) external view returns (bool) {
        return addr == owner() || _authorizedMinters[addr];
    }

    // -------------------------------------------------------------------------
    // Namehash helper
    // -------------------------------------------------------------------------

    function subnameNode(string calldata label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    // -------------------------------------------------------------------------
    // Minting (delegates to NameWrapper)
    // -------------------------------------------------------------------------

    /// @notice Mint a subname via NameWrapper. Owner / authorized minter only.
    ///         `inftId` is recorded in the SubnameMinted event so off-chain
    ///         indexers can map an agent NFT back to its ENS subname without
    ///         a separate lookup; pass 0 for human registrations.
    function mintSubname(string calldata label, address subnameOwner_, uint256 inftId)
        external
        returns (bytes32 node)
    {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();
        if (bytes(label).length == 0) revert EmptyLabel();
        if (subnameOwner_ == address(0)) revert ZeroAddressOwner();

        node = nameWrapper.setSubnodeRecord(
            parentNode,
            label,
            subnameOwner_,
            resolver,
            0,           // ttl
            0,           // fuses
            type(uint64).max // expiry — never expires
        );

        // Phase 31: set text records so discovery tools (subgraph-based)
        // can distinguish agents from humans without event scanning.
        if (inftId > 0) {
            IResolver(resolver).setText(node, "kind", "agent");
            IResolver(resolver).setText(node, "inft_id", Strings.toString(inftId));
        } else {
            IResolver(resolver).setText(node, "kind", "human");
        }

        emit SubnameMinted(label, node, subnameOwner_, inftId);
    }

    /// @notice Open self-registration: anyone can claim a subname for
    ///         themselves. Delegates to NameWrapper.
    function selfMintSubname(string calldata label) external returns (bytes32 node) {
        if (bytes(label).length == 0) revert EmptyLabel();

        node = nameWrapper.setSubnodeRecord(
            parentNode,
            label,
            msg.sender,
            resolver,
            0,
            0,
            type(uint64).max
        );

        // Explicitly mark as human for discovery categorization.
        IResolver(resolver).setText(node, "kind", "human");

        emit SubnameMinted(label, node, msg.sender, 0);
    }

    /// @notice Revoke a subname. Owner / authorized minter only.
    ///         Clears the NameWrapper owner to address(0).
    function revokeSubname(string calldata label) external {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();

        bytes32 node = nameWrapper.setSubnodeOwner(
            parentNode,
            label,
            address(0),
            0,
            0
        );

        emit SubnameRevoked(label, node);
    }

    // -------------------------------------------------------------------------
    // Reads (delegate to NameWrapper / Resolver)
    // -------------------------------------------------------------------------

    /// @notice ENS-shaped owner lookup for a subname label. Reads from NameWrapper.
    function ownerOf(string calldata label) external view returns (address) {
        bytes32 node = subnameNode(label);
        (address owner_, , ) = nameWrapper.getData(uint256(node));
        return owner_;
    }
}
