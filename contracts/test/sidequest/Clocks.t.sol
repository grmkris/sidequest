// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV1} from "./BaseV1.t.sol";
import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {FeeSchedule} from "../../src/sidequest/FeeSchedule.sol";
import {SidequestHolding} from "../../src/sidequest/SidequestHolding.sol";
import {IERC8004Identity} from "../../src/vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {IFeeSchedule} from "../../src/sidequest/interfaces/IFeeSchedule.sol";

contract ClocksTest is BaseV1 {
    // Exercise each real constructor, not only the shared validation helper.
    function deployOne(uint256 which, SidequestClocks.Config memory c) external returns (address) {
        if (which == 0) return address(new StakeVault(factory, address(this), c));
        if (which == 1) return address(new FeeSchedule(defaultSchedule(treasury), c));
        if (which == 2) {
            return address(
                new SidequestHolding(
                    core,
                    vault,
                    fees,
                    IERC8004Identity(address(identity)),
                    arbitrator,
                    MARGIN,
                    CREATOR_BOND,
                    100_000e18,
                    2500,
                    c
                )
            );
        }
        revert("unknown constructor");
    }

    function _refuseAll(SidequestClocks.Config memory c, bytes32 name, uint256 value) internal {
        for (uint256 which; which < 3; ++which) {
            vm.expectRevert(abi.encodeWithSelector(SidequestClocks.InvalidClock.selector, name, value));
            this.deployOne(which, c);
        }
    }

    function _mainnet(uint256 field) internal {
        vm.chainId(143);
        SidequestClocks.Config memory c = SidequestClocks.production();
        bytes32 name;
        uint256 value;
        if (field == 0) {
            name = "minReviewWindow";
            value = ++c.minReviewWindow;
        }
        if (field == 1) {
            name = "minDisputeWindow";
            value = ++c.minDisputeWindow;
        }
        if (field == 2) {
            name = "minArbitrationWindow";
            value = ++c.minArbitrationWindow;
        }
        if (field == 3) {
            name = "unstakeDelay";
            value = ++c.unstakeDelay;
        }
        if (field == 4) {
            name = "holdingDelay";
            value = ++c.holdingDelay;
        }
        if (field == 5) {
            name = "feeDelay";
            value = ++c.feeDelay;
        }
        if (field == 6) {
            name = "proposalGrace";
            value = ++c.proposalGrace;
        }
        _refuseAll(c, name, value);
    }

    function test_143_refusesMinReviewWindow() public {
        _mainnet(0);
    }

    function test_143_refusesMinDisputeWindow() public {
        _mainnet(1);
    }

    function test_143_refusesMinArbitrationWindow() public {
        _mainnet(2);
    }

    function test_143_refusesUnstakeDelay() public {
        _mainnet(3);
    }

    function test_143_refusesHoldingDelay() public {
        _mainnet(4);
    }

    function test_143_refusesFeeDelay() public {
        _mainnet(5);
    }

    function test_143_refusesProposalGrace() public {
        _mainnet(6);
    }

    function test_143_acceptsProductionInAllConstructors() public {
        vm.chainId(143);
        for (uint256 which; which < 3; ++which) {
            assertTrue(this.deployOne(which, SidequestClocks.production()) != address(0));
        }
    }

    function test_everyChain_holdingDelayMustOutlastUnstake() public {
        vm.chainId(10143);
        SidequestClocks.Config memory c = SidequestClocks.production();
        c.holdingDelay = c.unstakeDelay;
        _refuseAll(c, "holdingDelay", c.holdingDelay);
        c.holdingDelay--;
        _refuseAll(c, "holdingDelay", c.holdingDelay);
    }

    function test_everyChain_zeroClocksRefuse() public {
        vm.chainId(10143);
        SidequestClocks.Config memory c = SidequestClocks.production();
        c.proposalGrace = 0;
        _refuseAll(c, "proposalGrace", 0);
        c = SidequestClocks.production();
        c.minReviewWindow = 0;
        _refuseAll(c, "minReviewWindow", 0);
        c = SidequestClocks.production();
        c.minDisputeWindow = 0;
        _refuseAll(c, "minDisputeWindow", 0);
        c = SidequestClocks.production();
        c.minArbitrationWindow = 0;
        _refuseAll(c, "minArbitrationWindow", 0);
    }

    function test_everyChain_windowsCannotExceedMaximums() public {
        vm.chainId(10143);
        SidequestClocks.Config memory c = SidequestClocks.production();
        c.minReviewWindow = 14 days + 1;
        _refuseAll(c, "minReviewWindow", c.minReviewWindow);
        c = SidequestClocks.production();
        c.minDisputeWindow = 14 days + 1;
        _refuseAll(c, "minDisputeWindow", c.minDisputeWindow);
        c = SidequestClocks.production();
        c.minArbitrationWindow = 14 days + 1;
        _refuseAll(c, "minArbitrationWindow", c.minArbitrationWindow);
    }

    function test_everyChain_delayAndEpochFloors() public {
        vm.chainId(10143);
        SidequestClocks.Config memory c = SidequestClocks.production();
        c.unstakeDelay = 59;
        _refuseAll(c, "unstakeDelay", 59);
        c = SidequestClocks.production();
        c.holdingDelay = 59;
        _refuseAll(c, "holdingDelay", 59);
        c = SidequestClocks.production();
        c.feeDelay = 59;
        _refuseAll(c, "feeDelay", 59);
        c = SidequestClocks.production();
        c.proposalGrace = 59;
        _refuseAll(c, "proposalGrace", 59);
    }
}

