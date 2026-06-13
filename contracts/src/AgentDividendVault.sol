// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder interfaces — not implemented in this PR.
// These document the intended v2 surface for ETHGlobal NYC hackathon reviewers.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev V2: ERC-4626 tokenised vault so equity shares are transferable LP tokens.
///      Bonding curve pricing (shares cost more as supply fills) captures P/E growth.
///      e.g. price(n) = BASE_PRICE * (1 + n / MAX_SHARES)
interface IAgentEquityVaultV2 {
    /// @dev ERC-4626 mint: deposit USDC, receive vault shares as ERC-20 tokens.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    /// @dev ERC-4626 redeem: burn vault shares, receive USDC proportionally.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    /// @dev Bonding-curve quote: how much USDC `numShares` costs right now.
    function quoteBuy(uint256 agentId, uint256 numShares) external view returns (uint256 cost);
}

/// @dev V2: Basket / index bets — buy weighted exposure across multiple agents.
interface IAgentBasket {
    /// @dev Buy a proportionally-split position across `agentIds` at `weights` (sum=1e18).
    function buyBasket(uint256[] calldata agentIds, uint256[] calldata weights, uint256 usdcAmount) external;
    function claimBasket(uint256 basketId) external;
}

/// @dev V2: Elo-collateralised borrowing — agent borrows USDC against
///      expected future winnings discounted by its current Elo score.
interface IAgentEloLending {
    function borrow(uint256 agentId, uint256 usdcAmount) external;
    function repay(uint256 agentId, uint256 usdcAmount) external;
    function liquidationPrice(uint256 agentId) external view returns (uint256 eloThreshold);
}

/// @dev V2: Puts on agent performance — hedge equity downside if Elo drops below strike.
interface IAgentPerformancePut {
    function buyPut(uint256 agentId, uint256 strikeElo, uint256 expiry, uint256 premium) external;
    function exercise(uint256 agentId, uint256 optionId) external;
}

// ─────────────────────────────────────────────────────────────────────────────
// MVP implementation
// ─────────────────────────────────────────────────────────────────────────────

