// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Ports of the legacy Lifecycle, R114 and Cutoffs suites to v1: per-listing windows, bonds as reservations,
///      the core funded with `net`.
contract V1LifecycleTest is BaseV1 {
    // ------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------

    function test_delegatorExitsAfterSuccessfulHireWithoutTakingWorkerPay() public {
        vm.startPrank(contributor);
        factory.approve(address(vault), 9_000e18);
        vault.delegate(worker, 9_000e18);
        vm.stopPrank();
        uint256 job = submittedJob();
        vm.prank(contributor);
        vault.requestUndelegate(worker, 9_000e18);
        vm.prank(creator);
        evaluator.accept(job);
        holding.settle(job);
        assertEq(pay.balanceOf(worker), 90e6, "worker earns the snapshotted 10% tier net");
        assertEq(pay.balanceOf(contributor), 10 * REWARD, "delegation pays no profit share yet");
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        uint256 before = factory.balanceOf(contributor);
        vm.prank(contributor);
        vault.withdraw(worker);
        assertEq(factory.balanceOf(contributor) - before, 9_000e18);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.totalReserved(), 0);
    }

    function test_happyPath_directWorker() public {
        uint256 jobId = submittedJob();
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        vm.prank(creator);
        evaluator.accept(jobId);
        holding.settle(jobId);
        assertEq(pay.balanceOf(worker), net);
        assertEq(pay.balanceOf(treasury), fee);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        assertEq(vault.totalReserved(), 0);
        assertEq(reputation.lastTag2(), "completed");
        assertEq(reputation.lastClient(), address(evaluator));
    }

    function test_happyPath_relayedSubmission() public {
        uint256 jobId = fundedJob();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signCore(
            workerPk,
            keccak256(
                abi.encode(
                    core.SUBMIT_AUTHORIZATION_TYPEHASH(), worker, jobId, DELIVERABLE, keccak256(""), 900, deadline
                )
            )
        );
        vm.prank(relayer);
        core.submitWithAuthorization(
            jobId, DELIVERABLE, "", ERC8183WithAuthorization.Authorization(worker, 900, deadline, sig)
        );
        vm.warp(block.timestamp + REVIEW + 1);
        evaluator.completeAfterSilence(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker), net);
    }

    function test_moneyPath_terminalRejectAfterFundingReturnsBothBonds() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), 10 * REWARD, "creator whole again, fee included");
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        assertEq(vault.totalReserved(), 0);
    }

    function test_moneyPath_thirdPartyClaimRefund_noShowBondExpires() public {
        uint256 jobId = fundedJob();
        vm.warp(core.getJob(jobId).expiredAt);
        vm.prank(stranger);
        core.claimRefund(jobId);
        assertTrue(evaluator.workerPenaltyDue(jobId));
        holding.settle(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "expiry ends the due penalty's burn window");
        assertFalse(listing(jobId).workerBondBurned);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
    }

    function test_ruling_matrix() public {
        // forWorker, slashLoser → who burns.
        bool[2][4] memory cases = [[true, false], [true, true], [false, false], [false, true]];
        for (uint256 i; i < 4; ++i) {
            uint256 creatorBefore = vault.stakeOf(creator);
            uint256 workerBefore = vault.stakeOf(worker);
            uint256 jobId = disputedJob();
            rule(jobId, cases[i][0], cases[i][1]);
            holding.settle(jobId);
            bool creatorBurns = cases[i][0] && cases[i][1];
            bool workerBurns = !cases[i][0] && cases[i][1];
            assertEq(vault.stakeOf(creator), creatorBefore - (creatorBurns ? CREATOR_BOND : 0));
            assertEq(vault.stakeOf(worker), workerBefore - (workerBurns ? WORKER_BOND : 0));
            assertEq(vault.totalReserved(), 0);
        }
    }

    function test_rule_onlyArbitratorAndOnlyWhenDisputed() public {
        uint256 jobId = submittedJob();
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.NotDisputed.selector);
        evaluator.rule(jobId, true, false, REASON);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(stranger);
        vm.expectRevert(ISidequestEvaluator.NotArbitrator.selector);
        evaluator.rule(jobId, true, false, REASON);
    }

    function test_settle_notBeforeTerminal() public {
        uint256 jobId = submittedJob();
        vm.expectRevert(ISidequestHolding.NotTerminal.selector);
        holding.settle(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Adversarial calls straight at the core
    // ------------------------------------------------------------------------------------------

    function test_adversarial_milestoneClaimCannotBlockRefund() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        core.submitClaim(jobId, 1, keccak256("half"), "");
        vm.warp(core.getJob(jobId).expiredAt + 1);
        vm.expectRevert(ERC8183.PendingClaimExists.selector);
        core.claimRefund(jobId);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(core.pendingClaimHash(jobId), bytes32(0));
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertFalse(listing(jobId).workerBondBurned);
    }

    /// @dev The listing's expiry covers its own windows: the slowest legal path still ends before `claimRefund`.
    function test_adversarial_claimRefundCannotPreemptSettlement() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline);
        submit(jobId);
        vm.warp(block.timestamp + REVIEW);
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.warp(block.timestamp + DISPUTE);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.warp(block.timestamp + ARBITRATION);
        vm.expectRevert(ERC8183.GracePeriodActive.selector);
        core.claimRefund(jobId);
        rule(jobId, true, false);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker), net);
    }

    function test_adversarial_noSubmissionBeforeActivation() public {
        uint256 jobId = publish();
        vm.prank(worker);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.submit(jobId, DELIVERABLE, "");
    }

    function test_auth_replayRejected() public {
        uint256 jobId = publish();
        ISidequestHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, address(pay), net, 7);
        vm.prank(worker);
        holding.activate(sel, sig, auth);
        vm.prank(relayer);
        vm.expectRevert(ERC8183WithAuthorization.AuthorizationNonceUsed.selector);
        core.setBudgetWithAuthorization(jobId, address(pay), net, "", auth);
    }

    function test_auth_wrongSignerCannotSetTheBudget() public {
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");
        uint256 jobId = publish();
        ISidequestHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(impostorPk, impostor, jobId, address(pay), net, 1);
        vm.prank(worker);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        holding.activate(sel, sig, auth);
    }

    function test_auth_workerCannotUnderfundThemselves() public {
        uint256 jobId = publish();
        ISidequestHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(workerPk, worker, jobId, address(pay), net - 1, 1);
        vm.prank(worker);
        vm.expectRevert(ERC8183WithAuthorization.InvalidAuthorizationSignature.selector);
        holding.activate(sel, sig, auth);
    }

    // ------------------------------------------------------------------------------------------
    // R114-02: no paying late once disputed
    // ------------------------------------------------------------------------------------------

    function test_R114_02_acceptRefused_thenBadFaithRulingBurnsCreatorBond() public {
        uint256 jobId = disputedJob();
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        rule(jobId, true, true);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND);
    }

    function test_R114_02_reconsiderBeforeDispute_thenDisputeRefused() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(creator);
        evaluator.accept(jobId);
        vm.prank(worker);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.dispute(jobId);
    }

    function test_R114_02_rulingFirstThenAcceptRefused() public {
        uint256 jobId = disputedJob();
        rule(jobId, false, false);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.AlreadyResolved.selector);
        evaluator.accept(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // R114-03: what Holding pays after the core's own refund
    // ------------------------------------------------------------------------------------------

    function test_R114_03_silenceCompletionFirst_thenRefundRefused() public {
        uint256 jobId = submittedJob();
        vm.warp(block.timestamp + REVIEW + 1);
        evaluator.completeAfterSilence(jobId);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        core.claimRefund(jobId);
    }

    function test_R114_03_refundFirst_thenSilenceCompletionRefused() public {
        uint256 jobId = submittedJob();
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        vm.expectRevert(ISidequestEvaluator.NotSubmitted.selector);
        evaluator.completeAfterSilence(jobId);
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker), net, "paid once, by settle");
    }

    function test_R114_03_undisputedRejectionAfterExpiryRefundsCreator() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "the named violation cannot burn after expiry");
        assertFalse(listing(jobId).workerBondBurned);
    }

    function test_R114_03_arbitrationTimeoutAfterExpiryRefundsCreatorBurnsNothing() public {
        uint256 jobId = disputedJob();
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
    }

    function test_R114_03_lateSubmissionEarnsNoSilencePayment() public {
        uint256 jobId = fundedJob();
        vm.warp(listing(jobId).deliveryDeadline + 1);
        submit(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.expectRevert(ISidequestEvaluator.LateSubmission.selector);
        evaluator.completeAfterSilence(jobId);
        assertFalse(evaluator.earnedByWorker(jobId));
        assertTrue(evaluator.workerPenaltyDue(jobId));
    }

    function test_R114_03_otherEscrowsUntouched() public {
        uint256 a = submittedJob();
        uint256 b = fundedJob();
        uint256 heldForB = listing(b).fee;
        vm.warp(core.getJob(a).expiredAt + 1 hours);
        core.claimRefund(a);
        holding.settle(a);
        assertEq(pay.balanceOf(address(holding)), heldForB + 0, "b's fee is all that is left");
    }

    // ------------------------------------------------------------------------------------------
    // Cutoffs, from the listing's own windows
    // ------------------------------------------------------------------------------------------

    function _shortWindows() internal returns (uint256 jobId) {
        ISidequestHolding.PublishParams memory p = params();
        (p.reviewWindow, p.disputeWindow, p.arbitrationWindow) = (2 hours, 1 hours, 12 hours);
        p.expiredAt = p.deliveryDeadline + 2 hours + 1 hours + 12 hours + MARGIN;
        jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
    }

    function test_review_rejectAtExactDeadline_lateRejectFails() public {
        uint256 jobId = _shortWindows();
        uint256 at = core.getJob(jobId).submittedAt;
        uint256 snap = vm.snapshotState();
        vm.warp(at + 2 hours);
        rejectAs(jobId, ISidequestEvaluator.Violation.None);
        vm.revertToState(snap);
        vm.warp(at + 2 hours + 1);
        vm.prank(creator);
        vm.expectRevert(ISidequestEvaluator.ReviewWindowClosed.selector);
        evaluator.reject(jobId, ISidequestEvaluator.Violation.None, REASON);
    }

    function test_arbitration_ruleAtExactDeadline_lateRuleFails() public {
        uint256 jobId = _shortWindows();
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        uint256 at = evaluator.disputedAt(jobId);
        uint256 snap = vm.snapshotState();
        vm.warp(at + 12 hours);
        rule(jobId, true, false);
        vm.revertToState(snap);
        vm.warp(at + 12 hours + 1);
        vm.prank(arbitrator);
        vm.expectRevert(ISidequestEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(jobId, true, false, REASON);
        evaluator.refundAfterArbitrationTimeout(jobId);
    }

    function test_review_acceptStaysOpenLate() public {
        uint256 jobId = submittedJob();
        vm.warp(block.timestamp + REVIEW + 1 days);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
    }

    // ------------------------------------------------------------------------------------------
    // Conservation
    // ------------------------------------------------------------------------------------------

    function testFuzz_ruling_conservesBothAssets(bool forWorker, bool slashLoser, uint96 bonus, uint96 stake) public {
        uint256 extra = bound(uint256(stake), 0, 2_000_000e18);
        if (extra > 0) {
            vm.prank(worker);
            vault.delegate(worker, extra);
        }
        uint256 jobId = fundedJob();
        uint256 b = bound(uint256(bonus), 0, 5 * REWARD);
        if (b > 0) topUp(jobId, contributor, b);
        submit(jobId);
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        uint256 payTotal = pay.balanceOf(creator) + pay.balanceOf(worker) + pay.balanceOf(contributor)
            + pay.balanceOf(treasury) + pay.balanceOf(address(holding)) + pay.balanceOf(address(core));
        uint256 supply = circulating();
        rule(jobId, forWorker, slashLoser);
        holding.settle(jobId);
        if (!forWorker && b > 0) holding.claimTopUpRefund(jobId, contributor);
        assertEq(
            pay.balanceOf(creator) + pay.balanceOf(worker) + pay.balanceOf(contributor) + pay.balanceOf(treasury),
            payTotal,
            "reward token conserved"
        );
        assertEq(pay.balanceOf(address(holding)), 0);
        assertEq(pay.balanceOf(address(core)), 0);
        uint256 burned = slashLoser ? (forWorker ? CREATOR_BOND : WORKER_BOND) : 0;
        assertEq(circulating(), supply - burned, "SIDE leaves only by the slash");
        assertEq(vault.totalReserved(), 0);
    }
}
