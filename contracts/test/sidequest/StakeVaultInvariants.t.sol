// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {StakeVaultFixture} from "./StakeVault.t.sol";

/// @dev Three owners, two backed accounts, and a Holding driving the pool's bond operations.
contract DelegatedVaultHandler is Test {
    LaunchToken public immutable token;
    StakeVault public immutable vault;
    address public immutable holding;
    address[3] public delegators;
    address[2] public accounts;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public slashed;
    uint256 public forfeited;
    address[3] public recipients;
    mapping(address recipient => uint256 amount) public slashPaid;
    address public immutable forfeitRecipient;

    constructor(
        LaunchToken token_,
        StakeVault vault_,
        address holding_,
        address[3] memory owners,
        address[2] memory backed
    ) {
        token = token_;
        vault = vault_;
        holding = holding_;
        delegators = owners;
        accounts = backed;
        recipients = [vault_.slashRecipient(), makeAddr("slash-1"), makeAddr("slash-2")];
        forfeitRecipient = makeAddr("forfeit-recipient");
    }

    function delegate(uint256 payerSeed, uint256 ownerSeed, uint256 accountSeed, uint96 amount) external {
        address payer = delegators[payerSeed % 3];
        address owner = delegators[ownerSeed % 3];
        address account = accounts[accountSeed % 2];
        uint256 balance = token.balanceOf(payer);
        if (balance == 0) return;
        uint256 assets = bound(amount, 1, balance < 1_000e18 ? balance : 1_000e18);
        vm.prank(payer);
        vault.delegateFor(account, owner, assets);
        deposited += assets;
    }

    function request(uint256 ownerSeed, uint256 accountSeed, uint256 amount) external {
        address owner = delegators[ownerSeed % 3];
        address account = accounts[accountSeed % 2];
        IStakeVault.Position memory position = vault.positionOf(account, owner);
        uint256 active = position.shares - position.queuedShares;
        uint256 capacity = type(uint192).max - vault.poolOf(account).queuedShares;
        if (active > capacity) active = capacity;
        if (active == 0) return;
        uint256 shares = bound(amount, 1, active);
        vm.prank(owner);
        vault.requestUndelegate(account, shares);
    }

    function cancel(uint256 ownerSeed, uint256 accountSeed) external {
        address owner = delegators[ownerSeed % 3];
        address account = accounts[accountSeed % 2];
        if (vault.positionOf(account, owner).queuedShares == 0) return;
        vm.prank(owner);
        vault.cancelUndelegate(account);
    }

    function withdraw(uint256 ownerSeed, uint256 accountSeed) external {
        address owner = delegators[ownerSeed % 3];
        address account = accounts[accountSeed % 2];
        uint256 before = token.balanceOf(owner);
        vm.prank(owner);
        // A still-bonded or not-yet-unlocked withdrawal is a valid attempted interleaving.
        try vault.withdraw(account) {
            withdrawn += token.balanceOf(owner) - before;
        } catch {}
    }

    function reserve(uint256 accountSeed, uint96 amount) external {
        address account = accounts[accountSeed % 2];
        uint256 available = vault.availableOf(account);
        if (available == 0) return;
        uint256 assets = bound(amount, 1, available);
        vm.prank(holding);
        vault.reserve(account, assets);
    }

    function release(uint256 accountSeed, uint96 amount) external {
        address account = accounts[accountSeed % 2];
        uint256 reserved = vault.reservedBy(holding, account);
        if (reserved == 0) return;
        uint256 assets = bound(amount, 1, reserved);
        vm.prank(holding);
        vault.release(account, assets);
    }

    function slash(uint256 accountSeed, uint96 amount) external {
        address account = accounts[accountSeed % 2];
        uint256 reserved = vault.reservedBy(holding, account);
        if (reserved == 0) return;
        uint256 assets = bound(amount, 1, reserved);
        address recipient = vault.slashRecipient();
        vm.prank(holding);
        uint256 moved = vault.slash(account, assets);
        slashPaid[recipient] += moved;
        slashed += moved;
    }

    function fullSlash(uint256 accountSeed, uint256 queuedOwnerSeed) external {
        address account = accounts[accountSeed % 2];
        if (vault.poolOf(account).assets == 0) return;
        for (uint256 i; i < 3; ++i) {
            if (vault.positionOf(account, delegators[i]).queuedShares == 0) continue;
            vm.prank(delegators[i]);
            vault.cancelUndelegate(account);
        }
        uint256 available = vault.availableOf(account);
        vm.prank(holding);
        vault.reserve(account, available);
        address owner = delegators[queuedOwnerSeed % 3];
        uint256 shares = vault.positionOf(account, owner).shares;
        if (shares > 0 && shares <= type(uint192).max) {
            vm.prank(owner);
            vault.requestUndelegate(account, shares);
        }
        uint256 assets = vault.poolOf(account).assets;
        address recipient = vault.slashRecipient();
        vm.prank(holding);
        uint256 moved = vault.slash(account, assets);
        slashPaid[recipient] += moved;
        slashed += moved;
    }

    function changeSlashRecipient(uint256 seed) external {
        address owner = vault.owner();
        vm.prank(owner);
        vault.setSlashRecipient(recipients[seed % 3]);
    }

    function forfeit(uint256 accountSeed, uint96 amount) external {
        address account = accounts[accountSeed % 2];
        uint256 reserved = vault.reservedBy(holding, account);
        if (reserved == 0) return;
        uint256 assets = bound(amount, 1, reserved);
        vm.prank(holding);
        forfeited += vault.forfeit(account, assets, forfeitRecipient);
    }

    function warp(uint32 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 10 days));
    }
}

