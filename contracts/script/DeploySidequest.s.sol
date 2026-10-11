// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {SidequestOutput} from "./SidequestOutput.sol";

/// @notice Step 1 of 2: broadcasts the Sidequest v1 recipe for one network. It never touches `config/<network>.json`:
///         forge runs this function locally *before* it broadcasts anything, so whatever it writes is only what it
///         intends to send (review C8-001). It writes that as a candidate, `broadcast/sidequest/<network>.candidate.json`
///         (gitignored), and only on a `--broadcast` run. Step 2, `PromoteSidequest`, verifies the candidate on-chain
///         and records it. Run deliberately, by the coordinator only:
///
///         NETWORK=monad-testnet forge script script/DeploySidequest.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
///
///         If the broadcast stops part way, finish it with the same command plus `--resume` (forge replays the saved
///         sequence; this function does not run again, so the candidate stays the one for that sequence). Mainnet
///         (chain 143) additionally requires MAINNET_GO=yes, set only on Kris's explicit go, and signs from a keystore,
///         never a raw key: `--account sidequest-deployer --password-file ~/.config/sidequest/deployer.password`
///         (docs/mainnet-runbook.md §2, §3.2).
contract DeploySidequest is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory json = vm.readFile(SidequestRecipe.path(vm, network));
        SidequestRecipe.guardChain(vm, json, true);
        SidequestRecipe.Config memory c = SidequestRecipe.load(vm, network);
        SidequestRecipe.checkLaunchToken(c);
        // Refuse before broadcasting anything if the record could not be written afterwards.
        SidequestOutput.preflight(vm, json);
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        SidequestRecipe.Deployed memory d = SidequestRecipe.deploy(c);
        vm.stopBroadcast();
        // A dry run writes nothing: its addresses were never sent.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory candidate = SidequestOutput.candidatePath(vm, network);
            SidequestOutput.writeCandidate(vm, candidate, c.chainId, d, c.safe);
            console2.log("candidate (not yet verified):", candidate);
            console2.log("after the broadcast completes, run script/PromoteSidequest.s.sol");
        } else {
            console2.log("dry run: nothing written");
        }
    }
}
