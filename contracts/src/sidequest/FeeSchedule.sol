// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NoRenounce} from "./NoRenounce.sol";
import {IFeeSchedule} from "./interfaces/IFeeSchedule.sol";
import {SidequestConstants} from "./interfaces/SidequestConstants.sol";
import {SidequestClocks} from "./SidequestClocks.sol";

/// @title FeeSchedule
/// @notice The worker's platform fee by staked SIDE (ADR-0011; the full contract is in `IFeeSchedule`). The owner
///         (the Safe) retunes the tiers and the treasury through an immutable timelock (production: 3 days), within fixed bounds. Jobs snapshot
///         their rate at activation, so a change never reaches a live job.
contract FeeSchedule is IFeeSchedule, NoRenounce {
    uint48 public immutable DELAY;
    uint16 public constant MAX_BPS = SidequestConstants.MAX_FEE_BPS;
    uint48 public immutable PROPOSAL_GRACE;

    Schedule internal _schedule;
    Schedule internal _pending;
    uint48 internal _eta;

    /// @param initial The deploy-time schedule from config (0 / 10k / 100k / 1M SIDE at 30 / 10 / 3 / 1 %, the
    ///        treasury Safe), held to the same bounds as any proposal.
    constructor(Schedule memory initial, SidequestClocks.Config memory clocks) Ownable(msg.sender) {
        SidequestClocks.validate(clocks);
        DELAY = clocks.feeDelay;
        PROPOSAL_GRACE = clocks.proposalGrace;
        _validate(initial);
        _schedule = initial;
        emit ScheduleExecuted(initial.thresholds, initial.bps, initial.treasury);
    }

    function feeBps(uint256 stake) external view returns (uint16) {
        for (uint256 i = 3; i > 0; --i) {
            if (stake >= _schedule.thresholds[i]) return _schedule.bps[i];
        }
        return _schedule.bps[0];
    }

    function treasury() external view returns (address) {
        return _schedule.treasury;
    }

    function schedule() external view returns (Schedule memory) {
        return _schedule;
    }

    function pending() external view returns (Schedule memory proposed, uint48 eta) {
        return (_pending, _eta);
    }

    function propose(Schedule calldata s) external onlyOwner {
        _validate(s);
        _drop();
        _pending = s;
        uint48 eta = uint48(block.timestamp) + DELAY;
        _eta = eta;
        emit ScheduleProposed(s.thresholds, s.bps, s.treasury, eta);
    }

    function execute() external {
        uint48 eta = _eta;
        if (eta == 0) revert NoPendingSchedule();
        if (block.timestamp < eta) revert ScheduleTimelocked(eta);
        if (block.timestamp > uint256(eta) + PROPOSAL_GRACE) revert ScheduleExpired(eta);
        Schedule memory s = _pending;
        _schedule = s;
        delete _pending;
        delete _eta;
        emit ScheduleExecuted(s.thresholds, s.bps, s.treasury);
    }

    function cancel() external onlyOwner {
        if (_eta == 0) revert NoPendingSchedule();
        _drop();
    }

    /// @dev A proposal never outlives its proposer (C9 ACL-3), and a replaced one is cancelled visibly (C9 ACL-9).
    function _transferOwnership(address newOwner) internal override {
        _drop();
        super._transferOwnership(newOwner);
    }

    function _drop() private {
        if (_eta == 0) return;
        delete _pending;
        delete _eta;
        emit ScheduleCancelled();
    }

    function _validate(Schedule memory s) private pure {
        if (s.thresholds[0] != 0) revert FirstThresholdNotZero();
        if (s.treasury == address(0)) revert ZeroTreasury();
        for (uint256 i; i < 4; ++i) {
            if (s.bps[i] > MAX_BPS) revert FeeTooHigh(s.bps[i], MAX_BPS);
            if (i == 0) continue;
            if (s.thresholds[i] <= s.thresholds[i - 1]) revert ThresholdsNotAscending();
            if (s.bps[i] > s.bps[i - 1]) revert FeesIncreasing();
        }
    }
}
