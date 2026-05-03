// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockNameWrapper — minimal mock of ENS NameWrapper for unit tests.
///
/// Implements the subset of NameWrapper used by PlayerSubnameRegistrar:
///   - setSubnodeRecord(parentNode, label, owner, resolver, ttl, fuses, expiry)
///   - setSubnodeOwner(parentNode, label, owner, fuses, expiry)
///   - getData(uint256 id)
/// And exposes a tiny ENS-shaped owner registry so tests can assert that
/// minting a subname recorded the expected owner.
contract MockNameWrapper {
    struct NodeData {
        address owner;
        uint32 fuses;
        uint64 expiry;
    }

    mapping(bytes32 => NodeData) private _nodes;

    event SubnodeRecordSet(
        bytes32 indexed parentNode,
        string label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry,
        bytes32 node
    );
    event SubnodeOwnerSet(
        bytes32 indexed parentNode,
        string label,
        address owner,
        uint32 fuses,
        uint64 expiry,
        bytes32 node
    );

    function _node(bytes32 parentNode, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node) {
        node = _node(parentNode, label);
        _nodes[node] = NodeData({owner: owner, fuses: fuses, expiry: expiry});
        emit SubnodeRecordSet(parentNode, label, owner, resolver, ttl, fuses, expiry, node);
    }

    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node) {
        node = _node(parentNode, label);
        _nodes[node] = NodeData({owner: owner, fuses: fuses, expiry: expiry});
        emit SubnodeOwnerSet(parentNode, label, owner, fuses, expiry, node);
    }

    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry) {
        NodeData memory d = _nodes[bytes32(id)];
        return (d.owner, d.fuses, d.expiry);
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _nodes[bytes32(id)].owner;
    }
}
