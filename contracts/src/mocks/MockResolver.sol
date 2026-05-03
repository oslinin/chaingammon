// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockResolver — minimal mock of an ENS PublicResolver for unit tests.
///
/// Implements just text() and setText() with the same shape as the real
/// PublicResolver, so PlayerSubnameRegistrar can write reputation records
/// (elo, match_count, last_match_id, kind, inft_id) and tests can read them
/// back to assert on side effects.
contract MockResolver {
    mapping(bytes32 => mapping(string => string)) private _texts;

    event TextChanged(
        bytes32 indexed node,
        string indexed indexedKey,
        string key,
        string value
    );

    function setText(bytes32 node, string calldata key, string calldata value) external {
        _texts[node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][key];
    }
}
