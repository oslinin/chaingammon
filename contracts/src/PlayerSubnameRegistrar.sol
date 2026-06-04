// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

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
contract PlayerSubnameRegistrar is Ownable, IERC1155Receiver {
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

    /// @notice Tracks which addresses have already claimed a subname via
    ///         selfMintSubname so that duplicate self-registrations are blocked.
    mapping(address => bool) public hasClaimed;

    error EmptyLabel();
    error NotAuthorized();
    error ZeroAddressOwner();
    error AlreadyRegistered();
    error LabelTaken();

    // ERC1155Receiver — required so the contract can temporarily hold a
    // NameWrapper token during the two-step mint-then-transfer flow.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }

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
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Subname expiry must not exceed the parent's expiry (ENS NameWrapper
    ///      enforces this). Read it dynamically so we stay valid as the parent
    ///      is renewed over time.
    function _parentExpiry() internal view returns (uint64) {
        (, , uint64 exp) = nameWrapper.getData(uint256(parentNode));
        return exp;
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

        node = subnameNode(label);
        // (Removal of LabelTaken check in the admin path allows for re-minting
        // to emit fresh events on a new contract deployment.)

        // If human registration (inftId == 0), track claim status to enforce
        // one-name-per-wallet.
        if (inftId == 0) {
            if (hasClaimed[subnameOwner_]) revert AlreadyRegistered();
            hasClaimed[subnameOwner_] = true;
        }

        // 1. Mint to ourselves first so we have permission to set records on the resolver.
        nameWrapper.setSubnodeRecord(
            parentNode,
            label,
            address(this),
            resolver,
            0,
            0,
            _parentExpiry()
        );

        // 2. Set text records while we are still the owner.
        if (inftId > 0) {
            IResolver(resolver).setText(node, "kind", "agent");
            IResolver(resolver).setText(node, "inft_id", Strings.toString(inftId));
        } else {
            IResolver(resolver).setText(node, "kind", "human");
        }

        // 3. Transfer ownership to the final owner.
        nameWrapper.setSubnodeOwner(parentNode, label, subnameOwner_, 0, _parentExpiry());

        emit SubnameMinted(label, node, subnameOwner_, inftId);
    }

    /// @notice Open self-registration: anyone can claim a subname for
    ///         themselves. Delegates to NameWrapper. Each address may claim
    ///         at most one subname; use selfRevokeSubname to release the claim.
    function selfMintSubname(string calldata label) external returns (bytes32 node) {
        if (bytes(label).length == 0) revert EmptyLabel();
        if (hasClaimed[msg.sender]) revert AlreadyRegistered();
        
        node = subnameNode(label);
        (address current, , ) = nameWrapper.getData(uint256(node));
        if (current != address(0) && current != msg.sender) revert LabelTaken();

        hasClaimed[msg.sender] = true;

        // 1. Mint to ourselves first so we have permission to set records.
        nameWrapper.setSubnodeRecord(
            parentNode,
            label,
            address(this),
            resolver,
            0,
            0,
            _parentExpiry()
        );

        // 2. Explicitly mark as human for discovery categorization.
        IResolver(resolver).setText(node, "kind", "human");

        // 3. Transfer ownership to the caller.
        nameWrapper.setSubnodeOwner(parentNode, label, msg.sender, 0, _parentExpiry());

        emit SubnameMinted(label, node, msg.sender, 0);
    }

    /// @notice Revoke a subname. Owner / authorized minter only.
    ///         Clears the NameWrapper owner to address(0) and releases the
    ///         hasClaimed flag so the previous owner may re-register.
    function revokeSubname(string calldata label) external {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();

        bytes32 _node = subnameNode(label);
        (address current, , ) = nameWrapper.getData(uint256(_node));
        if (current != address(0)) hasClaimed[current] = false;

        bytes32 node = nameWrapper.setSubnodeOwner(parentNode, label, address(0), 0, 0);
        emit SubnameRevoked(label, node);
    }

    /// @notice Self-service revocation: the subname owner can release their
    ///         own claim, clearing hasClaimed so they may later register a
    ///         different name.
    function selfRevokeSubname(string calldata label) external {
        bytes32 _node = subnameNode(label);
        (address current, , ) = nameWrapper.getData(uint256(_node));
        if (current != msg.sender) revert NotAuthorized();
        hasClaimed[msg.sender] = false;
        bytes32 node = nameWrapper.setSubnodeOwner(parentNode, label, address(0), 0, 0);
        emit SubnameRevoked(label, node);
    }

    // -------------------------------------------------------------------------
    // Text records (Phase 11: server-pays ELO updates)
    // -------------------------------------------------------------------------

    /// @notice Proxy setText to the resolver. Owner / authorized minter only.
    ///         Used by the server to push ELO / match history into ENS.
    /// @dev    For this to succeed, the registrar must be authorized to call
    ///         setText on the resolver for the given node. In NameWrapper-backed
    ///         setups, the parent owner (registrar) can always reclaim the
    ///         node, set records, and transfer back; for efficiency v1 assumes
    ///         the registrar is an authorized manager on the resolver.
    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();
        IResolver(resolver).setText(node, key, value);
    }

    /// @notice Proxy text read from the resolver.
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return IResolver(resolver).text(node, key);
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
