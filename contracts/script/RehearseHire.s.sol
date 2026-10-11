// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "../src/vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IStakeVault} from "../src/sidequest/interfaces/IStakeVault.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {SidequestConstants} from "../src/sidequest/interfaces/SidequestConstants.sol";

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

/// @notice Two hires through the v1 pair, paid in SIDE as Sidequest's own tasks are. The first: the worker registers and
///         stakes, the creator publishes, signs the selection, the worker activates and submits, the creator accepts,
///         anyone settles. The second is activated and never delivered; `RehearseSlash` settles it after the deadline.
///         Keys: FUNDER_KEY (holds the dev-buy SIDE), CREATOR_KEY, WORKER_KEY.
contract RehearseHire is RehearsalScript {
    uint256 internal constant REWARD = 2_000_000e18;
    uint256 internal constant WORKER_STAKE = 2_000_000e18;
    uint256 internal constant WORKER_BOND = 1_000_000e18;

    function run() external {
        _load();
        uint256 funderKey = vm.envUint("FUNDER_KEY");
        uint256 creatorKey = vm.envUint("CREATOR_KEY");
        uint256 workerKey = vm.envUint("WORKER_KEY");
        address creator = vm.addr(creatorKey);
        address worker = vm.addr(workerKey);
        ISidequestHolding holding = ISidequestHolding(_addr(".deployment.main.holding"));
        IStakeVault vault = IStakeVault(_addr(".deployment.sidequest.vault"));
        IERC20 side = IERC20(_addr(".deployment.sidequest.factory"));
        IERC8004Identity identity = IERC8004Identity(_addr(".erc8004.identity"));
        uint256 creatorBond = holding.minimumCreatorBond();

        vm.startBroadcast(funderKey);
        side.transfer(worker, WORKER_STAKE);
        side.transfer(creator, creatorBond + 2 * REWARD);
        vm.stopBroadcast();

        // The worker stakes with one EIP-2612 permit signature: the launcher's token supports it.
        (uint8 pv, bytes32 pr, bytes32 ps, uint256 permitDeadline) = _permit(workerKey, address(vault), WORKER_STAKE);
        vm.startBroadcast(workerKey);
        uint256 agentId = identity.register();
        vault.delegateWithPermit(worker, WORKER_STAKE, permitDeadline, pv, pr, ps);
        vm.stopBroadcast();
        require(vault.stakeOf(worker) == WORKER_STAKE, "the permit stake did not land");

        vm.startBroadcast(creatorKey);
        side.approve(address(vault), creatorBond);
        vault.delegate(creator, creatorBond);
        vm.stopBroadcast();

        (uint256 jobId, uint256 fee, uint256 net) = _hire(creatorKey, workerKey, agentId, "delivered");
        vm.startBroadcast(workerKey);
        ERC8183WithAuthorization(_addr(".deployment.core")).submit(jobId, keccak256("rehearsal-work"), "");
        vm.stopBroadcast();
        vm.startBroadcast(creatorKey);
        ISidequestEvaluator(_addr(".deployment.main.evaluator")).accept{gas: 1_200_000}(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        vm.stopBroadcast();

        (uint256 missed,,) = _hire(creatorKey, workerKey, agentId, "missed");

        console2.log("job", jobId);
        console2.log("agentId", agentId);
        console2.log("fee to treasury", fee);
        console2.log("net to worker", net);
        console2.log("slash job", missed);
    }

    /// @dev Publishes a SIDE-paid hire for the worker and activates it; returns the job and the quoted fee and net.
    function _hire(uint256 creatorKey, uint256 workerKey, uint256 agentId, string memory tag)
        internal
        returns (uint256 jobId, uint256 fee, uint256 net)
    {
        ISidequestHolding holding = ISidequestHolding(_addr(".deployment.main.holding"));
        ERC8183WithAuthorization core = ERC8183WithAuthorization(_addr(".deployment.core"));
        IERC20 side = IERC20(_addr(".deployment.sidequest.factory"));
        address worker = vm.addr(workerKey);
        uint48 deadline = uint48(block.timestamp + 1 days);
        bytes32 policy = keccak256(abi.encode("rehearsal-policy", tag, block.timestamp));
        ISidequestHolding.PublishParams memory p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256(abi.encode("rehearsal-manifest", tag)),
            policyHash: policy,
            token: side,
            reward: REWARD,
            creatorBond: holding.minimumCreatorBond(),
            workerBond: WORKER_BOND,
            deliveryDeadline: deadline,
            expiredAt: deadline + 1 hours + 1 hours + 12 hours + 1 days,
            reviewWindow: 1 hours,
            disputeWindow: 1 hours,
            arbitrationWindow: 12 hours
        });
        vm.startBroadcast(creatorKey);
        side.approve(address(holding), REWARD);
        jobId = holding.publish(p);
        vm.stopBroadcast();

        // The selection nonce is per creator, and this creator selects twice: the job id keeps each one unique.
        ISidequestHolding.Selection memory sel =
            ISidequestHolding.Selection(jobId, worker, agentId, policy, deadline - 1, jobId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorKey, holding.selectionDigest(sel));
        (, fee, net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(core, workerKey, worker, jobId, address(side), net);
        vm.startBroadcast(workerKey);
        holding.activate(sel, abi.encodePacked(r, s, v), auth);
        vm.stopBroadcast();
    }

    function _permit(uint256 key, address spender, uint256 amount)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s, uint256 deadline)
    {
        IERC20Permit side = IERC20Permit(_addr(".deployment.sidequest.factory"));
        address owner = vm.addr(key);
        deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                amount,
                side.nonces(owner),
                deadline
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", side.DOMAIN_SEPARATOR(), structHash)));
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
                uint72(jobId),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        // The authorization nonce is per signer, and this worker authorizes two budgets: the job id keeps each unique.
        return ERC8183WithAuthorization.Authorization(signer, uint72(jobId), deadline, abi.encodePacked(r, s, v));
    }
}

/// @notice The undelivered hire, strictly after its delivery deadline: anyone rejects it, which penalizes the worker
///         bond, then settles. SIDE has no burn, so the slashed bond must arrive at `SidequestConstants.SLASH_SINK`.
///         Keys: CREATOR_KEY (any account works; the calls are permissionless).
contract RehearseSlash is RehearsalScript {
    function run(uint256 jobId) external {
        _load();
        ISidequestHolding holding = ISidequestHolding(_addr(".deployment.main.holding"));
        IERC20 side = IERC20(_addr(".deployment.sidequest.factory"));
        uint256 bond = holding.getListing(jobId).workerBond;
        uint256 sunk = side.balanceOf(SidequestConstants.SLASH_SINK);
        vm.startBroadcast(vm.envUint("CREATOR_KEY"));
        ISidequestEvaluator(_addr(".deployment.main.evaluator")).rejectAfterDeliveryDeadline{gas: 1_200_000}(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        vm.stopBroadcast();
        require(holding.getListing(jobId).workerBondBurned, "the missed delivery did not penalize the worker bond");
        require(side.balanceOf(SidequestConstants.SLASH_SINK) == sunk + bond, "the slashed bond is not in the sink");
        console2.log("slashed to the sink", bond);
    }
}
