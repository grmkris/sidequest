// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {BaseV1} from "./BaseV1.t.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract HorizonLateSlashTest is BaseV1 {
    function _job() internal returns (uint256 job) {
        ISidequestHolding.PublishParams memory p = params();
        p.deliveryDeadline = uint48(block.timestamp + 1 days);
        p.reviewWindow = holding.MIN_REVIEW_WINDOW();
        p.disputeWindow = holding.MIN_DISPUTE_WINDOW();
        p.arbitrationWindow = holding.MIN_ARBITRATION_WINDOW();
        p.expiredAt = uint48(block.timestamp + vault.UNSTAKE_DELAY());
        job = publishWith(p);
        activate(job);
    }

    function _backWorker() internal {
        vm.startPrank(contributor);
        factory.approve(address(vault), WORKER_STAKE);
        vault.delegate(worker, WORKER_STAKE);
        vm.stopPrank();
    }

    function _queue() internal {
        vm.prank(contributor);
        vault.requestUndelegate(worker, WORKER_STAKE);
    }

    function _queueAndExit(uint256 job) internal {
        _queue();
        uint48 unlockAt = vault.positionOf(worker, contributor).unlockAt;
        assertLe(listing(job).expiredAt, unlockAt, "commit's expiry invariant holds");
        vm.warp(uint256(unlockAt) + 1);
        vm.prank(contributor);
        vault.withdraw(worker);
        assertEq(factory.balanceOf(contributor), 10_000_000e18, "exiter recovered all backing");
        assertEq(vault.reservedOf(worker), WORKER_BOND, "pre-exit bond remains open");
    }

    function _expectWorkerRelease(uint256 job) internal {
        vm.expectEmit(true, true, false, true, address(holding));
        emit ISidequestHolding.BondReleased(job, ISidequestHolding.Side.Worker, worker, WORKER_BOND);
    }

    function _assertReleased(uint256 job) internal view {
        ISidequestHolding.Listing memory l = listing(job);
        assertTrue(l.creatorBondSettled);
        assertTrue(l.workerBondSettled);
        assertFalse(l.creatorBondBurned);
        assertFalse(l.workerBondBurned);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.reservedOf(worker), 0);
        assertEq(vault.reservedOf(creator), 0);
        assertEq(circulating(), 1_000_000_000e18);
    }

    function _assertRefund(uint256 job) internal view {
        assertEq(uint8(listing(job).outcome), uint8(ISidequestHolding.Outcome.Refunded));
        assertEq(pay.balanceOf(creator), 10 * REWARD);
        assertEq(pay.balanceOf(worker), 0);
        assertEq(pay.balanceOf(treasury), 0);
        assertEq(holding.owed(pay, creator), 0);
    }

    function _assertQueuedSlash(uint256 job) internal view {
        assertTrue(listing(job).workerBondBurned);
        assertEq(vault.convertToAssets(worker, vault.positionOf(worker, worker).shares), WORKER_STAKE - WORKER_BOND / 2);
        assertEq(
            vault.convertToAssets(worker, vault.positionOf(worker, contributor).shares), WORKER_STAKE - WORKER_BOND / 2
        );
        assertEq(vault.positionOf(worker, contributor).queuedShares, WORKER_STAKE);
        assertEq(vault.reservedOf(worker), 0);
        assertEq(circulating(), 1_000_000_000e18 - WORKER_BOND);
    }

    function test_delayedMissedDeliveryReleasesAfterBackerExit() public {
        _backWorker();
        uint256 job = _job();
        _queueAndExit(job);
        _expectWorkerRelease(job);
        evaluator.rejectAfterDeliveryDeadline(job);
        _assertReleased(job);
        assertEq(uint8(evaluator.outcome(job)), uint8(ISidequestEvaluator.Outcome.DeliveryMissed));
        assertEq(uint8(evaluator.slashed(job)), uint8(ISidequestEvaluator.SlashedSide.Worker));
        assertTrue(evaluator.workerPenaltyDue(job), "finding remains; Holding enforces expiry");
        assertEq(factory.balanceOf(contributor), 10_000_000e18);
        holding.settle(job);
        _assertRefund(job);
    }

    function test_delayedViolationReleasesAfterBackerExit() public {
        _backWorker();
        uint256 job = _job();
        submit(job);
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        _queueAndExit(job);
        _expectWorkerRelease(job);
        evaluator.rejectAfterWindow(job);
        _assertReleased(job);
        assertEq(uint8(evaluator.outcome(job)), uint8(ISidequestEvaluator.Outcome.RejectionFinal));
        assertEq(uint8(evaluator.slashed(job)), uint8(ISidequestEvaluator.SlashedSide.Worker));
        assertEq(factory.balanceOf(contributor), 10_000_000e18);
        holding.settle(job);
        _assertRefund(job);
    }

    function test_delayedHoldingSettlementReleasesAfterBackerExit() public {
        _backWorker();
        uint256 job = _job();
        topUp(job, contributor, 10e6);
        _queueAndExit(job);
        core.claimRefund(job);
        assertTrue(evaluator.workerPenaltyDue(job));
        _expectWorkerRelease(job);
        holding.settle(job);
        _assertReleased(job);
        assertEq(factory.balanceOf(contributor), 10_000_000e18);
        assertEq(uint8(evaluator.outcome(job)), uint8(ISidequestEvaluator.Outcome.None));
        _assertRefund(job);
        holding.claimTopUpRefund(job, contributor);
        assertEq(pay.balanceOf(contributor), 10 * REWARD);
        assertEq(holding.topUpOf(job, contributor), 0);
    }

    function test_timelyMissedDeliverySlashesQueuedBacking() public {
        _backWorker();
        uint256 job = _job();
        _queue();
        vm.warp(uint256(listing(job).expiredAt) - 1);
        evaluator.rejectAfterDeliveryDeadline(job);
        _assertQueuedSlash(job);
    }

    function test_timelyViolationSlashesQueuedBacking() public {
        _backWorker();
        uint256 job = _job();
        submit(job);
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        _queue();
        vm.warp(uint256(listing(job).expiredAt) - 1);
        evaluator.rejectAfterWindow(job);
        _assertQueuedSlash(job);
    }

    /// @dev The real core cannot refund before expiry. Terminate as its evaluator to exercise Holding's fallback.
    function _terminalMissedDelivery(uint256 job) internal {
        assertTrue(evaluator.workerPenaltyDue(job));
        vm.prank(address(evaluator));
        core.reject(job, REASON, "");
    }

    function test_timelyHoldingSettlementSlashesQueuedBacking() public {
        _backWorker();
        uint256 job = _job();
        _queue();
        vm.warp(uint256(listing(job).expiredAt) - 1);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        core.claimRefund(job);
        _terminalMissedDelivery(job);
        holding.settle(job);
        _assertQueuedSlash(job);
        _assertRefund(job);
    }

    function test_missedDeliveryAtExactExpiryReleases() public {
        uint256 job = _job();
        vm.warp(listing(job).expiredAt);
        _expectWorkerRelease(job);
        evaluator.rejectAfterDeliveryDeadline(job);
        _assertReleased(job);
    }

    function test_violationAtExactExpiryReleases() public {
        uint256 job = _job();
        submit(job);
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        vm.warp(listing(job).expiredAt);
        _expectWorkerRelease(job);
        evaluator.rejectAfterWindow(job);
        _assertReleased(job);
    }

    function test_holdingSettlementAtExactExpiryReleases() public {
        uint256 job = _job();
        vm.warp(listing(job).expiredAt);
        core.claimRefund(job);
        _expectWorkerRelease(job);
        holding.settle(job);
        _assertReleased(job);
        _assertRefund(job);
    }

    function test_creatorBondAtExpiryMinusOneStillSlashes() public {
        uint256 job = _job();
        vm.warp(uint256(listing(job).expiredAt) - 1);
        vm.expectEmit(true, true, false, true, address(holding));
        emit ISidequestHolding.BondSlashed(job, ISidequestHolding.Side.Creator, creator, CREATOR_BOND);
        vm.prank(address(evaluator));
        holding.burnBond(job, ISidequestHolding.Side.Creator);
        assertTrue(listing(job).creatorBondBurned);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND);
    }

    function test_creatorBondAtExactExpiryReleases() public {
        uint256 job = _job();
        vm.warp(listing(job).expiredAt);
        vm.expectEmit(true, true, false, true, address(holding));
        emit ISidequestHolding.BondReleased(job, ISidequestHolding.Side.Creator, creator, CREATOR_BOND);
        vm.prank(address(evaluator));
        holding.burnBond(job, ISidequestHolding.Side.Creator);
        assertFalse(listing(job).creatorBondBurned);
        assertTrue(listing(job).creatorBondSettled);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
    }

    function test_zeroWorkerBondKeepsAccountingAndSettlement() public {
        ISidequestHolding.PublishParams memory p = params();
        p.workerBond = 0;
        p.deliveryDeadline = uint48(block.timestamp + 1 days);
        p.reviewWindow = holding.MIN_REVIEW_WINDOW();
        p.disputeWindow = holding.MIN_DISPUTE_WINDOW();
        p.arbitrationWindow = holding.MIN_ARBITRATION_WINDOW();
        p.expiredAt = p.deliveryDeadline + p.reviewWindow + p.disputeWindow + p.arbitrationWindow + MARGIN;
        uint256 job = publishWith(p);
        activate(job);
        vm.warp(p.expiredAt);
        vm.recordLogs();
        evaluator.rejectAfterDeliveryDeadline(job);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(holding)) continue;
            assertTrue(logs[i].topics[0] != ISidequestHolding.BondSlashed.selector);
            if (logs[i].topics[0] == ISidequestHolding.BondReleased.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), creator);
            }
        }
        assertTrue(listing(job).workerBondBurned, "zero-amount decision flag is unchanged");
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        assertEq(circulating(), 1_000_000_000e18);
        holding.settle(job);
        _assertRefund(job);
    }

    function test_unactivatedExpiryForfeitsAndRefunds() public {
        ISidequestHolding.PublishParams memory p = params();
        p.deliveryDeadline = uint48(block.timestamp + 1 days);
        p.reviewWindow = holding.MIN_REVIEW_WINDOW();
        p.disputeWindow = holding.MIN_DISPUTE_WINDOW();
        p.arbitrationWindow = holding.MIN_ARBITRATION_WINDOW();
        p.expiredAt = p.deliveryDeadline + p.reviewWindow + p.disputeWindow + p.arbitrationWindow + MARGIN;
        uint256 job = publishWith(p);
        vm.warp(listing(job).expiredAt);
        core.claimRefund(job);
        vm.expectEmit(true, true, false, true, address(holding));
        emit ISidequestHolding.BondReleased(job, ISidequestHolding.Side.Creator, creator, CREATOR_BOND * 3 / 4);
        holding.settle(job);
        assertTrue(listing(job).creatorBondSettled);
        assertFalse(listing(job).creatorBondBurned);
        assertFalse(listing(job).workerBondReserved);
        assertFalse(listing(job).workerBondSettled);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND / 4);
        assertEq(factory.balanceOf(treasury), CREATOR_BOND / 4);
        _assertRefund(job);
    }

    function test_permissionlessReleaseUnblocksFullQueue() public {
        uint256 job = _job();
        vm.prank(worker);
        vault.requestUndelegate(worker, WORKER_STAKE);
        uint48 unlockAt = vault.positionOf(worker, worker).unlockAt;
        vm.warp(unlockAt);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.StillBonded.selector, 0, WORKER_BOND));
        vault.withdraw(worker);
        vm.prank(stranger);
        evaluator.rejectAfterDeliveryDeadline(job);
        vm.prank(worker);
        vault.withdraw(worker);
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_rulingAtLatestCutoffPrecedesHorizon() public {
        uint256 job = _job();
        ISidequestHolding.Listing memory l = listing(job);
        vm.warp(l.deliveryDeadline);
        submit(job);
        vm.warp(uint256(l.deliveryDeadline) + l.reviewWindow);
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        vm.warp(block.timestamp + l.disputeWindow);
        vm.prank(worker);
        evaluator.dispute(job);
        vm.warp(block.timestamp + l.arbitrationWindow);
        assertLe(block.timestamp + MARGIN, l.expiredAt);
        rule(job, false, true);
        assertTrue(listing(job).workerBondBurned);
    }

    function test_rulingAfterHorizonRefusedTimeoutDoesNotSlash() public {
        uint256 job = _job();
        submit(job);
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(job);
        vm.warp(uint256(listing(job).expiredAt) + 1);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(job, false, true, REASON);
        evaluator.refundAfterArbitrationTimeout(job);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_horizonNearUint48MaximumDoesNotWrap() public {
        vm.warp(uint256(type(uint48).max) - vault.UNSTAKE_DELAY());
        uint256 job = _job();
        assertEq(listing(job).expiredAt, type(uint48).max);
        vm.prank(worker);
        vault.requestUndelegate(worker, WORKER_STAKE);
        assertEq(vault.positionOf(worker, worker).unlockAt, type(uint48).max);
        vm.warp(uint256(type(uint48).max) + 1);
        evaluator.rejectAfterDeliveryDeadline(job);
        vm.prank(worker);
        vault.withdraw(worker);
    }

    function test_queueNearUint48MaximumRefusesOverflow() public {
        uint256 job = _job();
        vm.warp(uint256(type(uint48).max) - vault.UNSTAKE_DELAY() + 1);
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 48, uint256(type(uint48).max) + 1)
        );
        vault.requestUndelegate(worker, WORKER_STAKE);
        assertEq(vault.positionOf(worker, worker).queuedShares, 0);
        assertEq(vault.reservedOf(worker), WORKER_BOND);
        assertTrue(listing(job).funded);
    }
}

contract TestnetHorizonLateSlashTest is HorizonLateSlashTest {
    function clocks() internal pure override returns (SidequestClocks.Config memory) {
        return SidequestClocks.Config(120, 120, 300, 259200, 262800, 300, 1800, 1800, 3600);
    }
}
