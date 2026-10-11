// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SidequestConstants
/// @notice The fixed bounds of Sidequest v1 (ADR-0011). Every offer picks its own windows inside these bounds at
///         publish; they are frozen into the listing and read by the evaluator through `ISidequestHolding.termsOf`.
library SidequestConstants {
    /// @notice How long the approver has, after a timely submission, to reject before silence becomes acceptance.
    uint32 internal constant MIN_REVIEW_WINDOW = 1 hours;
    uint32 internal constant MAX_REVIEW_WINDOW = 14 days;
    /// @notice How long the worker has, after a rejection, to dispute it before it becomes final.
    uint32 internal constant MIN_DISPUTE_WINDOW = 1 hours;
    uint32 internal constant MAX_DISPUTE_WINDOW = 14 days;
    /// @notice How long the arbitrator has, after a dispute, to rule before the refund timeout opens.
    uint32 internal constant MIN_ARBITRATION_WINDOW = 12 hours;
    uint32 internal constant MAX_ARBITRATION_WINDOW = 14 days;

    /// @notice Basis-point denominator for fees.
    uint16 internal constant BPS = 10_000;
    /// @notice The highest fee any FeeSchedule may charge (30 %).
    uint16 internal constant MAX_FEE_BPS = 3_000;

    /// @notice Stake withdrawals wait this long after `requestUndelegate`.
    uint48 internal constant UNSTAKE_DELAY = 14 days;
    /// @notice A new Holding can reserve stake only this long after it is proposed: longer than `UNSTAKE_DELAY`,
    ///         so every staker can leave before a Holding they distrust can touch their stake.
    uint48 internal constant HOLDING_DELAY = 15 days;
    /// @notice A fee schedule change takes effect this long after it is proposed.
    uint48 internal constant FEE_DELAY = 3 days;
    /// @dev How long a timelocked proposal stays executable after its eta (C9 ACL-4): a parked proposal cannot be
    ///      triggered months later without fresh notice.
    uint48 internal constant PROPOSAL_GRACE = 7 days;

    /// @notice Where slashed SIDE goes. SIDE has no `burn`, so a slash moves the bond to this address, which nobody
    ///         controls; it leaves circulation exactly as a burn would.
    address internal constant SLASH_SINK = 0x000000000000000000000000000000000000dEaD;

    /// @notice SIDE's fixed supply: 1e9 tokens with 18 decimals, minted once.
    uint256 internal constant SIDE_SUPPLY = 1_000_000_000e18;
    /// @notice Half the supply is mined: 500M SIDE.
    uint256 internal constant MINING_RESERVE = 500_000_000e18;
    /// @notice The first weekly mining budget, W = 500M / 52 SIDE.
    uint256 internal constant WEEKLY_BUDGET = MINING_RESERVE / 52;
    /// @notice Epoch 0 is short (72 h) and gets W · 3/7.
    uint48 internal constant EPOCH_ZERO_DURATION = 72 hours;
    /// @notice Every later epoch lasts a week.
    uint48 internal constant EPOCH_DURATION = 7 days;
    /// @notice The weekly budget halves every 26 epochs after epoch 0: epoch k ≥ 1 gets `W >> ((k - 1) / 26)`.
    uint256 internal constant HALVING_EPOCHS = 26;
}
