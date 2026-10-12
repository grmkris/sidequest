// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {AgentSweep} from "../src/sidequest/AgentSweep.sol";
import {IERC8004Identity} from "../src/vendor/erc8004/IERC8004.sol";

/// @notice NETWORK=monad-testnet forge script script/DeployAgentSweep.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --account <keystore> --broadcast
///         The identity registry is `config/<NETWORK>.json`'s `erc8004.identity`; the run refuses any other chain, and
///         chain 143 also needs `MAINNET_GO=yes` (Kris present). AgentSweep has no owner, so any deployer key will do.
///         Record the printed address in config by hand.
contract DeployAgentSweep is Script {
    error NoIdentityRegistry(address identity);

    function run() external returns (AgentSweep) {
        return run(vm.envString("NETWORK"));
    }

    function run(string memory network) public returns (AgentSweep sweep) {
        string memory json = vm.readFile(SidequestRecipe.path(vm, network));
        SidequestRecipe.guardChain(vm, json, true);
        IERC8004Identity identity = IERC8004Identity(vm.parseJsonAddress(json, ".erc8004.identity"));
        if (address(identity).code.length == 0) revert NoIdentityRegistry(address(identity));

        vm.startBroadcast();
        sweep = new AgentSweep(identity);
        vm.stopBroadcast();

        console2.log("record as the network's agentSweep address:");
        console2.log("  agentSweep", address(sweep));
        console2.log("  identity", address(identity));
    }
}