contract StakeVaultDelegationInvariantsTest is StakeVaultFixture {
    DelegatedVaultHandler handler;
    address[3] delegators;
    address[2] accounts;
    uint256 initialOwnersBalance;

    function setUp() public override {
        super.setUp();
        delegators = [alice, bob, makeAddr("carol")];
        accounts = [makeAddr("backed-a"), makeAddr("backed-b")];
        token.transfer(delegators[2], 1_000_000e18);
        vm.prank(delegators[2]);
        token.approve(address(vault), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            initialOwnersBalance += token.balanceOf(delegators[i]);
        }
        handler = new DelegatedVaultHandler(token, vault, holding, delegators, accounts);
        targetContract(address(handler));
    }

    function invariant_booksAndPoolSharesBalance() public view {
        uint256 totalAssets;
        uint256 totalReserved;
        for (uint256 i; i < 2; ++i) {
            address account = accounts[i];
            IStakeVault.Pool memory pool = vault.poolOf(account);
            totalAssets += pool.assets;
            totalReserved += pool.reserved;
            assertLe(pool.reserved, pool.assets, "reservations covered by all assets");
            assertEq(pool.shares == 0, pool.assets == 0, "empty pool equivalence");
            assertLe(pool.queuedShares, pool.shares);
            assertLe(pool.shares, type(uint192).max, "every accepted position fits one exit queue");
            uint256 shares;
            uint256 queued;
            uint256 positionValues;
            for (uint256 j; j < 3; ++j) {
                IStakeVault.Position memory position = vault.positionOf(account, delegators[j]);
                assertEq(position.generation, pool.generation);
                assertLe(position.queuedShares, position.shares);
                uint256 value = vault.convertToAssets(account, position.shares);
                assertLe(value, pool.assets, "no owner is worth more than its pool");
                positionValues += value;
                shares += position.shares;
                queued += position.queuedShares;
            }
            assertEq(shares, pool.shares, "owners hold all shares");
            assertEq(queued, pool.queuedShares, "owners hold the whole queue");
            assertLe(positionValues, pool.assets, "flooring cannot create value");
            assertLe(uint256(pool.assets) - positionValues, 2, "at most 1 wei dust per owner");
            assertEq(pool.reserved, vault.reservedBy(holding, account));
            uint256 active = vault.stakeOf(account);
            assertEq(vault.availableOf(account), active > pool.reserved ? active - pool.reserved : 0);
        }
        assertEq(totalAssets, vault.totalAssets());
        assertEq(totalReserved, vault.totalReserved());
        assertGe(token.balanceOf(address(vault)), totalAssets);
    }

    function invariant_depositsOnlyReturnExistingAssets() public view {
        assertEq(
            handler.deposited(), handler.withdrawn() + handler.slashed() + handler.forfeited() + vault.totalAssets()
        );
        uint256 recipientBalances;
        for (uint256 i; i < 3; ++i) {
            address recipient = handler.recipients(i);
            assertEq(token.balanceOf(recipient), handler.slashPaid(recipient));
            recipientBalances += token.balanceOf(recipient);
        }
        assertEq(recipientBalances, handler.slashed(), "all slashes reach their current recipient");
        assertEq(token.balanceOf(handler.forfeitRecipient()), handler.forfeited());
        assertEq(token.totalSupply(), SUPPLY, "SIDE has no burn");
        uint256 ownersBalance;
        for (uint256 i; i < 3; ++i) {
            ownersBalance += token.balanceOf(delegators[i]);
        }
        assertEq(ownersBalance + vault.totalAssets() + handler.slashed() + handler.forfeited(), initialOwnersBalance);
    }
}
