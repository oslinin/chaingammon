// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MatchEscrow — per-match stake escrow for Chaingammon.
/// @notice Both sides deposit their stake before a match starts; the
///         winner takes the pot (minus an optional protocol fee) at
///         settlement. Either side can refund their own deposit before
///         the match is settled, but only if the counterparty hasn't
///         deposited yet — once both sides are funded the match is
///         "open" and refunds require dispute resolution.
///
/// @dev    Identifies matches by `bytes32 matchId` rather than a
///         monotonic counter so the matchId can be the off-chain
///         `keccak256(playerA || playerB || nonce)` used at game
///         start, letting the escrow be addressed before the match
///         ever appears in `MatchRegistry`. `MatchRegistry.settle*`
///         is the canonical caller of `payoutWinner`.
///
///         Out of scope (post-hackathon, per ROADMAP.md): two-of-two
///         multisig withdrawal, draw splits, dispute resolution
///         beyond simple "refund-before-open."
contract MatchEscrow {
    /// @notice Status flags packed into the per-side struct.
    /// `Empty` is the zero-value default and represents "no deposit
    /// from this side yet."
    enum Status {
        Empty,
        Deposited,
        Refunded,
        PaidOut
    }

    struct Side {
        address player;     // who deposited; zero before deposit
        uint128 amount;     // stake in wei
        Status  status;
    }

    struct Match {
        Side a;
        Side b;
        bool  open;          // true once both sides have deposited
        bool  settled;       // true once payoutWinner has been called
    }

    /// @notice Settlement contract authorized to call `payoutWinner`.
    /// Set once at construction; making it `address(0)` disables
    /// payouts entirely (useful for a deploy-but-not-yet-wired
    /// staging step).
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

    constructor(address settler_) {
        settler = settler_;
    }

    /// @notice Deposit a stake for `matchId`. Each side deposits
    ///         independently; the second deposit "opens" the match
    ///         and atomically locks both stakes against refund.
    /// @param  matchId  off-chain `keccak256(...)` match identifier.
    /// @param  expected stake amount in wei. Both sides must send the
    ///         same amount; the second depositor reverts on mismatch.
    function deposit(bytes32 matchId, uint256 expected) external payable {
        if (msg.value != expected) revert WrongStakeAmount();

        Match storage m = _matches[matchId];
        if (m.settled) revert AlreadySettled();

        // First or second deposit?
        if (m.a.status == Status.Empty) {
            m.a = Side({
                player: msg.sender,
                amount: uint128(msg.value),
                status: Status.Deposited
            });
            emit Deposited(matchId, msg.sender, msg.value);
            return;
        }
        if (m.b.status == Status.Empty) {
            // Second side cannot be the same address.
            if (m.a.player == msg.sender) revert AlreadyDeposited();
            // And must match the first side's stake (one-pot match).
            if (uint256(m.a.amount) != msg.value) revert WrongStakeAmount();
            m.b = Side({
                player: msg.sender,
                amount: uint128(msg.value),
                status: Status.Deposited
            });
            m.open = true;
            emit Deposited(matchId, msg.sender, msg.value);
            emit Opened(matchId, m.a.player, m.b.player,
                        uint256(m.a.amount) + uint256(m.b.amount));
            return;
        }

        // Both sides already filled.
        revert MatchAlreadyOpen();
    }

    /// @notice Refund the caller's deposit. Only allowed before the
    ///         match opens (i.e. before the second side deposits).
    /// @dev    Once both sides are deposited the funds are locked
    ///         until `payoutWinner` is called by `settler`.
    function refund(bytes32 matchId) external {
        Match storage m = _matches[matchId];
        if (m.settled) revert AlreadySettled();
        if (m.open) revert MatchAlreadyOpen();

        Side storage s;
        if (m.a.player == msg.sender && m.a.status == Status.Deposited) {
            s = m.a;
        } else if (m.b.player == msg.sender && m.b.status == Status.Deposited) {
            // Note: m.b is empty until the second deposit, so this branch
            // only fires in the (degenerate) case where someone called
            // deposit twice from the same address — not possible per the
            // AlreadyDeposited check above, but kept for symmetry.
            s = m.b;
        } else {
            revert NothingToRefund();
        }

        uint256 amount = s.amount;
        s.status = Status.Refunded;
        s.amount = 0;

        // Effects-then-interactions: status flipped before the call.
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "refund: transfer failed");

        emit Refunded(matchId, msg.sender, amount);
    }

    /// @notice Settler-only: send the full pot to `winner`. Reverts
    ///         if the match isn't open or has already been paid.
    /// @dev    The winner address MUST be one of the two depositors.
    ///         The settler (MatchRegistry post-settle hook in v1) is
    ///         responsible for verifying signatures + proper outcome
    ///         before calling here.
    function payoutWinner(bytes32 matchId, address winner) external {
        if (settler == address(0)) revert NoSettlerConfigured();
        if (msg.sender != settler) revert NotSettler();

        Match storage m = _matches[matchId];
        if (!m.open) revert MatchNotOpen();
        if (m.settled) revert AlreadySettled();
        if (winner != m.a.player && winner != m.b.player) {
            revert NotDepositor();
        }

        uint256 pot_ = uint256(m.a.amount) + uint256(m.b.amount);
        m.settled = true;
        m.a.status = Status.PaidOut;
        m.b.status = Status.PaidOut;
        m.a.amount = 0;
        m.b.amount = 0;

        (bool ok, ) = winner.call{value: pot_}("");
        require(ok, "payout: transfer failed");

        emit PaidOut(matchId, winner, pot_);
    }

    /// @notice Settler-only: split the pot across multiple addresses
    ///         per the team-mode design (see docs/team-mode.md). Used
    ///         when the winning side is a team and the agreed split
    ///         was committed by the settler at game-end.
    /// @dev    `winners` and `shares` are aligned arrays. `shares[i]`
    ///         is the wei amount sent to `winners[i]`. The sum of
    ///         shares MUST equal the pot — the settler pre-computes
    ///         the split so this contract just verifies it.
    ///
    ///         Unlike `payoutWinner`, recipients are NOT restricted
    ///         to the two depositors: the team-mode design assumes
    ///         only one address per side stakes (per-match terms can
    ///         change every match — there is no team treasury) and
    ///         the team's internal split is decided off-chain. The
    ///         settler is fully trusted to provide a sane list.
    ///
    ///         Effects-then-interactions: settled flag is flipped
    ///         BEFORE any of the N transfers, so a reentrant call
    ///         hits `AlreadySettled` and cannot double-spend. If any
    ///         single transfer reverts the whole tx reverts and the
    ///         pot remains in escrow for the settler to retry.
    ///
    ///         Zero-share entries are allowed (the settler may want
    ///         to record team membership without paying) and skipped
    ///         at transfer time so they don't trigger spurious
    ///         `PaidOut` events. Zero-address winners revert.
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
            (bool ok, ) = winners[i].call{value: share}("");
            require(ok, "payoutSplit: transfer failed");
            emit PaidOut(matchId, winners[i], share);
        }
    }

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @notice Read the per-side state for `matchId`. Returns zero
    ///         values for sides that haven't deposited.
    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }

    /// @notice Pot size in wei (sum of both deposits). Zero before
    ///         either side deposits.
    function pot(bytes32 matchId) external view returns (uint256) {
        Match storage m = _matches[matchId];
        return uint256(m.a.amount) + uint256(m.b.amount);
    }
}
