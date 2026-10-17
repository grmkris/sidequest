// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {BaseV1} from "./BaseV1.t.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IFeeSchedule} from "../../src/sidequest/interfaces/IFeeSchedule.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";

contract AuthDosProbe is BaseV1 {
    function test_existingPauseForfeitRisk() public {
        uint256 jobId = publish();
        vm.prank(deployer);
        core.pause();
        evaluator.notePause();
        vm.warp(block.timestamp + 300);
        vm.prank(creator);
        vm.expectRevert();
        holding.cancel(jobId);
        vm.warp(block.timestamp + 301);
        vm.prank(deployer);
        core.unpause();
        evaluator.notePause();
        uint256 treasuryBefore = factory.balanceOf(treasury);
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(factory.balanceOf(treasury) - treasuryBefore, CREATOR_BOND / 4);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND / 4);
    }

    function test_existingTreasurySelfConfigurationBlocksUnfilledSettlement() public {
        uint256 jobId = publish();
        IFeeSchedule.Schedule memory bad = defaultSchedule(address(holding));
        vm.prank(deployer);
        fees.propose(bad);
        vm.warp(block.timestamp + fees.DELAY());
        fees.execute();
        vm.prank(creator);
        vm.expectRevert(ISidequestHolding.InvalidForfeitTreasury.selector);
        holding.cancel(jobId);
        assertEq(vault.reservedOf(creator), CREATOR_BOND);
        vm.prank(deployer);
        fees.propose(defaultSchedule(treasury));
        vm.warp(block.timestamp + fees.DELAY());
        fees.execute();
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(vault.reservedOf(creator), 0);
    }

    function test_unobservedPauseStartFailsToExcuseMissedDelivery() public {
        uint256 jobId = fundedJob();
        uint256 deadline = listing(jobId).deliveryDeadline;
        vm.warp(deadline - 1000);
        vm.prank(deployer);
        core.pause();
        // Operational fault: Safe does not pair its pause with notePause.
        vm.warp(deadline + 500);
        vm.prank(deployer);
        core.unpause();
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertTrue(listing(jobId).workerBondBurned);
    }

    function test_unobservedPauseEndExcusesAnUnpausedDeadline() public {
        uint256 jobId = fundedJob();
        uint256 deadline = listing(jobId).deliveryDeadline;
        vm.warp(deadline - 1000);
        vm.prank(deployer);
        core.pause();
        evaluator.notePause();
        vm.warp(deadline - 500);
        vm.prank(deployer);
        core.unpause();
        // Operational fault: Safe fails to close the observed interval.
        vm.warp(deadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertFalse(listing(jobId).workerBondBurned);
    }

    function test_selectionCannotReplayAcrossChainDomain() public {
        uint256 jobId = publish();
        ISidequestHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, address(pay), net, 1);
        vm.chainId(block.chainid + 1);
        vm.prank(worker);
        vm.expectRevert(ISidequestHolding.InvalidSignature.selector);
        holding.activate(sel, sig, auth);
        assertFalse(holding.selectionNonceUsed(creator, sel.nonce));
    }

    function test_rulingCannotReplayAcrossChainDomain() public {
        uint256 jobId = disputedJob();
        ISidequestEvaluator.Ruling memory r = ISidequestEvaluator.Ruling(jobId, true, false, REASON, block.timestamp + 1 hours, 1);
        bytes memory sig = signRuling(arbitratorPk, r);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(ISidequestEvaluator.InvalidSignature.selector);
        evaluator.ruleWithSignature(r, sig);
        assertFalse(evaluator.rulingNonceUsed(arbitrator, 1));
    }
}
