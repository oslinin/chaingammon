// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockOgStorage
 * @notice Localhost-only stand-in for 0G Storage (0G's distributed blob-store network).
 * Uses keccak256 as the content address rather than 0G's Merkle root. The on-chain
 * consumers — gameRecordHash on MatchRegistry and dataHashes[*] on AgentRegistry — treat
 * the stored value as an opaque bytes32, so the swap is safe within a single network.
 * Hashes produced on localhost have no meaning on testnet and vice versa.
 */
contract MockOgStorage {
    /// @dev Content-addressed blob store. Key is keccak256(data).
    mapping(bytes32 => bytes) private blobs;

    /// @dev Existence flag separate from blobs so a stored zero-length value (which we
    /// reject at put time) cannot be confused with "not present."
    mapping(bytes32 => bool) private stored;

    /// @notice Emitted when a blob is successfully stored.
    event Stored(bytes32 indexed rootHash, uint256 length);

    /**
     * @notice Store bytes and return their keccak256 content hash.
     * @dev Idempotent: putting the same bytes twice does not revert and produces the same
     * rootHash. Empty data is rejected.
     * @param data Raw bytes to store.
     * @return rootHash keccak256 of data — used as the address for get() and exists().
     */
    function put(bytes calldata data) external returns (bytes32 rootHash) {
        require(data.length != 0, "MockOgStorage: empty data");
        rootHash = keccak256(data);
        blobs[rootHash] = data;
        stored[rootHash] = true;
        emit Stored(rootHash, data.length);
    }

    /**
     * @notice Retrieve bytes by their content hash.
     * @param rootHash keccak256 of the data, as returned by put().
     * @return The stored bytes.
     */
    function get(bytes32 rootHash) external view returns (bytes memory) {
        require(stored[rootHash], "MockOgStorage: blob not found");
        return blobs[rootHash];
    }

    /**
     * @notice Check whether a blob has been stored.
     * @param rootHash keccak256 of the data.
     * @return True if the blob was previously stored via put().
     */
    function exists(bytes32 rootHash) external view returns (bool) {
        return stored[rootHash];
    }
}