/// @title AgentDividendVault — equity shares + USDC dividend distribution per agent.
///
/// @notice Stakeholders buy shares in an agent; the operator (server) deposits
///         USDC from tournament winnings; holders claim their pro-rata cut.
///
/// @dev    Uses a MasterChef-style per-share accumulator for O(1) claims
///         with no on-chain holder enumeration.
///
///         MVP pricing: 1 share = SHARE_PRICE USDC (flat, 6 decimals).
///         V2 will replace this with a bonding curve (IAgentEquityVaultV2).
contract AgentDividendVault {
    // ── constants ────────────────────────────────────────────────────────────

    /// @notice Fixed share price: 1 USDC (6-decimal token).
    uint256 public constant SHARE_PRICE = 1_000_000;

    /// @notice Maximum shares per agent (1 M). V2 will be dynamic via bonding curve.
    uint64  public constant MAX_SHARES_PER_AGENT = 1_000_000;

    /// @dev Accumulator precision: multiply per-share dividend by this to keep
    ///      fractional USDC in integer math. 1e12 gives 12 extra decimal places.
    uint256 private constant PRECISION = 1e12;

    // ── state ─────────────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    address public operator;

    struct VaultInfo {
        /// @dev Accumulated USDC per share * PRECISION.
        uint128 accPerShare;
        uint64  totalShares;
    }

    struct UserInfo {
        uint64  shares;
        /// @dev shares * accPerShare / PRECISION at the time of last action.
        ///      Subtracting this from the current value gives unclaimed USDC.
        uint128 rewardDebt;
    }

    mapping(uint256 agentId => VaultInfo) public vaults;
    mapping(uint256 agentId => mapping(address holder => UserInfo)) public users;

    // ── events ────────────────────────────────────────────────────────────────

    event SharesBought(uint256 indexed agentId, address indexed buyer, uint64 amount, uint256 cost);
    event DividendDeposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event DividendClaimed(uint256 indexed agentId, address indexed holder, uint256 amount);
    event OperatorUpdated(address indexed prev, address indexed next);

    // ── errors ────────────────────────────────────────────────────────────────

    error NotOperator();
    error ZeroAmount();
    error CapExceeded(uint256 requested, uint256 remaining);
    error NoShareholders();
    error TransferFailed();

    // ── constructor ───────────────────────────────────────────────────────────

    constructor(IERC20 usdc_, address operator_) {
        usdc     = usdc_;
        operator = operator_;
    }

    // ── external: equity ─────────────────────────────────────────────────────

    /// @notice Buy `amount` shares in `agentId`.
    ///         Caller must have approved this contract for `amount * SHARE_PRICE` USDC.
    function buyShares(uint256 agentId, uint64 amount) external {
        if (amount == 0) revert ZeroAmount();

        VaultInfo storage vault = vaults[agentId];
        uint64 remaining = MAX_SHARES_PER_AGENT - vault.totalShares;
        if (amount > remaining) revert CapExceeded(amount, remaining);

        uint256 cost = uint256(amount) * SHARE_PRICE;
        usdc.transferFrom(msg.sender, address(this), cost);

        // Settle any accrued dividend before changing share balance.
        _settlePending(agentId, msg.sender, vault);

        UserInfo storage user = users[agentId][msg.sender];
        user.shares      += amount;
        vault.totalShares += amount;
        // New shares start tracking from the current accumulator level so
        // the buyer cannot claim dividends deposited before their purchase.
        user.rewardDebt = _debt(user.shares, vault.accPerShare);

        emit SharesBought(agentId, msg.sender, amount, cost);
    }

    // ── external: dividends ───────────────────────────────────────────────────

    /// @notice Operator deposits `amount` USDC as dividends for `agentId`.
    ///         Caller must have approved this contract for `amount` USDC.
    ///         Reverts if there are no shareholders yet (avoids lost tokens).
    function depositDividend(uint256 agentId, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        if (amount == 0) revert ZeroAmount();

        VaultInfo storage vault = vaults[agentId];
        if (vault.totalShares == 0) revert NoShareholders();

        usdc.transferFrom(msg.sender, address(this), amount);

        // Distribute pro-rata across all existing shareholders.
        vault.accPerShare += uint128(amount * PRECISION / uint256(vault.totalShares));

        emit DividendDeposited(agentId, msg.sender, amount);
    }

    /// @notice Claim all pending USDC dividends for the caller in `agentId`.
    function claimDividend(uint256 agentId) external {
        VaultInfo storage vault = vaults[agentId];
        _settlePending(agentId, msg.sender, vault);
        // Snap debt to current level so no double-claim.
        users[agentId][msg.sender].rewardDebt = _debt(users[agentId][msg.sender].shares, vault.accPerShare);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function sharesOf(uint256 agentId, address holder) external view returns (uint64) {
        return users[agentId][holder].shares;
    }

    function pendingDividend(uint256 agentId, address holder) public view returns (uint256) {
        VaultInfo storage vault = vaults[agentId];
        UserInfo  storage user  = users[agentId][holder];
        if (user.shares == 0) return 0;
        uint256 gross = uint256(_debt(user.shares, vault.accPerShare));
        uint256 debt  = uint256(user.rewardDebt);
        return gross > debt ? gross - debt : 0;
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function setOperator(address next) external {
        if (msg.sender != operator) revert NotOperator();
        emit OperatorUpdated(operator, next);
        operator = next;
    }

    // ── internal ─────────────────────────────────────────────────────────────

    function _settlePending(uint256 agentId, address holder, VaultInfo storage /*vault*/) internal {
        uint256 pending = pendingDividend(agentId, holder);
        if (pending > 0) {
            usdc.transfer(holder, pending);
            emit DividendClaimed(agentId, holder, pending);
        }
    }

    function _debt(uint64 shares, uint128 accPerShare) internal pure returns (uint128) {
        return uint128(uint256(shares) * uint256(accPerShare) / PRECISION);
    }
}
