// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {BlocklistToken, ReentrantToken} from "../mocks/OddTokens.sol";
import {MockReputation} from "../mocks/MockReputation.sol";
import {PausableToken, GasHungryToken} from "./mocks/V1Tokens.sol";
import {BaseV1} from "./BaseV1.t.sol";

contract SidequestEvaluatorTest is BaseV1 {
    // ------------------------------------------------------------------------------------------
    // Per-listing terms
    // ------------------------------------------------------------------------------------------

    function test_silencePaysAfterTheListingsOwnReviewWindow() public {
        ISidequestHolding.PublishParams memory p = params();
        p.reviewWindow = 1 hours;
        p.expiredAt = p.deliveryDeadline + 1 hours + DISPUTE + ARBITRATION + MARGIN;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        uint256 submittedAt = core.getJob(jobId).submittedAt;
        vm.warp(submittedAt + 1 hours);
        vm.expectRevert(ISidequestEvaluator.WindowOpen.selector);
        evaluator.completeAfterSilence(jobId);
        vm.warp(submittedAt + 1 hours + 1);
        evaluator.completeAfterSilence(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.Silence));
        assertEq(reputation.lastTag2(), "completed");
    }

    function test_reject_onlyApproverWithinItsWindow() public {
        uint256 jobId = submittedJob();
        vm.prank(stranger);
        vm.expectRevert(ISidequestEvaluator.NotApprover.selector);
        evaluator.reject(jobId, ISidequestEvaluator.Violation.None, REASON);
        vm.warp(core.getJob(jobId).submittedAt + REVIEW + 1);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.ReviewWindowClosed.selector);
        evaluator.reject(jobId, ISidequestEvaluator.Violation.None, REASON);
    }

    function test_thirdPartyApproverJudges() public {
        address approver = makeAddr("approver");
        ISidequestHolding.PublishParams memory p = params();
        p.approver = approver;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.NotApprover.selector);
        evaluator.accept(jobId);
        vm.prank(approver);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
    }

    function test_customArbitratorRules_defaultCannot() public {
        (address custom, uint256 customPk) = makeAddrAndKey("custom-arbiter");
        ISidequestHolding.PublishParams memory p = params();
        p.arbitrator = custom;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);

        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.NotArbitrator.selector);
        evaluator.rule(jobId, true, false, REASON);

        // The default arbitrator's signature is no good either.
        ISidequestEvaluator.Ruling memory r = ISidequestEvaluator.Ruling(jobId, true, false, REASON, block.timestamp, 1);
        bytes memory wrong = signRuling(arbitratorPk, r);
        vm.expectRevert(ISidequestEvaluator.InvalidSignature.selector);
        evaluator.ruleWithSignature(r, wrong);

        bytes memory right = signRuling(customPk, r);
        vm.prank(relayer);
        evaluator.ruleWithSignature(r, right);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForWorker));
        assertTrue(evaluator.rulingNonceUsed(custom, 1));
        assertFalse(evaluator.rulingNonceUsed(arbitrator, 1));
    }

    function test_dispute_onlyWorkerWithinWindow() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.prank(stranger);
        vm.expectRevert(ISidequestEvaluator.NotProvider.selector);
        evaluator.dispute(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        vm.prank(worker);
        vm.expectRevert(ISidequestEvaluator.WindowClosed.selector);
        evaluator.dispute(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Rulings, slashes, nonces
    // ------------------------------------------------------------------------------------------

    function test_ruleForWorker_badFaithBurnsCreatorBond() public {
        uint256 jobId = disputedJob();
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 supply = circulating();
        uint256 before = pay.balanceOf(worker);
        rule(jobId, true, true);
        assertEq(pay.balanceOf(worker) - before, net);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(circulating(), supply - CREATOR_BOND, "burned");
        assertTrue(evaluator.creatorPenaltyDue(jobId));
        assertFalse(evaluator.workerPenaltyDue(jobId));
        assertTrue(listing(jobId).creatorBondBurned);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.Creator));
    }

    function test_ruleForCreator_upholdsViolationBurnsWorkerBond() public {
        uint256 jobId = disputedJob();
        rule(jobId, false, true);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        uint256 before = pay.balanceOf(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator) - before, REWARD);
        assertEq(reputation.lastTag2(), "rejected-quality");
    }

    function test_ruleForCreator_slashNeedsANamedViolation() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.InvalidRuling.selector);
        evaluator.rule(jobId, false, true, REASON);
    }

    function test_alreadyRuled_secondRulingRefused() public {
        uint256 jobId = disputedJob();
        rule(jobId, true, false);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.AlreadyRuled.selector);
        evaluator.rule(jobId, false, true, REASON);
        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.expectRevert(ISidequestEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
    }

    function test_arbitrationCutoffAndTimeout() public {
        uint256 jobId = disputedJob();
        uint256 at = evaluator.disputedAt(jobId);
        vm.warp(at + ARBITRATION);
        vm.expectRevert(ISidequestEvaluator.WindowOpen.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.warp(at + ARBITRATION + 1);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(jobId, true, false, REASON);
        uint256 calls = reputation.calls();
        evaluator.refundAfterArbitrationTimeout(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.ArbitrationTimeout));
        assertEq(reputation.calls(), calls, "no feedback on arbitration timeout");
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "inactivity never burns");
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_rulingNonces_perArbitrator() public {
        (address other, uint256 otherPk) = makeAddrAndKey("other-arbiter");
        uint256 a = disputedJob();
        ISidequestHolding.PublishParams memory p = params();
        p.arbitrator = other;
        uint256 b = publishWith(p);
        activate(b);
        submit(b);
        rejectAs(b, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(b);
        uint256 c = disputedJob();

        ISidequestEvaluator.Ruling memory ra = ISidequestEvaluator.Ruling(a, true, false, REASON, block.timestamp, 7);
        bytes memory sigA = signRuling(arbitratorPk, ra);
        evaluator.ruleWithSignature(ra, sigA);
        // Another arbitrator's nonce 7 is untouched.
        ISidequestEvaluator.Ruling memory rb = ISidequestEvaluator.Ruling(b, true, false, REASON, block.timestamp, 7);
        bytes memory sigB = signRuling(otherPk, rb);
        evaluator.ruleWithSignature(rb, sigB);
        // The same arbitrator cannot reuse 7 on another job.
        ISidequestEvaluator.Ruling memory rc = ISidequestEvaluator.Ruling(c, true, false, REASON, block.timestamp, 7);
        bytes memory sigC = signRuling(arbitratorPk, rc);
        vm.expectRevert(ISidequestEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(rc, sigC);

        rc.nonce = 8;
        rc.deadline = block.timestamp - 1;
        sigC = signRuling(arbitratorPk, rc);
        vm.expectRevert(ISidequestEvaluator.RulingExpired.selector);
        evaluator.ruleWithSignature(rc, sigC);
    }

    function test_undisputedViolationBurns_noneDoesNot() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.Falsified);
        vm.warp(block.timestamp + DISPUTE + 1);
        assertTrue(evaluator.workerPenaltyDue(jobId));
        evaluator.rejectAfterWindow(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(reputation.lastTag2(), "rejected-falsified");

        uint256 other = submittedJob();
        rejectAs(other, ISidequestEvaluator.Violation.None);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(other);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "no second burn");
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_missedDeliveryBurn() public {
        uint256 jobId = fundedJob();
        uint48 deadline = listing(jobId).deliveryDeadline;
        vm.warp(deadline);
        vm.expectRevert(ISidequestEvaluator.WindowOpen.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.warp(deadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.DeliveryMissed));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    function test_acceptRefusedWhileDisputed() public {
        uint256 jobId = disputedJob();
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
    }

    /// @dev A paused core no longer blocks decisions: the outcome lands, the core call is deferred, and after the
    ///      unpause anyone finishes it with `retryDeferred` (C9 ACL-2: rulings can no longer time out under a pause).
    function test_pausedCoreDefers_thenRetryPaysTheWorker() public {
        uint256 jobId = submittedJob();
        vm.prank(deployer);
        core.pause();
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.Accepted));
        assertTrue(evaluator.payoutDeferred(jobId));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Submitted));
        assertEq(vault.reservedOf(worker), 0, "bonds settle with the decision");
        vm.prank(contributor);
        vm.expectRevert(ISidequestHolding.NotActive.selector);
        holding.topUp(jobId, 1e6);
        vm.expectRevert();
        evaluator.retryDeferred(jobId);

        vm.prank(deployer);
        core.unpause();
        vm.prank(stranger);
        evaluator.retryDeferred(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        uint256 before = pay.balanceOf(worker);
        holding.settle(jobId);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker) - before, net, "still the worker's");
        assertEq(pay.balanceOf(treasury), fee);
        vm.expectRevert(ISidequestEvaluator.NothingDeferred.selector);
        evaluator.retryDeferred(jobId);
    }

    function test_retryDeferred_refusesWhatIsNotDeferred() public {
        uint256 jobId = submittedJob();
        vm.expectRevert(ISidequestEvaluator.NotResolved.selector);
        evaluator.retryDeferred(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        vm.expectRevert(ISidequestEvaluator.NothingDeferred.selector);
        evaluator.retryDeferred(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // C9 ACL-2: a delivery deadline inside a core pause is never slashed
    // ------------------------------------------------------------------------------------------

    function test_pause_deadlineInsideThePauseRefundsWithoutTheSlash() public {
        uint256 jobId = fundedJob();
        uint48 d = listing(jobId).deliveryDeadline;
        vm.warp(d - 1 hours);
        vm.prank(deployer);
        core.pause();
        vm.prank(stranger);
        evaluator.notePause();
        assertEq(evaluator.pauseCount(), 1);
        assertEq(evaluator.pauseAt(0).start, d - 1 hours);
        assertEq(evaluator.pauseAt(0).end, 0);
        assertEq(evaluator.pausedSince(), d - 1 hours);
        vm.warp(d + 1 hours);
        vm.expectRevert(ISidequestEvaluator.CorePaused.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertFalse(evaluator.workerPenaltyDue(jobId));

        vm.prank(deployer);
        core.unpause();
        evaluator.notePause();
        assertEq(evaluator.pauseAt(0).end, d + 1 hours);
        assertEq(evaluator.pausedSince(), 0);
        assertFalse(evaluator.workerPenaltyDue(jobId), "excused");
        uint256 calls = reputation.calls();
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.None));
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "nothing burned");
        assertEq(vault.reservedOf(worker), 0);
        assertEq(reputation.calls(), calls, "no not-delivered feedback");
        uint256 before = pay.balanceOf(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator) - before, REWARD, "the creator is still refunded");
    }

    function _pause(uint256 from, uint256 to) internal {
        vm.warp(from);
        vm.prank(deployer);
        core.pause();
        evaluator.notePause();
        vm.warp(to);
        vm.prank(deployer);
        core.unpause();
        evaluator.notePause();
    }

    /// @dev C9-007: P1 covers the deadline, P2 comes later; P2 must not erase P1's exemption, for the timeout or for
    ///      settle after the core's expiry.
    function test_pause_laterPauseKeepsAnEarlierExemption_timeout() public {
        uint256 jobId = fundedJob();
        uint48 d = listing(jobId).deliveryDeadline;
        _pause(d - 1 hours, d + 1 hours);
        _pause(d + 2 hours, d + 3 hours);
        vm.warp(d + 3 hours + 1);
        assertEq(evaluator.pauseCount(), 2);
        assertFalse(evaluator.workerPenaltyDue(jobId));
        uint256 calls = reputation.calls();
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.None));
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(reputation.calls(), calls, "no negative feedback");
    }

    function test_pause_laterPauseKeepsAnEarlierExemption_settleAfterExpiry() public {
        uint256 jobId = fundedJob();
        uint48 d = listing(jobId).deliveryDeadline;
        _pause(d - 1 hours, d + 1 hours);
        _pause(d + 2 hours, d + 3 hours);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        assertFalse(evaluator.workerPenaltyDue(jobId));
        holding.settle(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "released, not burned");
        assertEq(vault.reservedOf(worker), 0);
    }

    /// @dev Several intervals and the boundaries: a deadline at a pause's start or end is inside it, and each job is
    ///      judged against its own interval however many pauses follow.
    function test_pause_history_boundaries() public {
        uint256 jobA = fundedJob();
        uint48 dA = listing(jobA).deliveryDeadline;
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        uint256 jobB = fundedJob();
        uint48 dB = listing(jobB).deliveryDeadline; // dA + 12 hours
        _pause(dA - 10 hours, dA - 9 hours); // before both
        _pause(dA, dA + 1 hours); // starts exactly at dA
        _pause(dB - 1 hours, dB); // ends exactly at dB
        _pause(dB + 5 hours, dB + 6 hours); // after both
        assertEq(evaluator.pauseCount(), 4);
        vm.warp(dB + 7 hours);
        assertFalse(evaluator.workerPenaltyDue(jobA), "deadline at a pause's start");
        assertFalse(evaluator.workerPenaltyDue(jobB), "deadline at a pause's end");
        evaluator.rejectAfterDeliveryDeadline(jobA);
        evaluator.rejectAfterDeliveryDeadline(jobB);
        assertEq(uint8(evaluator.slashed(jobA)), uint8(ISidequestEvaluator.SlashedSide.None));
        assertEq(uint8(evaluator.slashed(jobB)), uint8(ISidequestEvaluator.SlashedSide.None));
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
    }

    function test_pause_deadlineOutsideEveryIntervalStillBurns() public {
        uint256 jobId = fundedJob();
        uint48 d = listing(jobId).deliveryDeadline;
        _pause(d - 5 hours, d - 4 hours);
        _pause(d - 3 hours, d - 1);
        _pause(d + 1, d + 2 hours);
        vm.warp(d + 2 hours + 1);
        assertTrue(evaluator.workerPenaltyDue(jobId));
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.Worker));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
    }

    function test_pause_endedBeforeTheDeadlineExcusesNothing() public {
        uint256 jobId = fundedJob();
        uint48 d = listing(jobId).deliveryDeadline;
        vm.warp(d - 3 hours);
        vm.prank(deployer);
        core.pause();
        evaluator.notePause();
        vm.warp(d - 2 hours);
        vm.prank(deployer);
        core.unpause();
        evaluator.notePause();
        vm.warp(d + 1);
        assertTrue(evaluator.workerPenaltyDue(jobId));
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.Worker));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
    }

    // ------------------------------------------------------------------------------------------
    // C9-003: a pending core claim cannot lock a deferred refund
    // ------------------------------------------------------------------------------------------

    function _pausyJob() internal returns (PausableToken pz, uint256 jobId) {
        pz = new PausableToken();
        pz.mint(creator, REWARD);
        pz.mint(contributor, REWARD);
        vm.prank(creator);
        pz.approve(address(holding), REWARD);
        vm.prank(contributor);
        pz.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(pz)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        vm.prank(contributor);
        holding.topUp(jobId, 10e6);
    }

    function _deferredMissedDelivery(bool claimFirst) internal returns (PausableToken pz, uint256 jobId) {
        (pz, jobId) = _pausyJob();
        if (claimFirst) {
            vm.prank(worker);
            core.submitClaim(jobId, 1, keccak256("claim"), "");
        }
        vm.warp(listing(jobId).deliveryDeadline + 1);
        pz.setPaused(true);
        uint256 calls = reputation.calls();
        vm.prank(stranger);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.DeliveryMissed));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Funded), "the refund was deferred");
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "the worker bond burned");
        assertEq(reputation.calls(), calls + 1, "feedback recorded with the decision");
        if (!claimFirst) {
            // The worker files the claim after the deferral, before expiry.
            vm.prank(worker);
            core.submitClaim(jobId, 1, keccak256("claim"), "");
        }
        assertTrue(core.pendingClaimHash(jobId) != bytes32(0));
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.prank(contributor);
        vm.expectRevert(ISidequestHolding.NotActive.selector);
        holding.topUp(jobId, 1);
        vm.expectRevert();
        evaluator.retryDeferred(jobId); // the token still refuses
    }

    function _recoverWithoutTheWorker(PausableToken pz, uint256 jobId) internal {
        pz.setPaused(false);
        vm.warp(core.getJob(jobId).expiredAt + 2 hours);
        vm.prank(stranger);
        evaluator.retryDeferred(jobId);
        assertEq(core.pendingClaimHash(jobId), bytes32(0), "the reject closed the claim");
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        holding.settle(jobId);
        assertEq(pz.balanceOf(creator), REWARD, "the full reward is back");
        holding.claimTopUpRefund(jobId, contributor);
        assertEq(pz.balanceOf(contributor), REWARD, "the top-up is back");
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "burned once");
        assertEq(pz.balanceOf(address(holding)), 0);
    }

    function test_C9003_pendingClaimBeforeTheDeferral() public {
        (PausableToken pz, uint256 jobId) = _deferredMissedDelivery(true);
        _recoverWithoutTheWorker(pz, jobId);
    }

    function test_C9003_pendingClaimAfterTheDeferral() public {
        (PausableToken pz, uint256 jobId) = _deferredMissedDelivery(false);
        _recoverWithoutTheWorker(pz, jobId);
    }

    // ------------------------------------------------------------------------------------------
    // C9-001: a gas-burning reward token cannot roll back a decision (feedback enabled, documented limit)
    // ------------------------------------------------------------------------------------------

    uint256 internal constant DECISION_GAS = 1_100_000;

    function _hungryDispute() internal returns (GasHungryToken hungry, uint256 jobId) {
        hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function _relayRuling(uint256 jobId, bool forWorker, bool slashLoser, uint256 nonce) internal {
        ISidequestEvaluator.Ruling memory r =
            ISidequestEvaluator.Ruling(jobId, forWorker, slashLoser, REASON, vm.getBlockTimestamp() + 1 hours, nonce);
        bytes memory sig = signRuling(arbitratorPk, r);
        vm.prank(relayer);
        evaluator.ruleWithSignature{gas: DECISION_GAS}(r, sig);
    }

    function test_C9001_gasBurningWorkerTransferCannotRollBackAWorkerRuling() public {
        (GasHungryToken hungry, uint256 jobId) = _hungryDispute();
        hungry.setHungry(worker, type(uint256).max);
        uint256 calls = reputation.calls();
        _relayRuling(jobId, true, true, 1);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForWorker));
        assertEq(uint8(evaluator.slashed(jobId)), uint8(ISidequestEvaluator.SlashedSide.Creator));
        assertTrue(evaluator.rulingNonceUsed(arbitrator, 1));
        assertTrue(evaluator.payoutDeferred(jobId));
        assertEq(reputation.calls(), calls + 1, "feedback still recorded");
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND);
        assertEq(vault.reservedOf(worker), 0, "the worker bond is free");

        vm.warp(vm.getBlockTimestamp() + ARBITRATION + 1);
        vm.expectRevert(ISidequestEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);

        if (status(jobId) == ERC8183.JobStatus.Submitted) evaluator.retryDeferred(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(holding.owed(IERC20(address(hungry)), worker) + hungry.balanceOf(worker), net);
        assertEq(hungry.balanceOf(creator), 0, "the creator did not win by burning gas");
        hungry.setHungry(worker, 0);
        if (holding.owed(IERC20(address(hungry)), worker) > 0) {
            vm.prank(worker);
            holding.withdraw(IERC20(address(hungry)));
        }
        assertEq(hungry.balanceOf(worker), net);
    }

    function test_C9001_bothCoreAttemptsBurnTheirBudgets_decisionStillLands() public {
        (GasHungryToken hungry, uint256 jobId) = _hungryDispute();
        hungry.setHungry(worker, type(uint256).max);
        hungry.setHungry(address(holding), type(uint256).max);
        _relayRuling(jobId, true, false, 1);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForWorker));
        assertTrue(evaluator.payoutDeferred(jobId));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Submitted), "nothing reached Holding yet");
        assertEq(vault.reservedOf(worker), 0);
        assertEq(vault.reservedOf(creator), 0);
        vm.expectRevert();
        evaluator.retryDeferred{gas: 5_000_000}(jobId);

        hungry.setHungry(address(holding), 0);
        evaluator.retryDeferred(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(holding.owed(IERC20(address(hungry)), worker), net, "owed while the token still burns");
    }

    function test_C9001_gasBurningRefundCannotRollBackACreatorRuling() public {
        (GasHungryToken hungry, uint256 jobId) = _hungryDispute();
        hungry.setHungry(address(holding), type(uint256).max);
        uint256 calls = reputation.calls();
        _relayRuling(jobId, false, true, 1);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForCreator));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(reputation.calls(), calls + 1);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Submitted), "refund deferred");
        hungry.setHungry(address(holding), 0);
        evaluator.retryDeferred(jobId);
        holding.settle(jobId);
        assertEq(hungry.balanceOf(creator), REWARD);
    }

    function test_coreGasTooLow_refusesBeforeRecording() public {
        uint256 jobId = submittedJob();
        vm.prank(creator);
        vm.expectRevert();
        evaluator.accept{gas: 600_000}(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), 0);
        assertEq(vault.reservedOf(worker), WORKER_BOND);
    }

    // ------------------------------------------------------------------------------------------
    // C9 ACL-5: core fees never cut the worker or strand tokens in the evaluator
    // ------------------------------------------------------------------------------------------

    function activateExt(uint256 jobId) external {
        activate(jobId);
    }

    function test_coreFees_refuseActivation_liveJobPaysThroughHolding() public {
        uint256 live = submittedJob();
        uint256 open = publish();
        vm.prank(deployer);
        core.setEvaluatorFee(500);
        vm.expectRevert(ISidequestHolding.CoreChargesFees.selector);
        this.activateExt(open);

        vm.prank(creator);
        evaluator.accept(live);
        assertTrue(evaluator.payoutDeferred(live));
        if (status(live) == ERC8183.JobStatus.Submitted) evaluator.retryDeferred(live);
        uint256 before = pay.balanceOf(worker);
        holding.settle(live);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker) - before, net, "the full net");
        assertEq(pay.balanceOf(address(evaluator)), 0, "nothing stranded");
    }

    // ------------------------------------------------------------------------------------------
    // C9 SIG-2, SIG-1, GEN-6
    // ------------------------------------------------------------------------------------------

    function test_cancelRuling_revokesASignedRuling() public {
        uint256 jobId = disputedJob();
        ISidequestEvaluator.Ruling memory r =
            ISidequestEvaluator.Ruling(jobId, false, true, REASON, vm.getBlockTimestamp() + 1 hours, 7);
        bytes memory sig = signRuling(arbitratorPk, r);
        vm.prank(arbitrator);
        evaluator.cancelRuling(7);
        vm.prank(relayer);
        vm.expectRevert(ISidequestEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(r, sig);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.RulingNonceUsed.selector);
        evaluator.cancelRuling(7);
    }

    function test_feedbackFailure_copiesAtMost32Bytes() public {
        uint256 jobId = submittedJob();
        reputation.setMode(MockReputation.Mode.Revert);
        uint256 agentId = core.getJob(jobId).providerAgentId;
        vm.expectEmit(true, true, false, true, address(evaluator));
        emit ISidequestEvaluator.FeedbackFailed(jobId, agentId, abi.encodePacked(bytes4(0x08c379a0), bytes28(0)));
        vm.prank(creator);
        evaluator.accept(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // M1: a hostile reward token re-entering settle during the core call gains nothing
    // ------------------------------------------------------------------------------------------

    function _hookJob() internal returns (ReentrantToken hook, uint256 jobId) {
        hook = new ReentrantToken();
        hook.mint(creator, REWARD);
        vm.prank(creator);
        hook.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(hook)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function test_M1_reentrantSettleDuringRulingForWorkerCannotRecoverCreatorBond() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(holding), abi.encodeCall(ISidequestHolding.settle, (jobId)));
        rule(jobId, true, true);
        assertTrue(hook.attempted());
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND, "the bad-faith bond still burned");
        assertTrue(listing(jobId).creatorBondBurned);
        assertEq(vault.reservedOf(creator), 0);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(hook.balanceOf(worker), net);
        // A re-entrant settle inside the capped core call either ran and could only do the fixed thing (the fee to
        // the treasury), or lacked the gas for a push and rolled back; settle afterwards does the same.
        if (!hook.reentered()) holding.settle(jobId);
        assertEq(hook.balanceOf(treasury), fee);
        vm.expectRevert(ISidequestHolding.NothingToSettle.selector);
        holding.settle(jobId);
        assertEq(hook.balanceOf(address(holding)), 0);
    }

    function test_M1_reentrantSettleDuringRulingForCreatorCannotRecoverWorkerBond() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(holding), abi.encodeCall(ISidequestHolding.settle, (jobId)));
        rule(jobId, false, true);
        assertTrue(hook.attempted());
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "the upheld violation still burned");
        assertTrue(listing(jobId).workerBondBurned);
        if (!hook.reentered()) holding.settle(jobId);
        assertEq(hook.balanceOf(creator), REWARD);
    }

    function test_M1_reentryIntoTheEvaluatorIsRefused() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(evaluator), abi.encodeCall(ISidequestEvaluator.refundAfterArbitrationTimeout, (jobId)));
        rule(jobId, true, false);
        assertTrue(hook.attempted());
        assertFalse(hook.reentered());
        assertEq(uint8(evaluator.outcome(jobId)), uint8(ISidequestEvaluator.Outcome.RuledForWorker));
    }

    // ------------------------------------------------------------------------------------------
    // M2: a token refusing the worker defers the payout; the worker is still paid
    // ------------------------------------------------------------------------------------------

    function _blockyJob() internal returns (BlocklistToken blk, uint256 jobId) {
        blk = new BlocklistToken();
        blk.mint(creator, REWARD);
        blk.mint(contributor, REWARD);
        vm.prank(creator);
        blk.approve(address(holding), REWARD);
        vm.prank(contributor);
        blk.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(blk)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        vm.prank(contributor);
        holding.topUp(jobId, 10e6);
        submit(jobId);
    }

    function test_M2_blocklistedWorker_acceptDefersThenSettlePaysThroughOwed() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        blk.setBlocked(worker, true);
        vm.expectEmit(address(evaluator));
        emit ISidequestEvaluator.PayoutDeferred(jobId, true);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertTrue(evaluator.payoutDeferred(jobId));
        assertTrue(evaluator.earnedByWorker(jobId));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected), "the reward came back to Holding");
        assertEq(reputation.lastTag2(), "completed");

        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 bonusFee = 10e6 * 3000 / 10_000;
        uint256 creatorBefore = blk.balanceOf(creator);
        holding.settle(jobId);
        assertEq(blk.balanceOf(creator), creatorBefore, "never a refund to the creator");
        assertEq(holding.owed(IERC20(address(blk)), worker), net + 10e6 - bonusFee);
        assertEq(blk.balanceOf(treasury), fee + bonusFee);
        assertEq(uint8(listing(jobId).outcome), uint8(ISidequestHolding.Outcome.Paid));

        blk.setBlocked(worker, false);
        vm.prank(worker);
        holding.withdraw(IERC20(address(blk)));
        assertEq(blk.balanceOf(worker), net + 10e6 - bonusFee);
    }

    /// @dev The original M2: a ruling for the worker used to revert, and the timeout then refunded the creator.
    function test_M2_blocklistedWorker_rulingStands_timeoutCannotRefund() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        blk.setBlocked(worker, true);
        rule(jobId, true, false);
        assertTrue(evaluator.payoutDeferred(jobId));
        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.expectRevert(ISidequestEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertGe(holding.owed(IERC20(address(blk)), worker), net);
    }

    /// @dev Worst case: the token refuses every transfer, so both `complete` and `reject` fail. The decision stands,
    ///      every other path is closed, and after expiry the core's `claimRefund` brings the reward to Holding.
    function test_M2_frozenToken_bothCallsFail_claimRefundLaterPaysWorker() public {
        PausableToken pau = new PausableToken();
        pau.mint(creator, REWARD);
        vm.prank(creator);
        pau.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(pau)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        pau.setPaused(true);
        vm.expectEmit(address(evaluator));
        emit ISidequestEvaluator.PayoutDeferred(jobId, false);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Submitted));
        assertEq(vault.reservedOf(worker), 0, "bonds settled before the core call");

        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.reject(jobId, ISidequestEvaluator.Violation.Quality, REASON);
        vm.warp(core.getJob(jobId).submittedAt + REVIEW + 1);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.completeAfterSilence(jobId);

        pau.setPaused(false);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pau.balanceOf(worker), net);
        assertEq(pau.balanceOf(treasury), fee);
    }

    function test_M2_rulingForCreatorWithFrozenTokenStillRecordsAndSlashes() public {
        PausableToken pau = new PausableToken();
        pau.mint(creator, REWARD);
        vm.prank(creator);
        pau.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(pau)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        pau.setPaused(true);
        vm.expectEmit(address(evaluator));
        emit ISidequestEvaluator.RefundDeferred(jobId);
        rule(jobId, false, true);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        pau.setPaused(false);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(pau.balanceOf(creator), REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // Evidence and feedback
    // ------------------------------------------------------------------------------------------

    /// @dev C9 SIG-1 / MATH-3 / C9-005: an older statement (sooner expiry) cannot replace the stored one; an expiry
    ///      storage cannot hold is refused, so storage and the event agree.
    function test_evidence_olderStatementCannotReplaceANewerOne() public {
        uint256 jobId = submittedJob();
        ISidequestEvaluator.EvidenceAttestation memory a = ISidequestEvaluator.EvidenceAttestation({
            jobId: jobId,
            submissionHash: DELIVERABLE,
            policyHash: listing(jobId).policyHash,
            repo: keccak256("repo"),
            headSha: keccak256("head"),
            testedSha: keccak256("tested"),
            checkRunsHash: keccak256("checks"),
            conclusion: 1,
            validUntil: block.timestamp + 2 days
        });
        vm.prank(attester);
        evaluator.attachEvidenceDirect(jobId, a);
        a.conclusion = 2;
        a.validUntil = block.timestamp + 1 days;
        vm.prank(attester);
        vm.expectRevert(ISidequestEvaluator.StaleEvidence.selector);
        evaluator.attachEvidenceDirect(jobId, a);
        a.validUntil = type(uint256).max;
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 48, type(uint256).max));
        evaluator.attachEvidenceDirect(jobId, a);
        a.validUntil = uint256(type(uint48).max) + 1;
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 48, uint256(type(uint48).max) + 1)
        );
        evaluator.attachEvidenceDirect(jobId, a);
        a.validUntil = type(uint48).max;
        vm.expectEmit(true, true, false, false, address(evaluator));
        emit ISidequestEvaluator.EvidenceAttached(jobId, attester, 0, 0, 0, 0, 0, 0);
        vm.prank(attester);
        evaluator.attachEvidenceDirect(jobId, a);
        (,,,,, uint48 validUntil, uint8 conclusion) = evaluator.evidence(jobId, attester);
        assertEq(validUntil, type(uint48).max, "storage = event");
        assertEq(conclusion, 2);
    }

    function test_evidence_boundToTheListingsPolicy() public {
        uint256 jobId = submittedJob();
        ISidequestEvaluator.EvidenceAttestation memory a = ISidequestEvaluator.EvidenceAttestation({
            jobId: jobId,
            submissionHash: DELIVERABLE,
            policyHash: listing(jobId).policyHash,
            repo: keccak256("repo"),
            headSha: keccak256("head"),
            testedSha: keccak256("tested"),
            checkRunsHash: keccak256("checks"),
            conclusion: 1,
            validUntil: block.timestamp + 1 days
        });
        vm.prank(attester);
        evaluator.attachEvidenceDirect(jobId, a);
        (bytes32 digest,,,,,,) = evaluator.evidence(jobId, attester);
        assertTrue(digest != bytes32(0));

        a.policyHash = keccak256("other");
        vm.prank(attester);
        vm.expectRevert(ISidequestEvaluator.EvidencePolicyMismatch.selector);
        evaluator.attachEvidenceDirect(jobId, a);
        vm.prank(stranger);
        vm.expectRevert(ISidequestEvaluator.NotVerifier.selector);
        evaluator.attachEvidenceDirect(jobId, a);
    }

    function test_feedback_failureNeverUndoesPayment_andGasFloor() public {
        uint256 jobId = submittedJob();
        reputation.setMode(MockReputation.Mode.Revert);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));

        uint256 other = submittedJob();
        reputation.setMode(MockReputation.Mode.Ok);
        vm.prank(creator);
        vm.expectRevert();
        evaluator.accept{gas: 350_000}(other);
    }
}

