// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MatchEscrowUsdc — per-match USDC stake escrow for Chaingammon.
/// @notice Drop-in replacement for MatchEscrow that uses an ERC-20 token
///         (intended to be Circle's USDC) instead of native ETH. The
///         match lifecycle, settler pattern, and settlement hooks are
///         identical; only the token transfer mechanics differ.
///
/// @dev    Callers must `token.approve(address(this), amount)` before calling
///         `deposit`. The settler (MatchRegistry) calls `payoutWinner` or
///         `payoutSplit` at settlement, exactly as with the ETH escrow.
contract MatchEscrowUsdc {
    enum Status { Empty, Deposited, Refunded, PaidOut }

    struct Side {
        address player;
        uint128 amount;
        Status  status;
    }

    struct Match {
        Side a;
        Side b;
        bool open;
        bool settled;
    }

    IERC20  public immutable token;
    address public immutable settler;

    mapping(bytes32 => Match) private _matches;

    event Deposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Opened(bytes32 indexed matchId, address playerA, address playerB, uint256 pot);
    event Refunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event PaidOut(bytes32 indexed matchId, address indexed winner, uint256 amount);

    error AlreadyDeposited();
    error AlreadySettled();
    error MatchNotOpen();
    error MatchAlreadyOpen();
    error NotDepositor();
    error NothingToRefund();
    error NotSettler();
    error NoSettlerConfigured();
    error WrongStakeAmount();
    error EmptyWinners();
    error LengthMismatch();
    error ZeroAddressWinner();
    error ShareSumMismatch();

    constructor(IERC20 token_, address settler_) {
        token = token_;
        settler = settler_;
    }

    /// @notice Pull `amount` tokens from the caller into escrow for `matchId`.
    ///         Caller must have approved this contract for at least `amount`.
    function deposit(bytes32 matchId, uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);

        Match storage m = _matches[matchId];
        if (m.settled) revert AlreadySettled();

        if (m.a.status == Status.Empty) {
            m.a = Side({player: msg.sender, amount: uint128(amount), status: Status.Deposited});
            emit Deposited(matchId, msg.sender, amount);
            return;
        }
        if (m.b.status == Status.Empty) {
            if (m.a.player == msg.sender) revert AlreadyDeposited();
            if (uint256(m.a.amount) != amount) revert WrongStakeAmount();
            m.b = Side({player: msg.sender, amount: uint128(amount), status: Status.Deposited});
            m.open = true;
            emit Deposited(matchId, msg.sender, amount);
            emit Opened(matchId, m.a.player, m.b.player,
                        uint256(m.a.amount) + uint256(m.b.amount));
            return;
        }
        revert MatchAlreadyOpen();
    }

    /// @notice Refund the caller's deposit. Only before the match is open.
    function refund(bytes32 matchId) external {
        Match storage m = _matches[matchId];
        if (m.settled) revert AlreadySettled();
        if (m.open) revert MatchAlreadyOpen();

        Side storage s;
        if (m.a.player == msg.sender && m.a.status == Status.Deposited) {
            s = m.a;
        } else if (m.b.player == msg.sender && m.b.status == Status.Deposited) {
            s = m.b;
        } else {
            revert NothingToRefund();
        }

        uint256 amount = s.amount;
        s.status = Status.Refunded;
        s.amount = 0;

        token.transfer(msg.sender, amount);
        emit Refunded(matchId, msg.sender, amount);
    }

    /// @notice Settler-only: transfer the full pot to `winner`.
    function payoutWinner(bytes32 matchId, address winner) external {
        if (settler == address(0)) revert NoSettlerConfigured();
        if (msg.sender != settler) revert NotSettler();

        Match storage m = _matches[matchId];
        if (!m.open) revert MatchNotOpen();
        if (m.settled) revert AlreadySettled();
        if (winner != m.a.player && winner != m.b.player) revert NotDepositor();

        uint256 pot_ = uint256(m.a.amount) + uint256(m.b.amount);
        m.settled = true;
        m.a.status = Status.PaidOut;
        m.b.status = Status.PaidOut;
        m.a.amount = 0;
        m.b.amount = 0;

        token.transfer(winner, pot_);
        emit PaidOut(matchId, winner, pot_);
    }

    /// @notice Settler-only: split the pot across multiple recipients.
    function payoutSplit(
        bytes32 matchId,
        address[] calldata winners,
        uint256[] calldata shares
    ) external {
        if (settler == address(0)) revert NoSettlerConfigured();
        if (msg.sender != settler) revert NotSettler();
        if (winners.length == 0) revert EmptyWinners();
        if (winners.length != shares.length) revert LengthMismatch();

        Match storage m = _matches[matchId];
        if (!m.open) revert MatchNotOpen();
        if (m.settled) revert AlreadySettled();

        uint256 pot_ = uint256(m.a.amount) + uint256(m.b.amount);
        uint256 sum;
        for (uint256 i = 0; i < winners.length; ++i) {
            if (winners[i] == address(0)) revert ZeroAddressWinner();
            sum += shares[i];
        }
        if (sum != pot_) revert ShareSumMismatch();

        m.settled = true;
        m.a.status = Status.PaidOut;
        m.b.status = Status.PaidOut;
        m.a.amount = 0;
        m.b.amount = 0;

        for (uint256 i = 0; i < winners.length; ++i) {
            uint256 share = shares[i];
            if (share == 0) continue;
            token.transfer(winners[i], share);
            emit PaidOut(matchId, winners[i], share);
        }
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }

    function pot(bytes32 matchId) external view returns (uint256) {
        Match storage m = _matches[matchId];
        return uint256(m.a.amount) + uint256(m.b.amount);
    }
}
