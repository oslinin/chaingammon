// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IMatchEscrow {
    function deposit(bytes32 matchId, uint256 expected) external payable;
}

/**
 * @title AgentVault
 * @notice Single contract that holds ETH on behalf of every agent NFT.
 *
 * Roles:
 *   Owner   — the ERC-721 owner of the agent NFT. Can deposit, withdraw, and
 *             grant/revoke an operator allowance.
 *   Operator — an address (the server's public key) pre-approved by the owner
 *             to spend up to `allowance[agentId][operator]` wei for match
 *             stakes. Cannot withdraw to arbitrary addresses.
 *
 * This replaces the server-held per-agent keystore. The server still signs
 * the `depositToEscrow` call with its own key, but that key has no access to
 * the funds other than forwarding them to `MatchEscrow`. Withdrawals go
 * directly through the owner's connected wallet — no server signature needed.
 */
contract AgentVault {
    IAgentRegistry public immutable registry;

    /// @notice ETH balance per agent (in wei).
    mapping(uint256 => uint256) public balances;

    /// @notice Spending allowance: operator may call depositToEscrow up to this amount.
    mapping(uint256 => mapping(address => uint256)) public allowances;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event AllowanceSet(uint256 indexed agentId, address indexed operator, uint256 amount);
    event StakeDeposited(uint256 indexed agentId, bytes32 indexed matchId, uint256 stake, address indexed operator);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferFailed();
    error ZeroAmount();

    constructor(address _registry) {
        registry = IAgentRegistry(_registry);
    }

    // ─── funding ──────────────────────────────────────────────────────────────

    /// @notice Fund the agent's balance. Anyone can call; ETH is credited to `agentId`.
    function deposit(uint256 agentId) external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[agentId] += msg.value;
        emit Deposited(agentId, msg.sender, msg.value);
    }

    // ─── owner-only ───────────────────────────────────────────────────────────

    /// @notice Withdraw `amount` wei to `to`. Only callable by the NFT owner.
    function withdraw(uint256 agentId, address payable to, uint256 amount) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        if (amount > balances[agentId]) revert InsufficientBalance();
        balances[agentId] -= amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(agentId, to, amount);
    }

    /// @notice Withdraw the full balance to `to`. Only callable by the NFT owner.
    function withdrawAll(uint256 agentId, address payable to) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        uint256 amount = balances[agentId];
        if (amount == 0) revert ZeroAmount();
        balances[agentId] = 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(agentId, to, amount);
    }

    /// @notice Grant `operator` permission to spend up to `amount` wei for match stakes.
    ///         Set to 0 to revoke. Only callable by the NFT owner.
    function approve(uint256 agentId, address operator, uint256 amount) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        allowances[agentId][operator] = amount;
        emit AllowanceSet(agentId, operator, amount);
    }

    // ─── operator ─────────────────────────────────────────────────────────────

    /// @notice Post the agent's stake into MatchEscrow. Caller must be an approved
    ///         operator with sufficient allowance. Deducts from both balance and allowance.
    function depositToEscrow(
        uint256 agentId,
        bytes32 matchId,
        uint256 stake,
        address escrow
    ) external {
        if (allowances[agentId][msg.sender] < stake) revert InsufficientAllowance();
        if (balances[agentId] < stake) revert InsufficientBalance();
        allowances[agentId][msg.sender] -= stake;
        balances[agentId] -= stake;
        IMatchEscrow(escrow).deposit{value: stake}(matchId, stake);
        emit StakeDeposited(agentId, matchId, stake, msg.sender);
    }
}
