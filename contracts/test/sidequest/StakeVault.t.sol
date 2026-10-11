// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {SidequestConstants} from "../../src/sidequest/interfaces/SidequestConstants.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";

abstract contract StakeVaultFixture is Test {
    uint256 constant SUPPLY = 1_000_000_000e18;

    address safe = makeAddr("safe");
    address holding = makeAddr("holding");
    address holding2 = makeAddr("holding2");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    LaunchToken token;
    StakeVault vault;
    uint256 t0;

    function setUp() public virtual {
        t0 = vm.getBlockTimestamp();
        token = new LaunchToken(address(this));
        vault = new StakeVault(token, SidequestClocks.production());
        vault.bootstrapHolding(holding);
        vault.transferOwnership(safe);
        vm.prank(safe);
        vault.acceptOwnership();

        token.transfer(alice, 1_000_000e18);
        token.transfer(bob, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        vault.delegate(who, amount);
    }

    function _reserve(address by, address who, uint256 amount) internal {
        vm.prank(by);
        vault.reserve(who, amount);
    }

    function _assertConserved() internal view {
        assertEq(token.balanceOf(address(vault)), vault.totalAssets(), "balance");
        assertLe(vault.totalReserved(), vault.totalAssets(), "reserved <= staked");
    }
}

contract StakeVaultTest is StakeVaultFixture {
    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    function test_stake_creditsAndCountsForTier() public {
        _stake(alice, 100e18);
        assertEq(vault.stakeOf(alice), 100e18);
        assertEq(vault.availableOf(alice), 100e18);
        assertEq(vault.totalAssets(), 100e18);
        _assertConserved();
    }

    function test_stake_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(IStakeVault.ZeroAmount.selector);
        vault.delegate(alice, 0);
    }

    function test_stakeFor_paidByCallerCreditsAccount() public {
        vm.prank(bob);
        vm.expectEmit(address(vault));
        emit IStakeVault.Delegated(alice, alice, bob, 5e18, 5e18);
        vault.delegateFor(alice, alice, 5e18);
        assertEq(vault.stakeOf(alice), 5e18);
        assertEq(vault.stakeOf(bob), 0);
        assertEq(token.balanceOf(bob), 1_000_000e18 - 5e18);

        vm.prank(bob);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.delegateFor(address(0), bob, 1);
    }

    function test_stakeWithPermit_andToleratesAFrontRunPermit() public {
        (address carol, uint256 key) = makeAddrAndKey("carol");
        token.transfer(carol, 10e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, carol, 10e18, 0, deadline);

        // Someone submits the permit first; the stake still goes through on the allowance it left.
        token.permit(carol, address(vault), 10e18, deadline, v, r, s);
        vm.prank(carol);
        vault.delegateWithPermit(carol, 10e18, deadline, v, r, s);
        assertEq(vault.stakeOf(carol), 10e18);
    }

    function test_stakeWithPermit_plain() public {
        (address carol, uint256 key) = makeAddrAndKey("carol");
        token.transfer(carol, 10e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, carol, 10e18, 0, deadline);
        vm.prank(carol);
        vault.delegateWithPermit(carol, 10e18, deadline, v, r, s);
        assertEq(vault.stakeOf(carol), 10e18);
        assertEq(token.allowance(carol, address(vault)), 0);
    }

    function test_delegateWithPermit_backingAnotherAccountKeepsSignerOwnership() public {
        (address carol, uint256 key) = makeAddrAndKey("permit-delegator");
        token.transfer(carol, 10e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 sigS) = _signPermit(key, carol, 10e18, 0, deadline);
        vm.prank(carol);
        vault.delegateWithPermit(alice, 10e18, deadline, v, r, sigS);
        assertEq(vault.positionOf(alice, carol).shares, 10e18);
        assertEq(vault.positionOf(alice, alice).shares, 0);
        assertEq(vault.stakeOf(alice), 10e18);
        assertEq(vault.stakeOf(carol), 0);
    }

    function test_delegateWithPermit_invalidPermitWithoutAllowanceLeavesBooksUntouched() public {
        vm.startPrank(alice);
        token.approve(address(vault), 0);
        vm.expectRevert();
        vault.delegateWithPermit(bob, 1, block.timestamp, 0, bytes32(0), bytes32(0));
        vm.stopPrank();
        assertEq(vault.poolOf(bob).assets, 0);
        assertEq(vault.positionOf(bob, alice).shares, 0);
        _assertConserved();
    }

    function _signPermit(uint256 key, address owner, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(vault),
                value,
                nonce,
                deadline
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---------------------------------------------------------------------------------------------
    // Unstaking (timelock)
    // ---------------------------------------------------------------------------------------------

    function test_unstake_cooldownSevenDays() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vault.requestUndelegate(alice, 40e18);
        IStakeVault.Position memory position = vault.positionOf(alice, alice);
        uint256 amount = position.queuedShares;
        uint48 unlockAt = position.unlockAt;
        assertEq(amount, 40e18);
        assertEq(unlockAt, t0 + 14 days);
        assertEq(vault.stakeOf(alice), 60e18, "cooldown no longer counts for the tier");
        _assertConserved();

        vm.warp(t0 + 14 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.UndelegateLocked.selector, uint48(t0 + 14 days)));
        vault.withdraw(alice);

        vm.warp(t0 + 14 days);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(alice);
        assertEq(token.balanceOf(alice), before + 40e18);
        assertEq(vault.poolOf(alice).queuedShares, 0);
        _assertConserved();

        vm.prank(alice);
        vm.expectRevert(IStakeVault.NothingQueued.selector);
        vault.withdraw(alice);
    }

    function test_unstake_secondRequestRestartsCooldown() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vault.requestUndelegate(alice, 10e18);
        vm.warp(t0 + 6 days);
        vm.prank(alice);
        vault.requestUndelegate(alice, 10e18);
        IStakeVault.Position memory position = vault.positionOf(alice, alice);
        uint256 amount = position.queuedShares;
        uint48 unlockAt = position.unlockAt;
        assertEq(amount, 20e18);
        assertEq(unlockAt, t0 + 20 days);
    }

    function test_unstake_cancelRestoresStake() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vault.requestUndelegate(alice, 30e18);
        vm.prank(alice);
        vault.cancelUndelegate(alice);
        assertEq(vault.stakeOf(alice), 100e18);
        uint256 amount = vault.positionOf(alice, alice).queuedShares;
        assertEq(amount, 0);
        _assertConserved();

        vm.prank(alice);
        vm.expectRevert(IStakeVault.NothingQueued.selector);
        vault.cancelUndelegate(alice);
    }

    function test_undelegate_bondsAllowQueueButBlockWithdrawal() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 70e18);
        vm.prank(alice);
        vault.requestUndelegate(alice, 40e18);
        assertEq(vault.stakeOf(alice), 60e18);
        assertEq(vault.availableOf(alice), 0);
        vm.warp(t0 + 14 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.StillBonded.selector, 60e18, 70e18));
        vault.withdraw(alice);
        vm.prank(holding);
        vault.release(alice, 10e18);
        vm.prank(alice);
        vault.withdraw(alice);
        assertEq(vault.poolOf(alice).assets, 60e18);
        _assertConserved();
    }

    // ---------------------------------------------------------------------------------------------
    // Bonds
    // ---------------------------------------------------------------------------------------------

    function test_reserve_onlyAuthorizedHolding() public {
        _stake(alice, 100e18);
        vm.prank(bob);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        vault.reserve(alice, 1);
        // A zero amount still checks authorization: a revoked Holding cannot publish even unbonded offers.
        vm.prank(bob);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        vault.reserve(alice, 0);
        _reserve(holding, alice, 0);
        assertEq(vault.reservedOf(alice), 0);
    }

    function test_reserve_limitedToAvailable() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 60e18);
        vm.prank(holding);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientAvailable.selector, 40e18, 41e18));
        vault.reserve(alice, 41e18);

        // Stake in cooldown cannot be reserved either.
        vm.prank(alice);
        vault.requestUndelegate(alice, 40e18);
        vm.prank(holding);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientAvailable.selector, 0, 1));
        vault.reserve(alice, 1);
    }

    function test_release_returnsToAvailable_cappedAtOwnReservation() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 60e18);
        vm.prank(holding);
        assertEq(vault.release(alice, 80e18), 60e18, "capped");
        assertEq(vault.reservedOf(alice), 0);
        assertEq(vault.reservedBy(holding, alice), 0);
        assertEq(vault.availableOf(alice), 100e18);
        vm.prank(holding);
        assertEq(vault.release(alice, 1), 0);
        _assertConserved();
    }

    function test_slash_burnsFromReservedOnly() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 60e18);
        uint256 supply = token.totalSupply();
        vm.prank(holding);
        vm.expectEmit(address(vault));
        emit IStakeVault.Slashed(holding, alice, 25e18);
        assertEq(vault.slash(alice, 25e18), 25e18);
        assertEq(token.balanceOf(SidequestConstants.SLASH_SINK), 25e18, "sent to the sink, out of circulation");
        assertEq(token.totalSupply(), supply, "SIDE has no burn");
        assertEq(vault.stakeOf(alice), 75e18);
        assertEq(vault.reservedOf(alice), 35e18);
        _assertConserved();

        // Capped at what this Holding reserved: the unreserved 40 are never touched.
        vm.prank(holding);
        assertEq(vault.slash(alice, 1_000e18), 35e18);
        assertEq(vault.stakeOf(alice), 40e18);
        assertEq(vault.reservedOf(alice), 0);
        _assertConserved();
    }

    function test_holdingCannotTouchAnotherHoldingsReservation() public {
        _authorize(holding2);
        _stake(alice, 100e18);
        _reserve(holding, alice, 50e18);
        _reserve(holding2, alice, 20e18);
        assertEq(vault.reservedOf(alice), 70e18);

        vm.prank(holding2);
        assertEq(vault.slash(alice, 50e18), 20e18, "only its own 20");
        vm.prank(holding2);
        assertEq(vault.release(alice, 1), 0);
        assertEq(vault.reservedBy(holding, alice), 50e18);
        assertEq(vault.stakeOf(alice), 80e18);
        _assertConserved();
    }

    // ---------------------------------------------------------------------------------------------
    // Holding authorization (timelock, bootstrap, revoke)
    // ---------------------------------------------------------------------------------------------

    function _authorize(address h) internal {
        vm.prank(safe);
        vault.proposeHolding(h);
        vm.warp(vm.getBlockTimestamp() + 15 days);
        vault.acceptHolding();
    }

    function test_holding_proposeAcceptAfterEightDays_anyoneAccepts() public {
        vm.prank(safe);
        vault.proposeHolding(holding2);
        (address pending, uint48 eta) = vault.pendingHolding();
        assertEq(pending, holding2);
        assertEq(eta, t0 + 15 days);

        vm.warp(t0 + 15 days - 1);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.HoldingTimelocked.selector, uint48(t0 + 15 days)));
        vault.acceptHolding();

        vm.warp(t0 + 15 days);
        vm.prank(bob);
        vault.acceptHolding();
        assertTrue(vault.isHolding(holding2));
        (pending,) = vault.pendingHolding();
        assertEq(pending, address(0));
    }

    /// @dev The timelock outlasts the cooldown: a staker who unstakes on the day of the proposal is out before the new
    ///      Holding can reserve anything.
    function test_holding_delayOutlastsCooldown() public {
        assertGt(vault.HOLDING_DELAY(), vault.UNSTAKE_DELAY());
        _stake(alice, 100e18);
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.prank(alice);
        vault.requestUndelegate(alice, 100e18);
        vm.warp(t0 + 14 days);
        vm.prank(alice);
        vault.withdraw(alice);
        vm.expectRevert();
        vault.acceptHolding();
    }

    function test_holding_onlyOwnerProposesCancelsRevokes() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.proposeHolding(holding2);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.revokeHolding(holding);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.cancelHoldingProposal();
    }

    function test_holding_proposalRules() public {
        vm.startPrank(safe);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.proposeHolding(address(0));
        vm.expectRevert(IStakeVault.HoldingAlreadyAuthorized.selector);
        vault.proposeHolding(holding);
        vm.expectRevert(IStakeVault.NoHoldingProposed.selector);
        vault.cancelHoldingProposal();
        vault.proposeHolding(holding2);
        vault.cancelHoldingProposal();
        vm.stopPrank();
        vm.warp(t0 + 9 days);
        vm.expectRevert(IStakeVault.NoHoldingProposed.selector);
        vault.acceptHolding();
    }

    function test_revoke_stopsReservingButExistingReservationsStillSettle() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 60e18);
        vm.prank(safe);
        vault.revokeHolding(holding);
        assertFalse(vault.isHolding(holding));

        vm.prank(holding);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        vault.reserve(alice, 1);

        vm.prank(holding);
        assertEq(vault.release(alice, 20e18), 20e18);
        vm.prank(holding);
        assertEq(vault.slash(alice, 40e18), 40e18);
        assertEq(vault.stakeOf(alice), 60e18);
        assertEq(vault.reservedOf(alice), 0);
        _assertConserved();

        vm.prank(safe);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        vault.revokeHolding(holding);
    }

    function test_bootstrap_onceOnly() public {
        // setUp already bootstrapped.
        assertTrue(vault.bootstrapped());
        vm.prank(safe);
        vm.expectRevert(IStakeVault.BootstrapClosed.selector);
        vault.bootstrapHolding(holding2);
    }

    function test_bootstrap_stakingClosedUntilBootstrapThenBootstrapWorks() public {
        StakeVault fresh = new StakeVault(token, SidequestClocks.production());
        token.approve(address(fresh), type(uint256).max);
        // Nobody can stake 1 wei ahead of the bootstrap to force the 15-day path.
        vm.expectRevert(IStakeVault.NotBootstrapped.selector);
        fresh.delegate(address(this), 1);
        vm.expectRevert(IStakeVault.NotBootstrapped.selector);
        fresh.delegateFor(alice, alice, 1);
        vm.expectRevert(IStakeVault.NotBootstrapped.selector);
        fresh.delegateWithPermit(address(this), 1, block.timestamp, 0, bytes32(0), bytes32(0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        fresh.bootstrapHolding(holding);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        fresh.bootstrapHolding(address(0));
        fresh.bootstrapHolding(holding);
        assertTrue(fresh.isHolding(holding));
        assertTrue(fresh.bootstrapped());

        fresh.delegate(address(this), 1);
        assertEq(fresh.stakeOf(address(this)), 1);
        vm.expectRevert(IStakeVault.BootstrapClosed.selector);
        fresh.bootstrapHolding(holding2);
    }

    function test_bootstrap_acceptedHoldingAlsoOpensStakingAndClosesBootstrap() public {
        StakeVault fresh = new StakeVault(token, SidequestClocks.production());
        fresh.proposeHolding(holding);
        vm.warp(t0 + 15 days);
        fresh.acceptHolding();
        assertTrue(fresh.bootstrapped());
        token.approve(address(fresh), 1);
        fresh.delegate(address(this), 1);
        vm.expectRevert(IStakeVault.BootstrapClosed.selector);
        fresh.bootstrapHolding(holding2);
    }

    function test_ownership_twoStep() public {
        vm.prank(safe);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), safe);
        assertEq(vault.pendingOwner(), bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz: random flows keep the books
    // ---------------------------------------------------------------------------------------------

    function testFuzz_flowsConserve(uint96 s, uint96 r, uint96 u, uint96 x, bool slashIt) public {
        uint256 staked = bound(uint256(s), 1, 1_000_000e18);
        _stake(alice, staked);
        uint256 reserved = bound(uint256(r), 0, staked);
        _reserve(holding, alice, reserved);
        uint256 unstake = bound(uint256(u), 0, staked - reserved);
        if (unstake > 0) {
            vm.prank(alice);
            vault.requestUndelegate(alice, unstake);
        }
        _assertConserved();
        uint256 amount = bound(uint256(x), 0, reserved + 1);
        uint256 sunk = token.balanceOf(SidequestConstants.SLASH_SINK);
        vm.prank(holding);
        uint256 moved = slashIt ? vault.slash(alice, amount) : vault.release(alice, amount);
        assertEq(moved, amount < reserved ? amount : reserved);
        assertEq(token.balanceOf(SidequestConstants.SLASH_SINK), sunk + (slashIt ? moved : 0));
        assertEq(vault.stakeOf(alice), (staked - unstake) * (staked - (slashIt ? moved : 0)) / staked);
        assertEq(vault.reservedOf(alice), reserved - moved);
        _assertConserved();
    }

    // ---------------------------------------------------------------------------------------------
    // C9 audit: the per-account veto, proposal expiry, stale proposals, handover
    // ---------------------------------------------------------------------------------------------

    /// @dev ACL-1: stake still bonded when a new Holding goes live is released later; the account's veto keeps the
    ///      new Holding from taking it.
    function test_deny_protectsStakeReleasedAfterANewHoldingArrives() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 60e18);
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.prank(alice);
        vault.setHoldingDenied(holding2, true);
        assertTrue(vault.holdingDenied(alice, holding2));
        vm.warp(vm.getBlockTimestamp() + 15 days);
        vault.acceptHolding();
        vm.prank(holding);
        vault.release(alice, 60e18);
        vm.prank(holding2);
        vm.expectRevert(IStakeVault.HoldingDenied.selector);
        vault.reserve(alice, 60e18);
        // A zero reservation still only checks authorization; the first Holding is unaffected.
        _reserve(holding2, alice, 0);
        _reserve(holding, alice, 10e18);
        vm.prank(alice);
        vault.setHoldingDenied(holding2, false);
        _reserve(holding2, alice, 10e18);
        _assertConserved();
    }

    function test_deny_neverStopsExistingReservationsSettling() public {
        _stake(alice, 100e18);
        _reserve(holding, alice, 50e18);
        vm.prank(alice);
        vault.setHoldingDenied(holding, true);
        vm.prank(holding);
        assertEq(vault.slash(alice, 20e18), 20e18);
        vm.prank(holding);
        assertEq(vault.release(alice, 30e18), 30e18);
    }

    function test_holding_proposalExpiresAfterTheGrace() public {
        assertEq(vault.PROPOSAL_GRACE(), 7 days);
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.warp(vm.getBlockTimestamp() + 15 days + 7 days + 1);
        vm.expectRevert(IStakeVault.HoldingProposalExpired.selector);
        vault.acceptHolding();
    }

    /// @dev ACL-4: propose, bootstrap-style authorization, revoke: the stale proposal cannot re-authorize it.
    function test_holding_revokeDropsAPendingProposalForTheSameHolding() public {
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.warp(vm.getBlockTimestamp() + 15 days);
        vault.acceptHolding();
        vm.prank(safe);
        vault.revokeHolding(holding2);
        // Re-proposed, then revoked again before acceptance: the proposal goes with it.
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.prank(safe);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        vault.revokeHolding(holding2);
        vm.prank(safe);
        vault.cancelHoldingProposal();
        (address pending,) = vault.pendingHolding();
        assertEq(pending, address(0));
    }

    function test_holding_revokeOfAnAuthorizedHoldingClearsItsProposal() public {
        StakeVault v = new StakeVault(token, SidequestClocks.production());
        v.proposeHolding(holding2);
        // Bootstrap is closed while a proposal is pending.
        vm.expectRevert(IStakeVault.BootstrapClosed.selector);
        v.bootstrapHolding(holding2);
        vm.warp(vm.getBlockTimestamp() + 15 days);
        v.acceptHolding();
        v.proposeHolding(holding);
        v.revokeHolding(holding2);
        (address pending,) = v.pendingHolding();
        assertEq(pending, holding, "only a proposal for the revoked Holding is dropped");
    }

    /// @dev ACL-3: a proposal never outlives its proposer.
    function test_holding_handoverDropsTheOldOwnersProposal() public {
        StakeVault v = new StakeVault(token, SidequestClocks.production());
        v.bootstrapHolding(holding);
        v.proposeHolding(holding2);
        v.transferOwnership(safe);
        vm.prank(safe);
        vm.expectEmit(true, false, false, false, address(v));
        emit IStakeVault.HoldingProposalCancelled(holding2);
        v.acceptOwnership();
        (address pending,) = v.pendingHolding();
        assertEq(pending, address(0));
        vm.warp(vm.getBlockTimestamp() + 15 days);
        vm.expectRevert(IStakeVault.NoHoldingProposed.selector);
        v.acceptHolding();
    }

    function test_holding_replacedProposalIsCancelledVisibly() public {
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.prank(safe);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IStakeVault.HoldingProposalCancelled(holding2);
        vault.proposeHolding(bob);
    }
}
