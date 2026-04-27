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
/// @dev    Permissioning:
///          - Only the contract owner (the server) can mint subnames.
///          - Text records can be updated by either the subname owner
///            or the contract owner. The server pushes ELO/etc. updates
///            after every match; the player can update freeform fields
///            on their own profile.
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

    event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner);
    event TextRecordSet(bytes32 indexed node, string key, string value);

    error EmptyLabel();
    error SubnameAlreadyExists();
    error SubnameDoesNotExist();
    error NotAuthorized();
    error ZeroAddressOwner();

    constructor(bytes32 _parentNode) Ownable(msg.sender) {
        parentNode = _parentNode;
    }

    /// @notice Compute the ENS namehash of `<label>.<parentNode>`.
    function subnameNode(string calldata label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @notice Mint a new subname. Owner-only in v1; v2 may open this up.
    function mintSubname(string calldata label, address subnameOwner_) external onlyOwner returns (bytes32 node) {
        if (bytes(label).length == 0) revert EmptyLabel();
        if (subnameOwner_ == address(0)) revert ZeroAddressOwner();
        node = subnameNode(label);
        if (_subnames[node].exists) revert SubnameAlreadyExists();
        _subnames[node] = Subname({subnameOwner: subnameOwner_, exists: true});
        subnameCount += 1;
        emit SubnameMinted(label, label, node, subnameOwner_);
    }

    /// @notice ENS resolver-style owner lookup by namehash.
    function ownerOf(bytes32 node) external view returns (address) {
        return _subnames[node].subnameOwner;
    }

    /// @notice ENS resolver-style text record read. Returns "" if unset.
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _textRecords[node][key];
    }

    /// @notice Set a text record. Subname owner or contract owner only.
    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!_subnames[node].exists) revert SubnameDoesNotExist();
        if (msg.sender != _subnames[node].subnameOwner && msg.sender != owner()) {
            revert NotAuthorized();
        }
        _textRecords[node][key] = value;
        emit TextRecordSet(node, key, value);
    }
}
