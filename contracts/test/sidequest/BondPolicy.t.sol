// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV1} from "./BaseV1.t.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {SidequestEvaluator} from "../../src/sidequest/SidequestEvaluator.sol";
import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";
import {IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {SidequestHolding} from "../../src/sidequest/SidequestHolding.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {IFeeSchedule} from "../../src/sidequest/interfaces/IFeeSchedule.sol";
import {IERC8004Identity} from "../../src/vendor/erc8004/IERC8004.sol";

contract BondPolicyTest is BaseV1 {
    function test_constructorRejectsInvalidPolicy() public {
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        new SidequestHolding(
            core, vault, fees, IERC8004Identity(address(identity)), arbitrator, MARGIN, 0, 100e18, 2500, clocks()
        );
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        new SidequestHolding(
            core, vault, fees, IERC8004Identity(address(identity)), arbitrator, MARGIN, 101e18, 100e18, 2500, clocks()
        );
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        new SidequestHolding(
            core, vault, fees, IERC8004Identity(address(identity)), arbitrator, MARGIN, 10e18, 100e18, 5001, clocks()
        );
    }

    function _refused(uint256 bond) internal {
        ISidequestHolding.PublishParams memory p = params();
        p.creatorBond = bond;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ISidequestHolding.CreatorBondTooLow.selector, bond, CREATOR_BOND));
        holding.publish(p);
        assertEq(vault.totalReserved(), 0);
        assertEq(pay.balanceOf(address(holding)), 0);
        assertEq(core.jobCounter(), 0);
        assertFalse(holding.policyListed(creator, p.policyHash));
    }

    function test_zeroBondRefused() public {
        _refused(0);
    }

    function test_floorMinusOneRefused() public {
        _refused(CREATOR_BOND - 1);
    }

    function test_floorAccepted() public {
        uint256 job = publish();
        assertEq(listing(job).creatorBond, CREATOR_BOND);
        assertEq(vault.reservedOf(creator), CREATOR_BOND);
    }

    function testFuzz_belowFloorHasNoEffects(uint256 amount) public {
        _refused(bound(amount, 0, CREATOR_BOND - 1));
    }

    function test_onlyOwnerCanChangePolicy() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        holding.setMinimumCreatorBond(1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        holding.setUnfilledForfeitBps(0);
    }

    function test_policyCapsAndZeroRate() public {
        uint256 cap = holding.MAX_MINIMUM_CREATOR_BOND();
        vm.startPrank(deployer);
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        holding.setMinimumCreatorBond(0);
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        holding.setMinimumCreatorBond(cap + 1);
        vm.expectRevert(ISidequestHolding.InvalidBondPolicy.selector);
        holding.setUnfilledForfeitBps(5001);
        holding.setMinimumCreatorBond(cap);
        holding.setUnfilledForfeitBps(5000);
        holding.setUnfilledForfeitBps(0);
        vm.stopPrank();
    }

    function _cancelAt(uint256 job, uint256 elapsed) internal {
        vm.warp(uint256(listing(job).publishedAt) + elapsed);
        vm.prank(creator);
        holding.cancel(job);
    }

    function test_cancelAt599IsFree() public {
        uint256 job = publish();
        _cancelAt(job, 599);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        assertEq(factory.balanceOf(treasury), 0);
        assertEq(vault.reservedOf(creator), 0);
    }

    function test_cancelAt600ForfeitsAndReleasesRemainder() public {
        uint256 job = publish();
        uint256 taken = CREATOR_BOND / 4;
        vm.warp(uint256(listing(job).publishedAt) + 600);
        vm.expectEmit(true, true, true, true, address(holding));
        emit ISidequestHolding.BondForfeited(job, creator, treasury, taken);
        vm.expectEmit(true, true, false, true, address(holding));
        emit ISidequestHolding.BondReleased(job, ISidequestHolding.Side.Creator, creator, CREATOR_BOND - taken);
        vm.prank(creator);
        holding.cancel(job);
        assertEq(factory.balanceOf(treasury), taken);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - taken);
        assertEq(vault.reservedOf(creator), 0);
        assertEq(circulating(), 1_000_000_000e18);
        assertFalse(listing(job).creatorBondBurned);
        vm.expectRevert(ISidequestHolding.NothingToSettle.selector);
        holding.settle(job);
        assertEq(factory.balanceOf(treasury), taken);
    }

    function test_policyChangesOnlyAffectNewListings() public {
        uint256 job = publish();
        vm.startPrank(deployer);
        holding.setMinimumCreatorBond(CREATOR_BOND * 2);
        holding.setUnfilledForfeitBps(5000);
        vm.stopPrank();
        ISidequestHolding.PublishParams memory p = params();
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ISidequestHolding.CreatorBondTooLow.selector, CREATOR_BOND, CREATOR_BOND * 2)
        );
        holding.publish(p);
        p.creatorBond *= 2;
        uint256 next = publishWith(p);
        _cancelAt(job, 600);
        vm.prank(creator);
        holding.cancel(next);
        assertEq(factory.balanceOf(treasury), CREATOR_BOND / 4 + CREATOR_BOND);
        assertEq(listing(job).unfilledForfeitBps, 2500);
        assertEq(listing(next).unfilledForfeitBps, 5000);
    }

    function test_unfilledExpiryForfeitsAfterHorizon() public {
        uint256 job = publish();
        vm.warp(uint256(listing(job).expiredAt) + 1);
        core.claimRefund(job);
        holding.settle(job);
        assertEq(factory.balanceOf(treasury), CREATOR_BOND / 4);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
        assertEq(vault.totalReserved(), 0);
        assertFalse(listing(job).creatorBondBurned);
    }

    function test_unfilledExpiryForfeitsAtExactExpiry() public {
        uint256 job = publish();
        vm.warp(listing(job).expiredAt);
        core.claimRefund(job);
        holding.settle(job);
        assertEq(factory.balanceOf(treasury), CREATOR_BOND / 4);
        assertEq(vault.reservedOf(creator), 0);
    }

    function test_expiryInsideGraceStillForfeits() public {
        SidequestClocks.Config memory fast = clocks();
        fast.minReviewWindow = 1;
        fast.minDisputeWindow = 1;
        fast.minArbitrationWindow = 1;
        vm.startPrank(deployer);
        vault = new StakeVault(factory, fast);
        holding = new SidequestHolding(
            core, vault, fees, IERC8004Identity(address(identity)), arbitrator, 0, CREATOR_BOND, 100_000e18, 2500, fast
        );
        evaluator = new SidequestEvaluator(core, holding, IERC8004Reputation(address(reputation)));
        holding.setEvaluator(address(evaluator));
        vault.bootstrapHolding(address(holding));
        vm.stopPrank();
        vm.startPrank(creator);
        factory.approve(address(vault), CREATOR_STAKE);
        vault.delegate(creator, CREATOR_STAKE);
        pay.approve(address(holding), REWARD);
        vm.stopPrank();
        ISidequestHolding.PublishParams memory p = params();
        p.deliveryDeadline = uint48(block.timestamp + 1);
        p.reviewWindow = 1;
        p.disputeWindow = 1;
        p.arbitrationWindow = 1;
        p.expiredAt = uint48(block.timestamp + 301);
        uint256 job = publishWith(p);
        vm.warp(listing(job).expiredAt);
        assertLt(block.timestamp, uint256(listing(job).publishedAt) + holding.CANCEL_GRACE());
        core.claimRefund(job);
        holding.settle(job);
        assertEq(factory.balanceOf(treasury), CREATOR_BOND / 4);
        assertEq(vault.totalReserved(), 0);
    }

    function test_activatedExpiryDoesNotForfeit() public {
        uint256 job = publish();
        activate(job);
        vm.warp(uint256(listing(job).expiredAt) + 1);
        core.claimRefund(job);
        holding.settle(job);
        assertEq(factory.balanceOf(treasury), 0);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
    }

    function test_rotationUsesLiveTimelockedTreasury() public {
        uint256 job = publish();
        IFeeSchedule.Schedule memory s = defaultSchedule(stranger);
        vm.prank(deployer);
        fees.propose(s);
        (, uint48 eta) = fees.pending();
        vm.warp(eta);
        fees.execute();
        vm.prank(creator);
        holding.cancel(job);
        assertEq(factory.balanceOf(stranger), CREATOR_BOND / 4);
        assertEq(factory.balanceOf(treasury), 0);
    }

    function test_invalidTreasuryKeepsReservationUntilFixed() public {
        uint256 job = publish();
        IFeeSchedule.Schedule memory s = defaultSchedule(address(holding));
        vm.prank(deployer);
        fees.propose(s);
        (, uint48 eta) = fees.pending();
        vm.warp(eta);
        fees.execute();
        vm.prank(creator);
        vm.expectRevert(ISidequestHolding.InvalidForfeitTreasury.selector);
        holding.cancel(job);
        assertEq(vault.reservedOf(creator), CREATOR_BOND);
        assertFalse(listing(job).creatorBondSettled);
    }

    function test_zeroRateReleasesAll() public {
        vm.prank(deployer);
        holding.setUnfilledForfeitBps(0);
        uint256 job = publish();
        _cancelAt(job, 600);
        assertEq(factory.balanceOf(treasury), 0);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
    }

    function test_partlyQueuedBackingSharesForfeitProRata() public {
        vm.startPrank(contributor);
        factory.approve(address(vault), CREATOR_STAKE);
        vault.delegate(creator, CREATOR_STAKE);
        vault.requestUndelegate(creator, CREATOR_STAKE / 2);
        vm.stopPrank();
        uint256 job = publish();
        _cancelAt(job, 600);
        assertEq(
            vault.convertToAssets(creator, vault.positionOf(creator, contributor).shares),
            CREATOR_STAKE - CREATOR_BOND / 8
        );
        assertEq(
            vault.convertToAssets(creator, vault.positionOf(creator, creator).shares), CREATOR_STAKE - CREATOR_BOND / 8
        );
        assertEq(vault.positionOf(creator, contributor).queuedShares, CREATOR_STAKE / 2);
        assertEq(vault.totalAssets(), 2 * CREATOR_STAKE + WORKER_STAKE - CREATOR_BOND / 4);
    }

    function test_withdrawBlockedUntilExpiryForfeitRuns() public {
        uint256 job = publish();
        vm.prank(creator);
        vault.requestUndelegate(creator, CREATOR_STAKE);
        vm.warp(vault.positionOf(creator, creator).unlockAt);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.StillBonded.selector, 0, CREATOR_BOND));
        vault.withdraw(creator);
        core.claimRefund(job);
        holding.settle(job);
        uint256 before = factory.balanceOf(creator);
        vm.prank(creator);
        vault.withdraw(creator);
        assertEq(factory.balanceOf(creator) - before, CREATOR_STAKE - CREATOR_BOND / 4);
    }

    function test_vaultFullForfeitResetsPoolAndCannotTakeOthersReservation() public {
        vm.prank(address(holding));
        vault.reserve(worker, WORKER_STAKE);
        vm.prank(stranger);
        assertEq(vault.forfeit(worker, WORKER_STAKE, treasury), 0);
        vm.prank(address(holding));
        assertEq(vault.forfeit(worker, WORKER_STAKE + 1, treasury), WORKER_STAKE);
        IStakeVault.Pool memory pool = vault.poolOf(worker);
        assertEq(pool.assets, 0);
        assertEq(pool.shares, 0);
        assertEq(pool.queuedShares, 0);
        assertEq(pool.generation, 1);
        assertEq(vault.positionOf(worker, worker).shares, 0);
        assertEq(vault.totalAssets(), CREATOR_STAKE);
        assertEq(vault.totalReserved(), 0);
    }

    function test_vaultRejectsZeroForfeitRecipient() public {
        vm.prank(address(holding));
        vault.reserve(worker, WORKER_STAKE);
        vm.prank(address(holding));
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.forfeit(worker, WORKER_STAKE, address(0));
        assertEq(vault.reservedOf(worker), WORKER_STAKE);
    }

    function testFuzz_forfeitRoundedDownAndPreservesSupply(uint256 bond, uint16 rate) public {
        bond = bound(bond, CREATOR_BOND, CREATOR_STAKE);
        rate = uint16(bound(rate, 0, 5000));
        vm.prank(deployer);
        holding.setUnfilledForfeitBps(rate);
        ISidequestHolding.PublishParams memory p = params();
        p.creatorBond = bond;
        uint256 job = publishWith(p);
        _cancelAt(job, 600);
        uint256 taken = bond * rate / 10_000;
        assertEq(factory.balanceOf(treasury), taken);
        assertEq(vault.totalAssets(), CREATOR_STAKE + WORKER_STAKE - taken);
        assertEq(vault.totalReserved(), 0);
        assertEq(circulating(), 1_000_000_000e18);
    }
}