/// @dev An expensive transfer to the worker exceeds `CORE_GAS` inside `complete`, and only the route changes (no
///      reputation registry here; `test_C9001_*` cover the same with feedback enabled).
contract SidequestEvaluatorStarvationTest is BaseV1 {
    function withReputation() internal pure override returns (bool) {
        return false;
    }

    function test_M2_gasStarvationChangesOnlyTheRoute() public {
        GasHungryToken hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        // An honest but expensive transfer to the worker: about 6M gas.
        hungry.setHungry(worker, 60_000);

        vm.prank(creator);
        evaluator.accept{gas: 3_000_000}(jobId);
        assertTrue(evaluator.payoutDeferred(jobId), "the starved complete was deferred");
        assertTrue(evaluator.earnedByWorker(jobId));

        if (status(jobId) == ERC8183.JobStatus.Submitted) {
            vm.warp(core.getJob(jobId).expiredAt + 1 hours);
            core.claimRefund(jobId);
        }
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        // The push to the worker exceeds TRANSFER_GAS, so it is owed; the worker withdraws with enough gas.
        uint256 owedNow = holding.owed(IERC20(address(hungry)), worker);
        uint256 paidNow = hungry.balanceOf(worker);
        assertEq(owedNow + paidNow, net);
        if (owedNow > 0) {
            vm.prank(worker);
            holding.withdraw{gas: 20_000_000}(IERC20(address(hungry)));
        }
        assertEq(hungry.balanceOf(worker), net, "the worker is paid in full");
        assertEq(hungry.balanceOf(creator), 0, "the creator never got the reward back");
    }

    function test_expensiveTransferDefersAtAnyGasLimit() public {
        GasHungryToken hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        hungry.setHungry(worker, 60_000);
        vm.prank(creator);
        evaluator.accept{gas: 30_000_000}(jobId);
        assertTrue(evaluator.payoutDeferred(jobId), "complete is capped at CORE_GAS whatever the caller sends");
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected), "spare gas moved the reward to Holding");
    }
}
