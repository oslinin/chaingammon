// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAgentRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IMatchEscrowToken {
    function deposit(bytes32 matchId, uint256 amount) external;
}

/// @title AgentVaultToken — ERC-20 counterpart to AgentVault.
/// @notice Holds a single ERC-20 token (intended to be USDC) on behalf of
///         every agent NFT. The permission model (owner / operator allowance)
///         mirrors AgentVault exactly; only the transfer mechanics differ.
///
/// @dev    `depositToEscrow` approves the target escrow contract and calls
///         `IMatchEscrowToken.deposit`, which pulls the tokens via transferFrom.
contract AgentVaultToken {
    IAgentRegistry public immutable registry;
    IERC20         public immutable token;

    mapping(uint256 => uint256) public balances;
    mapping(uint256 => mapping(address => uint256)) public allowances;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event AllowanceSet(uint256 indexed agentId, address indexed operator, uint256 amount);
    event StakeDeposited(uint256 indexed agentId, bytes32 indexed matchId, uint256 stake, address indexed operator);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAmount();

    constructor(IAgentRegistry registry_, IERC20 token_) {
        registry = registry_;
        token = token_;
    }

    // ─── funding ──────────────────────────────────────────────────────────────

    /// @notice Pull `amount` tokens from the caller and credit them to `agentId`.
    ///         Caller must have approved this contract for at least `amount`.
    function deposit(uint256 agentId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.transferFrom(msg.sender, address(this), amount);
        balances[agentId] += amount;
        emit Deposited(agentId, msg.sender, amount);
    }

    // ─── owner-only ───────────────────────────────────────────────────────────

    function withdraw(uint256 agentId, address to, uint256 amount) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        if (amount > balances[agentId]) revert InsufficientBalance();
        balances[agentId] -= amount;
        token.transfer(to, amount);
        emit Withdrawn(agentId, to, amount);
    }

    function withdrawAll(uint256 agentId, address to) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        uint256 amount = balances[agentId];
        if (amount == 0) revert ZeroAmount();
        balances[agentId] = 0;
        token.transfer(to, amount);
        emit Withdrawn(agentId, to, amount);
    }

    function approve(uint256 agentId, address operator, uint256 amount) external {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        allowances[agentId][operator] = amount;
        emit AllowanceSet(agentId, operator, amount);
    }

    // ─── operator ─────────────────────────────────────────────────────────────

    /// @notice Forward `stake` tokens from the agent's vault balance into a
    ///         MatchEscrowUsdc contract. Approves the escrow first so it can
    ///         pull via transferFrom.
    function depositToEscrow(
        uint256 agentId,
        bytes32 matchId,
        uint256 stake,
        address escrow
    ) external {
        bool isOwner = msg.sender == registry.ownerOf(agentId);
        if (!isOwner) {
            if (allowances[agentId][msg.sender] < stake) revert InsufficientAllowance();
            allowances[agentId][msg.sender] -= stake;
        }
        if (balances[agentId] < stake) revert InsufficientBalance();
        balances[agentId] -= stake;
        token.approve(escrow, stake);
        IMatchEscrowToken(escrow).deposit(matchId, stake);
        emit StakeDeposited(agentId, matchId, stake, msg.sender);
    }
}
