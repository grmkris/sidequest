// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "../src/vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IStakeVault} from "../src/sidequest/interfaces/IStakeVault.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";

/// @dev Launch rehearsal only (R7, `script/rehearse-launch.sh`): runs against a scratch `config/rehearsal-*.json` on a
///      local anvil fork, with throwaway keys passed in the environment. Refuses any other config name.
abstract contract RehearsalScript is Script {
    string internal json;

    function _load() internal {
        string memory network = vm.envString("NETWORK");
        bytes memory n = bytes(network);
        require(
            n.length > 10 && keccak256(bytes(vm.split(network, "-")[0])) == keccak256("rehearsal"),
            "rehearsal configs only (config/rehearsal-*.json)"
        );
        json = vm.readFile(SidequestRecipe.path(vm, network));
        SidequestRecipe.guardChain(vm, json, true);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }
}

/// @notice One direct hire through the v1 pair: the worker registers and stakes, the creator publishes in USDC and
///         signs the selection, the worker activates and submits, the creator accepts, anyone settles.
///         Keys: DEPLOYER_KEY (holds SIDE and USDC), CREATOR_KEY, WORKER_KEY.
contract RehearseHire is RehearsalScript {
    function run() external {
        _load();
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        uint256 creatorKey = vm.envUint("CREATOR_KEY");
        uint256 workerKey = vm.envUint("WORKER_KEY");
        address creator = vm.addr(creatorKey);
        address worker = vm.addr(workerKey);
        ISidequestHolding holding = ISidequestHolding(_addr(".deployment.main.holding"));
        ISidequestEvaluator evaluator = ISidequestEvaluator(_addr(".deployment.main.evaluator"));
        ERC8183WithAuthorization core = ERC8183WithAuthorization(_addr(".deployment.core"));
        IStakeVault vault = IStakeVault(_addr(".deployment.sidequest.vault"));
        IERC20 factory = IERC20(_addr(".deployment.sidequest.factory"));
        IERC20 usdc = IERC20(_addr(".liquidity.quote"));
        IERC8004Identity identity = IERC8004Identity(_addr(".erc8004.identity"));
        uint256 reward = 25e6;

        vm.startBroadcast(deployerKey);
        factory.transfer(worker, 20_000e18);
        factory.transfer(creator, holding.minimumCreatorBond());
        usdc.transfer(creator, reward);
        vm.stopBroadcast();

        vm.startBroadcast(workerKey);
        uint256 agentId = identity.register();
        factory.approve(address(vault), 20_000e18);
        vault.delegate(worker, 20_000e18);
        vm.stopBroadcast();

        uint48 deadline = uint48(block.timestamp + 1 days);
        bytes32 policy = keccak256(abi.encode("rehearsal-policy", block.timestamp));
        ISidequestHolding.PublishParams memory p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("rehearsal-manifest"),
            policyHash: policy,
            token: usdc,
            reward: reward,
            creatorBond: holding.minimumCreatorBond(),
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + 1 hours + 1 hours + 12 hours + 1 days,
            reviewWindow: 1 hours,
            disputeWindow: 1 hours,
            arbitrationWindow: 12 hours
        });
        vm.startBroadcast(creatorKey);
        factory.approve(address(vault), p.creatorBond);
        vault.delegate(creator, p.creatorBond);
        usdc.approve(address(holding), reward);
        uint256 jobId = holding.publish(p);
        vm.stopBroadcast();

        ISidequestHolding.Selection memory sel =
            ISidequestHolding.Selection(jobId, worker, agentId, policy, deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorKey, holding.selectionDigest(sel));
        bytes memory creatorSig = abi.encodePacked(r, s, v);
        (, uint256 fee, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(core, workerKey, worker, jobId, address(usdc), net);

        vm.startBroadcast(workerKey);
        holding.activate(sel, creatorSig, auth);
        core.submit(jobId, keccak256("rehearsal-work"), "");
        vm.stopBroadcast();

        vm.startBroadcast(creatorKey);
        evaluator.accept{gas: 1_200_000}(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        vm.stopBroadcast();

        console2.log("job", jobId);
        console2.log("agentId", agentId);
        console2.log("fee to treasury", fee);
        console2.log("net to worker", net);
    }

    function _budgetAuth(
        ERC8183WithAuthorization core,
        uint256 key,
        address signer,
        uint256 jobId,
        address token,
        uint256 amount
    ) internal view returns (ERC8183WithAuthorization.Authorization memory) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                signer,
                jobId,
                token,
                amount,
                keccak256(""),
                uint72(1),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return ERC8183WithAuthorization.Authorization(signer, 1, deadline, abi.encodePacked(r, s, v));
    }
}
