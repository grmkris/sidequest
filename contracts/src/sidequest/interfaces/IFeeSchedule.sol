// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFeeSchedule
/// @notice The platform fee a worker pays, by the SIDE it has staked (ADR-0011). Four tiers: thresholds
///         0 / 10k / 100k / 1M SIDE at 30 / 10 / 3 / 1 % at deploy, with the treasury Safe as fee recipient.
///         The owner (the Safe) retunes the tiers and the treasury through a 3-day timelock: `propose`, then anyone
///         `execute`s after the delay, or the owner `cancel`s. A proposal must have a zero first threshold, strictly
///         ascending thresholds, rates at most 3000 bps that never increase with the tier, and a nonzero treasury.
///
///         Each job snapshots its rate at activation (`ISidequestHolding.Listing.feeBps`), so a schedule change never
///         affects a live job. The treasury is read when a fee is paid out.
///
///         The implementation is `Ownable2Step` through `NoRenounce`; `owner`, `pendingOwner`, `transferOwnership` and
///         `acceptOwnership` come from OpenZeppelin and are not repeated here. `renounceOwnership` always reverts.
interface IFeeSchedule {
    /// @notice A complete fee schedule. Tier `i` applies to a stake of at least `thresholds[i]` (SIDE wei) and
    ///         below `thresholds[i + 1]`; the last tier has no upper bound.
    struct Schedule {
        uint256[4] thresholds;
        uint16[4] bps;
        address treasury;
    }

    event ScheduleProposed(uint256[4] thresholds, uint16[4] bps, address treasury, uint48 eta);
    event ScheduleExecuted(uint256[4] thresholds, uint16[4] bps, address treasury);
    event ScheduleCancelled();

    /// @notice The first threshold must be zero, so every stake falls in a tier.
    error FirstThresholdNotZero();
    error ThresholdsNotAscending();
    error FeeTooHigh(uint16 bps, uint16 max);
    error FeesIncreasing();
    error ZeroTreasury();
    error NoPendingSchedule();
    error ScheduleTimelocked(uint48 eta);
    /// @dev The proposal's execution window (`PROPOSAL_GRACE` after its eta) has passed.
    error ScheduleExpired(uint48 eta);

    /// @notice The fee in basis points for a worker with `stake` SIDE staked (reservations included).
    function feeBps(uint256 stake) external view returns (uint16);

    /// @notice Where fees go: the treasury Safe.
    function treasury() external view returns (address);

    /// @notice The schedule in force.
    function schedule() external view returns (Schedule memory);

    /// @notice The proposed schedule and the time from which anyone may execute it; `eta` is zero when none.
    function pending() external view returns (Schedule memory proposed, uint48 eta);

    /// @notice Owner only. Proposes `s`, replacing (and cancelling) any earlier proposal; executable from `DELAY` until
    ///         `PROPOSAL_GRACE` after that. An ownership transfer drops it.
    function propose(Schedule calldata s) external;

    /// @notice Anyone, once the delay has passed: puts the pending schedule in force.
    function execute() external;

    /// @notice Owner only. Drops the pending proposal.
    function cancel() external;

    /// @notice The timelock on a schedule change (3 days).
    function DELAY() external view returns (uint48);

    /// @notice The highest rate any tier may charge (3000 bps).
    function MAX_BPS() external view returns (uint16);

    /// @notice How long after its eta a proposed schedule can still be executed (7 days).
    function PROPOSAL_GRACE() external view returns (uint48);
}
