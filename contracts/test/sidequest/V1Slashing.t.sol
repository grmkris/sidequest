// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Ports of the legacy Slashing suite to v1: a slash sends the reserved SIDE to the vault's slash recipient.
contract V1SlashingTest is BaseV1 {
    function test_noShowSlash_sharedProRataIncludingQueuedDelegator() public {
        vm.startPrank(contributor);
        factory.approve(address(vault), WORKER_STAKE);
        vault.delegate(worker, WORKER_STAKE);
        vm.stopPrank();
        uint256 job = fundedJob();
        vm.prank(contributor);
        vault.requestUndelegate(worker, WORKER_STAKE);
        vm.warp(listing(job).deliveryDeadline + 1);
        evaluator.rejectAfterDeliveryDeadline(job);
        uint256 remaining = 2 * WORKER_STAKE - WORKER_BOND;
        uint256 selfValue = vault.convertToAssets(worker, vault.positionOf(worker, worker).shares);
        uint256 delegatedValue = vault.convertToAssets(worker, vault.positionOf(worker, contributor).shares);
        assertEq(selfValue, remaining / 2);
        assertEq(delegatedValue, remaining / 2, "queued backing cannot dodge a slash");
        assertEq(vault.reservedOf(worker), 0);
        assertEq(vault.stakeOf(worker), selfValue);
    }

    function testFuzz_qualitySlash_proRataAcrossThreeOwners(uint96 first, uint96 second) public {
        uint256 a = bound(first, 1, 100_000e18);
        uint256 b = bound(second, 1, 100_000e18);
        vm.startPrank(contributor);
        factory.approve(address(vault), a);
        vault.delegate(worker, a);
        vm.stopPrank();
        vm.prank(deployer);
        factory.transfer(stranger, b);
        vm.startPrank(stranger);
        factory.approve(address(vault), b);
        vault.delegate(worker, b);
        vm.stopPrank();
        uint256 job = submittedJob();
        rejectAs(job, ISidequestEvaluator.Violation.Quality);
        vm.warp(vm.getBlockTimestamp() + DISPUTE + 1);
        evaluator.rejectAfterWindow(job);
        uint256 total = WORKER_STAKE + a + b;
        address[3] memory owners = [worker, contributor, stranger];
        uint256[3] memory deposits = [WORKER_STAKE, a, b];
        for (uint256 i; i < 3; ++i) {
            uint256 value = vault.convertToAssets(worker, vault.positionOf(worker, owners[i]).shares);
            uint256 expectedLoss = Math.mulDiv(deposits[i], WORKER_BOND, total);
            assertApproxEqAbs(deposits[i] - value, expectedLoss, 1);
        }
    }

    function test_undisputed_noneQualityFalsified() public {
        ISidequestEvaluator.Violation[3] memory vs = [
            ISidequestEvaluator.Violation.None,
            ISidequestEvaluator.Violation.Quality,
            ISidequestEvaluator.Violation.Falsified
        ];
        for (uint256 i; i < 3; ++i) {
            uint256 before = vault.stakeOf(worker);
            uint256 jobId = submittedJob();
            rejectAs(jobId, vs[i]);
            vm.warp(vm.getBlockTimestamp() + DISPUTE + 1);
            evaluator.rejectAfterWindow(jobId);
            assertEq(vault.stakeOf(worker), before - (i == 0 ? 0 : WORKER_BOND));
            assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        }
    }

    function test_disputeRefusedOnUnactivatedOrSettledJobs() public {
        uint256 open = publish();
        vm.prank(worker);
        vm.expectRevert(ISidequestEvaluator.NotProvider.selector);
        evaluator.dispute(open);
        uint256 done = submittedJob();
        vm.prank(creator);
        evaluator.accept(done);
        vm.prank(worker);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.dispute(done);
    }

    function test_late_noSilencePaymentNoRejection() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        submit(jobId);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.LateSubmission.selector);
        evaluator.reject(jobId, ISidequestEvaluator.Violation.Quality, REASON);
    }

    function test_late_approverAcceptsBeforeTheBurn() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    function test_late_burnBeforeTheApproverAccepts() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        submit(jobId);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.accept(jobId);
    }

    function test_timely_submissionCannotBeBurned() public {
        uint256 jobId = submittedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        vm.expectRevert(ISidequestEvaluator.NotLate.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    function test_guard_claimRefundThenSettleReleasesExpiredNoShow() public {
        uint256 jobId = fundedJob();
        vm.warp(core.getJob(jobId).expiredAt);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertFalse(listing(jobId).workerBondBurned);
    }

    function test_guard_burnThenClaimRefundRefused() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.warp(core.getJob(jobId).expiredAt);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        core.claimRefund(jobId);
    }

    function test_guard_lateSubmissionThenClaimRefundReleasesExpiredBond() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        submit(jobId);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertFalse(listing(jobId).workerBondBurned);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
    }

    function test_guard_pendingMilestoneClaimDoesNotEscapeTheBurn() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        core.submitClaim(jobId, 1, keccak256("claim"), "");
        vm.warp(listing(jobId).deliveryDeadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
    }

    // ------------------------------------------------------------------------------------------
    // Signed rulings
    // ------------------------------------------------------------------------------------------

    function _signed(uint256 jobId, bool forWorker, bool slash, uint256 nonce)
        internal
        view
        returns (ISidequestEvaluator.Ruling memory r, bytes memory sig)
    {
        r = ISidequestEvaluator.Ruling(jobId, forWorker, slash, REASON, vm.getBlockTimestamp() + 1 hours, nonce);
        sig = signRuling(arbitratorPk, r);
    }

    function test_signedRuling_anyRelayerEqualsRule() public {
        uint256 jobId = disputedJob();
        (ISidequestEvaluator.Ruling memory r, bytes memory sig) = _signed(jobId, false, true, 1);
        vm.prank(relayer);
        evaluator.ruleWithSignature(r, sig);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForCreator));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
    }

    function test_signedRuling_invalidCombinationRefused() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.prank(worker);
        evaluator.dispute(jobId);
        (ISidequestEvaluator.Ruling memory r, bytes memory sig) = _signed(jobId, false, true, 1);
        vm.expectRevert(ISidequestEvaluator.InvalidRuling.selector);
        evaluator.ruleWithSignature(r, sig);
        assertFalse(evaluator.rulingNonceUsed(arbitrator, 1), "a reverted ruling spends no nonce");
    }

    function test_signedRuling_sameCutoffAsRule_atExactCutoffBeatsTheTimeout() public {
        uint256 jobId = disputedJob();
        uint256 at = evaluator.disputedAt(jobId);
        vm.warp(at + ARBITRATION);
        (ISidequestEvaluator.Ruling memory r, bytes memory sig) = _signed(jobId, true, false, 2);
        evaluator.ruleWithSignature(r, sig);
        vm.warp(at + ARBITRATION + 1);
        vm.expectRevert(ISidequestEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);

        uint256 other = disputedJob();
        at = evaluator.disputedAt(other);
        vm.warp(at + ARBITRATION + 1);
        (r, sig) = _signed(other, true, false, 3);
        vm.expectRevert(ISidequestEvaluator.ArbitrationWindowClosed.selector);
        evaluator.ruleWithSignature(r, sig);
    }

    function test_arbitrationTimeout_neverBurnsAndWritesNoFeedback() public {
        uint256 jobId = disputedJob();
        uint256 calls = reputation.calls();
        vm.warp(block.timestamp + ARBITRATION + 1);
        evaluator.refundAfterArbitrationTimeout(jobId);
        holding.settle(jobId);
        assertEq(reputation.calls(), calls);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
    }
}