contract FastClocksTest is BaseV1 {
    function clocks() internal pure override returns (SidequestClocks.Config memory) {
        return SidequestClocks.Config(120, 120, 300, 259200, 262800, 300, 1800);
    }

    function test_fastWindowsPublishAtMinimums_belowEachRefuses() public {
        ISidequestHolding.PublishParams memory p = params();
        p.deliveryDeadline = uint48(block.timestamp + 1 days);
        p.expiredAt = p.deliveryDeadline + 120 + 120 + 300 + MARGIN;
        p.reviewWindow = 120;
        p.disputeWindow = 120;
        p.arbitrationWindow = 300;
        p.reviewWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                ISidequestHolding.WindowOutOfBounds.selector, p.reviewWindow, uint32(120), uint32(14 days)
            )
        );
        publishWith(p);
        p.reviewWindow = 120;
        p.disputeWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                ISidequestHolding.WindowOutOfBounds.selector, p.disputeWindow, uint32(120), uint32(14 days)
            )
        );
        publishWith(p);
        p.disputeWindow = 120;
        p.arbitrationWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                ISidequestHolding.WindowOutOfBounds.selector, p.arbitrationWindow, uint32(300), uint32(14 days)
            )
        );
        publishWith(p);
        p.arbitrationWindow = 300;
        uint256 job = publishWith(p);
        assertEq(holding.getListing(job).reviewWindow, 120);
    }

    function test_fastUnstakeExitBeforeHoldingAcceptance() public {
        uint256 t0 = vm.getBlockTimestamp();
        address newHolding = makeAddr("new-holding");
        vm.prank(deployer);
        vault.proposeHolding(newHolding);
        vm.prank(worker);
        vault.requestUndelegate(worker, 100e18);
        vm.warp(t0 + 259199);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.UndelegateLocked.selector, uint48(t0 + 259200)));
        vault.withdraw(worker);
        vm.warp(t0 + 259200);
        uint256 before = factory.balanceOf(worker);
        vm.prank(worker);
        vault.withdraw(worker);
        assertEq(factory.balanceOf(worker) - before, 100e18);
        vm.warp(t0 + 262799);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.HoldingTimelocked.selector, uint48(t0 + 262800)));
        vault.acceptHolding();
        vm.warp(t0 + 262800);
        vault.acceptHolding();
        assertTrue(vault.isHolding(newHolding));
    }

    function test_fastFeeDelayAndGraceCutoffs() public {
        uint256 t0 = vm.getBlockTimestamp();
        IFeeSchedule.Schedule memory s = defaultSchedule(stranger);
        vm.prank(deployer);
        fees.propose(s);
        vm.warp(t0 + 299);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleTimelocked.selector, uint48(t0 + 300)));
        fees.execute();
        vm.warp(t0 + 300);
        fees.execute();
        assertEq(fees.treasury(), stranger);
        vm.prank(deployer);
        fees.propose(defaultSchedule(treasury));
        vm.warp(t0 + 600 + 1800); // inclusive grace cutoff
        fees.execute();
        assertEq(fees.treasury(), treasury);
        vm.prank(deployer);
        fees.propose(s);
        uint48 eta = uint48(vm.getBlockTimestamp() + 300);
        vm.warp(uint256(eta) + 1801);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleExpired.selector, eta));
        fees.execute();
    }

    function test_fastHoldingGraceCutoff() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(deployer);
        vault.proposeHolding(stranger);
        vm.warp(t0 + 262800 + 1800);
        vault.acceptHolding();
        assertTrue(vault.isHolding(stranger));
        vm.prank(deployer);
        vault.proposeHolding(relayer);
        vm.warp(t0 + 2 * (262800 + 1800) + 1);
        vm.expectRevert(IStakeVault.HoldingProposalExpired.selector);
        vault.acceptHolding();
    }
}
