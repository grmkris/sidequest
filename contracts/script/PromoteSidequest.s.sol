// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {SidequestOutput} from "./SidequestOutput.sol";
import {SidequestVerify} from "./SidequestVerify.sol";

/// @notice Step 2 of 2 (review C8-001): records a broadcast Sidequest v1 deployment in `config/<network>.json`, in the
///         D1/D5 shape, only after proving it on-chain. Sends no transaction; run it without `--broadcast`:
///
///         NETWORK=monad-testnet forge script script/PromoteSidequest.s.sol --rpc-url $MONAD_TESTNET_RPC_URL
///
///         It reads the candidate `DeploySidequest` wrote and forge's receipts
///         (`broadcast/DeploySidequest.s.sol/<chainId>/run-latest.json`), and refuses unless every transaction of the
///         run has a successful receipt and `SidequestVerify.verify` passes against live state: code everywhere,
///         wiring, bootstrap, the configured SIDE with its fixed 1e9 supply, the configured fee schedule, every owner the
///         Safe or pending to it, and on a fresh core both admin roles held by the Safe and renounced by the deployer.
///         Block numbers come from the receipts. Running it again after success changes nothing.
contract PromoteSidequest is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        SidequestRecipe.guardChain(vm, vm.readFile(SidequestRecipe.path(vm, network)), false);
        SidequestRecipe.Config memory c = SidequestRecipe.load(vm, network);
        (SidequestRecipe.Deployed memory d, address safe, uint256 chainId) =
            SidequestOutput.readCandidate(vm, SidequestOutput.candidatePath(vm, network));
        require(chainId == c.chainId && block.chainid == c.chainId, "candidate is for another chain");
        require(safe == c.safe, "candidate names another Safe");

        string memory path = SidequestRecipe.path(vm, network);
        if (SidequestOutput.isPromoted(vm, vm.readFile(path), d, safe)) {
            SidequestVerify.verify(c, d);
            console2.log("already promoted; config unchanged:", path);
            return;
        }
        SidequestVerify.verify(c, d);
        (uint256 coreBlock, uint256 sidequestBlock) =
            SidequestVerify.blocks(vm, SidequestVerify.runPath(vm, chainId), d);
        SidequestOutput.write(vm, path, d, safe, coreBlock, sidequestBlock);
        console2.log("promoted:", path);
        console2.log("sidequest.block", sidequestBlock);
    }
}
