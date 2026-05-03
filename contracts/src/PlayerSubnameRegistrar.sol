// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PlayerSubnameRegistrar — ENS-shaped subname registrar for
///        chaingammon player profiles.
///
/// @notice v1 is a self-contained registrar (deployed alongside the rest
///         of the protocol on 0G testnet). Each player gets a subname
///         like `alice.chaingammon.eth` whose ENS-format namehash is
///         derived from the parent node passed at construction. Text
///         records carry the player's reputation: `elo`,
///         `match_count`, `last_match_id`, `style_uri`, `archive_uri`.
///
///         A v2 deployment can mirror this state to real ENS on
///         Sepolia/Linea: the contract is ENS-shaped (namehash, text
///         records, owner-of resolver semantics) and any ENS resolver
///         can be pointed at it.
///
/// @dev    Permissioning (Phase 31):
///          - Contract owner (the server post-match) can mint subnames.
///          - Authorized minters (e.g. AgentRegistry) can also mint
///            subnames so that agent minting is atomic.
///          - Reserved keys (`elo`, `match_count`, `last_match_id`,
///            `kind`, `inft_id`) can only be written by the contract
///            owner — this is what makes ELO a verified protocol claim,
///            not a user-asserted value.
///          - All other keys remain dual-auth: subname owner or contract
///            owner.
///          - `subnameAt(uint256)` exposes an enumerable index so
///            frontends can walk every registered identity in one query.
contract PlayerSubnameRegistrar is Ownable {
    /// @notice ENS namehash of the parent name (e.g. "chaingammon.eth").
    bytes32 public immutable parentNode;

    /// @notice Total subnames issued (running counter; useful for
    ///         deploy-time diagnostics).
    uint256 public subnameCount;

    struct Subname {
        address subnameOwner;
        bool exists;
    }

    /// @notice node (full namehash of `<label>.<parent>`) → Subname.
    mapping(bytes32 => Subname) private _subnames;

    /// @notice node → key → text record value (ENS resolver shape).
    mapping(bytes32 => mapping(string => string)) private _textRecords;

    /// @notice Ordered list of all minted nodes — enables enumeration.
    bytes32[] private _subnameIndex;

    /// @notice keccak256(key) → true when only the contract owner may write
    ///         that key. Populated in the constructor; never mutated after.
    mapping(bytes32 => bool) private _reservedKey;

    /// @notice Addresses authorised to call `mintSubname` in addition to the
    ///         contract owner. Set via `setAuthorizedMinter`.
    mapping(address => bool) private _authorizedMinters;

    event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner);
    event SubnameRevoked(bytes32 indexed node);
    event TextRecordSet(bytes32 indexed node, string key, string value);
    event AuthorizedMinterSet(address indexed minter, bool authorized);

    error EmptyLabel();
    error SubnameAlreadyExists();
    error SubnameDoesNotExist();
    error NotAuthorized();
    error ZeroAddressOwner();
    error IndexOutOfRange();

    constructor(bytes32 _parentNode) Ownable(msg.sender) {
        parentNode = _parentNode;

        // Reserve the five protocol-written keys. Hash once here so the
        // auth check in setText compares hashes, not variable-length strings.
        _reservedKey[keccak256(bytes("elo"))]           = true;
        _reservedKey[keccak256(bytes("match_count"))]   = true;
        _reservedKey[keccak256(bytes("last_match_id"))] = true;
        _reservedKey[keccak256(bytes("kind"))]          = true;
        _reservedKey[keccak256(bytes("inft_id"))]       = true;
    }

    // -------------------------------------------------------------------------
    // Minter management
    // -------------------------------------------------------------------------

    /// @notice Grant or revoke an address's right to call `mintSubname`.
    ///         Only the contract owner can call this.
    function setAuthorizedMinter(address minter, bool authorized) external onlyOwner {
        _authorizedMinters[minter] = authorized;
        emit AuthorizedMinterSet(minter, authorized);
    }

    /// @notice Returns true if `addr` may call `mintSubname`.
    function isAuthorizedMinter(address addr) external view returns (bool) {
        return addr == owner() || _authorizedMinters[addr];
    }

    // -------------------------------------------------------------------------
    // Namehash helpers
    // -------------------------------------------------------------------------

    /// @notice Compute the ENS namehash of `<label>.<parentNode>`.
    function subnameNode(string calldata label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    // -------------------------------------------------------------------------
    // Minting
    // -------------------------------------------------------------------------

    /// @notice Mint a new subname. Contract owner or authorised minter only.
    function mintSubname(string calldata label, address subnameOwner_) external returns (bytes32 node) {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();
        if (bytes(label).length == 0) revert EmptyLabel();
        if (subnameOwner_ == address(0)) revert ZeroAddressOwner();
        node = subnameNode(label);
        if (_subnames[node].exists) revert SubnameAlreadyExists();
        _subnames[node] = Subname({subnameOwner: subnameOwner_, exists: true});
        _subnameIndex.push(node);
        subnameCount += 1;
        emit SubnameMinted(label, label, node, subnameOwner_);
    }

    /// @notice Revoke (delete) an existing subname.
    ///         Owner-only (or authorized minter, e.g. AgentRegistry.burnAgent).
    ///         Removes the subname from the index and clears its owner.
    ///         Text records are left in storage (cheap, and historical reads
    ///         are harmless once the node is gone from the index).
    function revokeSubname(bytes32 node) external {
        if (msg.sender != owner() && !_authorizedMinters[msg.sender]) revert NotAuthorized();
        if (!_subnames[node].exists) revert SubnameDoesNotExist();

        // Swap-and-pop to keep _subnameIndex packed.
        uint256 len = _subnameIndex.length;
        for (uint256 i = 0; i < len; i++) {
            if (_subnameIndex[i] == node) {
                _subnameIndex[i] = _subnameIndex[len - 1];
                _subnameIndex.pop();
                break;
            }
        }

        delete _subnames[node];
        subnameCount -= 1;
        emit SubnameRevoked(node);
    }

    /// @notice Open self-registration: anyone can claim a subname for their own
    ///         wallet address. `msg.sender` becomes the subname owner — no owner
    ///         permission required. This is the decentralised path; `mintSubname`
    ///         (owner/minter-only) is kept for admin and protocol operations.
    function selfMintSubname(string calldata label) external returns (bytes32 node) {
        if (bytes(label).length == 0) revert EmptyLabel();
        node = subnameNode(label);
        if (_subnames[node].exists) revert SubnameAlreadyExists();
        _subnames[node] = Subname({subnameOwner: msg.sender, exists: true});
        _subnameIndex.push(node);
        subnameCount += 1;
        emit SubnameMinted(label, label, node, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Enumerable index
    // -------------------------------------------------------------------------

    /// @notice Return the node at a given index in mint order.
    ///         Reverts with `IndexOutOfRange` when `index >= subnameCount`.
    function subnameAt(uint256 index) external view returns (bytes32) {
        if (index >= _subnameIndex.length) revert IndexOutOfRange();
        return _subnameIndex[index];
    }

    // -------------------------------------------------------------------------
    // Resolver-style reads
    // -------------------------------------------------------------------------

    /// @notice ENS resolver-style owner lookup by namehash.
    function ownerOf(bytes32 node) external view returns (address) {
        return _subnames[node].subnameOwner;
    }

    /// @notice ENS resolver-style text record read. Returns "" if unset.
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _textRecords[node][key];
    }

    // -------------------------------------------------------------------------
    // Text record writes
    // -------------------------------------------------------------------------

    /// @notice Set a text record.
    ///
    ///         Reserved keys (`elo`, `match_count`, `last_match_id`, `kind`,
    ///         `inft_id`) can only be written by the contract owner or an
    ///         authorized minter — both are protocol-controlled, so ELO in a
    ///         subname is always a protocol claim, never a user assertion.
    ///
    ///         All other keys can be written by either the subname owner or the
    ///         contract owner.
    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!_subnames[node].exists) revert SubnameDoesNotExist();

        bool isOwner = msg.sender == owner();
        bool isProtocol = isOwner || _authorizedMinters[msg.sender];
        bool isSubnameOwner = msg.sender == _subnames[node].subnameOwner;

        if (_reservedKey[keccak256(bytes(key))]) {
            // Reserved keys: contract owner or authorized minter (protocol-controlled)
            if (!isProtocol) revert NotAuthorized();
        } else {
            // User-writable keys: subname owner or contract owner
            if (!isOwner && !isSubnameOwner) revert NotAuthorized();
        }

        _textRecords[node][key] = value;
        emit TextRecordSet(node, key, value);
    }
}
