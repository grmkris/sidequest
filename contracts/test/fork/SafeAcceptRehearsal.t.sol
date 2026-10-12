// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {SidequestOutput} from "../../script/SidequestOutput.sol";
import {SidequestSafeAccept, ISafe} from "../../script/SidequestSafeAccept.sol";
import {IFactory} from "../../src/sidequest/interfaces/IFactory.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {RecipeDriver} from "../sidequest/Recipe.t.sol";
import {UnpromotedTestnet} from "../helpers/UnpromotedTestnet.sol";

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

/// @dev C10 dry run on a local fork of Monad testnet (nothing is sent): the recipe runs with the live testnet Safe as
///      `safe`, the record is promoted into a scratch config, and one of the Safe's real owners accepts all four
///      handovers through `execTransaction` with a pre-validated signature. Skipped unless MONAD_TESTNET_RPC_URL is
///      set (the public RPC works).
contract SafeAcceptRehearsalForkTest is Test {
    address stranger = makeAddr("stranger");

    function acceptExt(ISafe safe, address[4] memory t, address sender) external returns (uint256) {
        return SidequestSafeAccept.accept(safe, t, sender);
    }

    function verifyExt(address safe, address[4] memory t) external view {
        SidequestSafeAccept.verify(safe, t);
    }

    function test_fork_testnet_safeAcceptsAllFour() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return vm.skip(true);
        vm.createSelectFork(rpc);
        string memory real = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        address safe = vm.parseJsonAddress(real, ".sidequest.safe");
        assertGt(safe.code.length, 0, "the live testnet Safe");

        SidequestRecipe.Config memory c = SidequestRecipe.loadBase(vm, "monad-testnet");
        c.clocks = SidequestRecipe.load(vm, "monad-testnet").clocks;
        c.safe = safe;
        c.slashRecipient = safe;
        c.defaultArbitrator = makeAddr("arbiter");
        c.margin = 1 hours;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        c.token = IFactory(address(new LaunchToken(c.admin)));
        RecipeDriver driver = new RecipeDriver();
        driver.configure(c);
        for (uint256 i; i < 8; ++i) {
            driver.step(i);
        }
        SidequestRecipe.Deployed memory d = driver.deployed();

        // The promoted record, as PromoteSidequest writes it, in a scratch copy of the config.
        string memory path = string.concat(vm.projectRoot(), "/config/.test-safeaccept.json");
        UnpromotedTestnet.write(vm, path, real);
        SidequestOutput.write(vm, path, d, safe, block.number, block.number);
        (address recorded, address[4] memory t) = SidequestSafeAccept.targets(vm, vm.readFile(path));
        vm.removeFile(path);
        assertEq(recorded, safe);
        assertEq(t[2], address(d.holding));
        assertEq(t[3], address(d.evaluator));

        vm.expectRevert(abi.encodeWithSelector(SidequestSafeAccept.NotOwned.selector, t[0], c.admin));
        this.verifyExt(safe, t);
        vm.expectRevert(abi.encodeWithSelector(SidequestSafeAccept.NotSafeOwner.selector, stranger));
        this.acceptExt(ISafe(safe), t, stranger);

        address owner = ISafeOwners(safe).getOwners()[1];
        uint256 nonceBefore = ISafe(safe).nonce();
        vm.startPrank(owner, owner);
        uint256 accepted = SidequestSafeAccept.accept(ISafe(safe), t, owner);
        vm.stopPrank();
        assertEq(accepted, 4);
        assertEq(ISafe(safe).nonce(), nonceBefore + 4, "one Safe transaction per contract");
        SidequestSafeAccept.verify(safe, t);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);

        // Running it again sends nothing.
        vm.prank(owner, owner);
        assertEq(this.acceptExt(ISafe(safe), t, owner), 0);
    }
}
