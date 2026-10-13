// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {SidequestSafeAccept, ISafe} from "./SidequestSafeAccept.sol";

/// @notice Run by the coordinator after `PromoteSidequest`, with a Safe owner's key (testnet: the backup owner):
///
///         NETWORK=monad-testnet forge script script/SafeAccept.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $SAFE_BACKUP_TESTNET_PRIVATE_KEY --broadcast
///
///         Without `--broadcast` it is a dry run. `--sig "check()"` only reads back the four owners. Chain 143 also
///         needs MAINNET_GO=yes and signs from a keystore, never a raw key: `--account sidequest-safe-owner
///         --password-file ~/.config/sidequest/safe-owner.password` (docs/mainnet-runbook.md §3.6). Sends up to four
///         transactions, from the owner, to the Safe.
contract SafeAccept is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory json = vm.readFile(SidequestRecipe.path(vm, network));
        SidequestRecipe.guardChain(vm, json, true);
        (address safe, address[4] memory t) = SidequestSafeAccept.targets(vm, json);
        vm.startBroadcast();
        uint256 accepted = SidequestSafeAccept.accept(ISafe(safe), t, msg.sender);
        vm.stopBroadcast();
        SidequestSafeAccept.verify(safe, t);
        console2.log("acceptOwnership sent through the Safe:", accepted);
        console2.log("owner() == safe on all four:", safe);
    }

    /// @notice Pending acceptances simulated as the owner; no transaction is recorded for broadcast.
    function simulate() external {
        require(
            !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume),
            "simulate cannot broadcast"
        );
        string memory json = vm.readFile(SidequestRecipe.path(vm, vm.envString("NETWORK")));
        SidequestRecipe.guardChain(vm, json, false);
        (address safe, address[4] memory t) = SidequestSafeAccept.targets(vm, json);
        vm.startPrank(msg.sender);
        uint256 accepted = SidequestSafeAccept.accept(ISafe(safe), t, msg.sender);
        vm.stopPrank();
        SidequestSafeAccept.verify(safe, t);
        console2.log("acceptOwnership simulated through the Safe:", accepted);
    }

    function check() external view {
        string memory json = vm.readFile(SidequestRecipe.path(vm, vm.envString("NETWORK")));
        SidequestRecipe.guardChain(vm, json, false);
        (address safe, address[4] memory t) = SidequestSafeAccept.targets(vm, json);
        SidequestSafeAccept.verify(safe, t);
        console2.log("owner() == safe on all four:", safe);
    }
}
