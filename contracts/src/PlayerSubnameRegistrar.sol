// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title PlayerSubnameRegistrar — ENS-shaped subname registrar for
///        chaingammon player profiles.
///
/// @notice v1 is a self-contained registrar (deployed alongside the rest
///         of the protocol on 0G testnet). Each player gets a subname
///         like `alice.chaingammon.eth` whose ENS-format namehash is
///         derived from the parent node passed at construction. Reputation
///         is split between a typed `eloOf(node)` numeric record (default
///         1500 at mint, writable only by authorized minters) and ENS-style
///         text records for everything else: `match_count`, `last_match_id`,
///         `style_uri`, `archive_uri`, `kind`, `inft_id`.
///
///         A v2 deployment can mirror this state to real ENS on
///         Sepolia/Linea: the contract is ENS-shaped (namehash, text
///         records, owner-of resolver semantics) and any ENS resolver
///         can be pointed at it. ELO is exposed via the standard
///         `text(node, "elo")` getter as a string (decimal of the typed
///         value) for ENS-resolver compatibility.
///
/// @dev    Permissioning:
///          - Contract owner mints subnames + manages the authorized-
///            minter allowlist. Owner alone CANNOT write reserved fields.
///          - Authorized minters (e.g. AgentRegistry, MatchRegistry post-
///            settlement) are the only writers of reserved fields:
///            `elo` via `setElo`, and the remaining text-record reserved
///            keys (`match_count`, `last_match_id`, `kind`, `inft_id`)
///            via `setText`.
///          - `setText(node, "elo", ...)` reverts unconditionally — use
///            `setElo` instead. This sidesteps "what does setText with
///            the elo key mean" rather than leaving it ambiguous.
///          - Default `elo == 1500` is written inline at mint time (both
///            `mintSubname` and `selfMintSubname`) so every subname has
///            the right rating from creation; no UI fallback needed.
///          - All non-reserved keys remain dual-auth: subname owner or
///            authorized minter (NOT the bare contract owner — owner has
///            to use the explicit minter allowlist for parity).
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

    /// @notice node → typed ELO rating. Default 1500 written inline at mint
    ///         (both `mintSubname` and `selfMintSubname`). Writable only by
    ///         authorized minters via `setElo`. Read via `eloOf` (typed) or
    ///         `text(node, "elo")` (string-encoded for ENS-resolver compat).
    mapping(bytes32 => uint256) private _elo;

    /// @notice Default ELO assigned to every newly-minted subname.
    uint256 public constant INITIAL_ELO = 1500;

    /// @notice Ordered list of all minted nodes — enables enumeration.
    bytes32[] private _subnameIndex;

    /// @notice keccak256(key) → true when only an authorized minter may write
    ///         that key. Populated in the constructor; never mutated after.
    mapping(bytes32 => bool) private _reservedKey;

    /// @notice Addresses authorised to call `mintSubname` in addition to the
    ///         contract owner. Set via `setAuthorizedMinter`.
    mapping(address => bool) private _authorizedMinters;

    event SubnameMinted(string indexed labelHashed, string label, bytes32 indexed node, address indexed subnameOwner);
    event TextRecordSet(bytes32 indexed node, string key, string value);
    event AuthorizedMinterSet(address indexed minter, bool authorized);
    event EloSet(bytes32 indexed node, uint256 value);

    error EmptyLabel();
    error SubnameAlreadyExists();
    error SubnameDoesNotExist();
    error NotAuthorized();
    error ZeroAddressOwner();
    error IndexOutOfRange();
    /// @notice setText cannot be used for the elo key — use setElo instead.
    error UseSetElo();

    constructor(bytes32 _parentNode) Ownable(msg.sender) {
        parentNode = _parentNode;

        // Reserve the four remaining protocol-written text keys. ELO is
        // handled separately as a typed numeric record (see `setElo`).
        // Hash once here so the auth check in setText compares hashes, not
        // variable-length strings.
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
        _seedDefaults(node);
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
        _seedDefaults(node);
    }

    /// @dev Write protocol-default fields on a freshly minted subname.
    ///      Currently just `_elo[node] = 1500`. New defaults belong here so
    ///      every mint path picks them up automatically.
    function _seedDefaults(bytes32 node) internal {
        _elo[node] = INITIAL_ELO;
        emit EloSet(node, INITIAL_ELO);
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

    /// @notice ENS resolver-style text record read. Returns "" for unset
    ///         non-reserved keys. The `elo` key is special-cased: it's not a
    ///         text record at all (use `setElo` to write), but readers of the
    ///         standard ENS resolver shape get the decimal-encoded current
    ///         value via this getter for compatibility.
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        if (keccak256(bytes(key)) == keccak256(bytes("elo"))) {
            return Strings.toString(_elo[node]);
        }
        return _textRecords[node][key];
    }

    /// @notice Typed ELO read.
    function eloOf(bytes32 node) external view returns (uint256) {
        return _elo[node];
    }

    // -------------------------------------------------------------------------
    // ELO write (typed)
    // -------------------------------------------------------------------------

    /// @notice Update a subname's ELO. Only authorized minters may call —
    ///         neither the contract owner (without minter role) nor the
    ///         subname owner can set ELO directly. Match settlement contracts
    ///         on the minter allowlist are the canonical writers.
    function setElo(bytes32 node, uint256 value) external {
        if (!_subnames[node].exists) revert SubnameDoesNotExist();
        if (!_authorizedMinters[msg.sender]) revert NotAuthorized();
        _elo[node] = value;
        emit EloSet(node, value);
    }

    // -------------------------------------------------------------------------
    // Text record writes
    // -------------------------------------------------------------------------

    /// @notice Set a text record.
    ///
    ///         The `elo` key is rejected unconditionally — use `setElo`
    ///         (typed numeric writer) instead.
    ///
    ///         Reserved text keys (`match_count`, `last_match_id`, `kind`,
    ///         `inft_id`) can be written ONLY by an address on the
    ///         authorized-minter allowlist. The contract owner does not get
    ///         an override on these; closing the branch keeps reputation
    ///         fields unforgeable by an EOA admin.
    ///
    ///         Non-reserved keys (bio, avatar, archive_uri, ...) can be
    ///         written by the subname owner, the contract owner, or any
    ///         authorized minter — the looser auth here is fine because
    ///         these keys don't carry rated-play state.
    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!_subnames[node].exists) revert SubnameDoesNotExist();

        bytes32 keyHash = keccak256(bytes(key));
        if (keyHash == keccak256(bytes("elo"))) revert UseSetElo();

        bool isOwner = msg.sender == owner();
        bool isAuthorized = _authorizedMinters[msg.sender];
        bool isSubnameOwner = msg.sender == _subnames[node].subnameOwner;

        if (_reservedKey[keyHash]) {
            // Reserved text keys: authorized minter only — owner does NOT
            // get a bypass here (this is the ELO-class lockdown).
            if (!isAuthorized) revert NotAuthorized();
        } else {
            // Non-reserved keys: subname owner, contract owner, or
            // authorized minter. These are stylistic / informational fields.
            if (!isOwner && !isAuthorized && !isSubnameOwner) revert NotAuthorized();
        }

        _textRecords[node][key] = value;
        emit TextRecordSet(node, key, value);
    }
}
