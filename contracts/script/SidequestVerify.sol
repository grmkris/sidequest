// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {SidequestClocks} from "../src/sidequest/SidequestClocks.sol";
import {BroadcastPath} from "./BroadcastPath.sol";
import {IFeeSchedule} from "../src/sidequest/interfaces/IFeeSchedule.sol";
import {SidequestConstants} from "../src/sidequest/interfaces/SidequestConstants.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
}

/// @title SidequestVerify
/// @notice The promotion gate (review C8-001): live readbacks that prove a candidate deployment is complete before
///         `PromoteSidequest` records it, and the deploy blocks taken from forge's broadcast receipts.
library SidequestVerify {
    error NotLive(string what);
    error BadBroadcast(string what);

    function _require(bool ok, string memory what) private pure {
        if (!ok) revert NotLive(what);
    }

    /// @notice Every check is against chain state, never against what the script believed it sent.
    function verify(SidequestRecipe.Config memory c, SidequestRecipe.Deployed memory d) internal view {
        _require(block.chainid == c.chainId, "chain");
        SidequestClocks.validate(c.clocks);
        _require(address(d.core).code.length != 0, "core code");
        _require(address(d.factory).code.length != 0, "factory code");
        _require(address(d.fees).code.length != 0, "feeSchedule code");
        _require(address(d.vault).code.length != 0, "vault code");
        _require(address(d.holding).code.length != 0, "holding code");
        _require(address(d.evaluator).code.length != 0, "evaluator code");
        _require(c.safe.code.length != 0, "safe code");

        // A fresh core charges nothing and its admin roles belong to the Safe alone.
        _require(d.core.platformFeeBP() == 0 && d.core.evaluatorFeeBP() == 0, "core fees");
        _require(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.safe), "core admin role: safe");
        _require(d.core.hasRole(d.core.ADMIN_ROLE(), c.safe), "core pause role: safe");
        _require(!d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin), "core admin role: deployer");
        _require(!d.core.hasRole(d.core.ADMIN_ROLE(), c.admin), "core pause role: deployer");

        // Wiring.
        _require(address(d.holding.core()) == address(d.core), "holding.core");
        _require(address(d.holding.vault()) == address(d.vault), "holding.vault");
        _require(address(d.holding.feeSchedule()) == address(d.fees), "holding.feeSchedule");
        _require(address(d.holding.identity()) == address(c.identity), "holding.identity");
        _require(d.holding.evaluator() == address(d.evaluator), "holding.evaluator");
        _require(d.holding.defaultArbitrator() == c.defaultArbitrator, "holding.defaultArbitrator");
        _require(d.holding.margin() == c.margin, "holding.margin");
        _require(d.holding.minimumCreatorBond() == c.minimumCreatorBond, "holding.minimumCreatorBond");
        _require(d.holding.MAX_MINIMUM_CREATOR_BOND() == c.maxMinimumCreatorBond, "holding.maxMinimumCreatorBond");
        _require(d.holding.unfilledForfeitBps() == c.unfilledForfeitBps, "holding.unfilledForfeitBps");
        _require(address(d.evaluator.core()) == address(d.core), "evaluator.core");
        _require(address(d.evaluator.holding()) == address(d.holding), "evaluator.holding");
        _require(address(d.evaluator.reputation()) == address(c.reputation), "evaluator.reputation");
        _require(d.evaluator.verifiers(c.attester), "evaluator verifier");
        _require(address(d.vault.factory()) == address(d.factory), "vault.factory");
        _require(d.vault.bootstrapped() && d.vault.isHolding(address(d.holding)), "vault bootstrap");
        (address pendingHolding,) = d.vault.pendingHolding();
        _require(pendingHolding == address(0), "vault pending holding");

        // D24: promotion must prove the immutable clocks from live reads.
        _require(d.holding.MIN_REVIEW_WINDOW() == c.clocks.minReviewWindow, "holding.MIN_REVIEW_WINDOW");
        _require(d.holding.MIN_DISPUTE_WINDOW() == c.clocks.minDisputeWindow, "holding.MIN_DISPUTE_WINDOW");
        _require(d.holding.MIN_ARBITRATION_WINDOW() == c.clocks.minArbitrationWindow, "holding.MIN_ARBITRATION_WINDOW");
        _require(d.vault.UNSTAKE_DELAY() == c.clocks.unstakeDelay, "vault.UNSTAKE_DELAY");
        _require(d.vault.HOLDING_DELAY() == c.clocks.holdingDelay, "vault.HOLDING_DELAY");
        _require(d.vault.PROPOSAL_GRACE() == c.clocks.proposalGrace, "vault.PROPOSAL_GRACE");
        _require(d.fees.DELAY() == c.clocks.feeDelay, "fees.DELAY");
        _require(d.fees.PROPOSAL_GRACE() == c.clocks.proposalGrace, "fees.PROPOSAL_GRACE");

        // Fee schedule: the configured one, nothing queued.
        IFeeSchedule.Schedule memory s = d.fees.schedule();
        for (uint256 i; i < 4; ++i) {
            _require(s.thresholds[i] == c.thresholds[i] * 1e18 && s.bps[i] == c.bps[i], "fee schedule");
        }
        _require(s.treasury == c.feeTreasury, "fee treasury");
        (, uint48 feeEta) = d.fees.pending();
        _require(feeEta == 0, "fee schedule pending");

        // SIDE: the configured token, unchanged since `check`. It has no mint and no burn, so the live supply is the
        // launch supply; the vault stakes exactly it.
        _require(address(d.factory) == address(c.token), "SIDE token");
        _require(d.factory.decimals() == 18, "SIDE decimals");
        _require(d.factory.totalSupply() == SidequestConstants.SIDE_SUPPLY, "SIDE supply");
        SidequestRecipe.checkLaunchToken(c);
        // Ownership: the Safe owns, or the handover to it is pending (the deployer still owns).
        _owned(address(d.vault), c, "vault owner");
        _owned(address(d.fees), c, "feeSchedule owner");
        _owned(address(d.holding), c, "holding owner");
        _owned(address(d.evaluator), c, "evaluator owner");
    }

    function _owned(address target, SidequestRecipe.Config memory c, string memory what) private view {
        address owner = IOwnable2Step(target).owner();
        address pending = IOwnable2Step(target).pendingOwner();
        _require(owner == c.safe || (owner == c.admin && pending == c.safe), what);
    }

    /// @notice Forge's broadcast log for the deploy: `<broadcast>/DeploySidequest.s.sol/<chainId>/run-latest.json`.
    function runPath(Vm vm, uint256 chainId) internal view returns (string memory) {
        return
            string.concat(BroadcastPath.root(vm), "/DeploySidequest.s.sol/", vm.toString(chainId), "/run-latest.json");
    }

    /// @notice Deploy blocks from the receipts, after checking the log is complete: every transaction has a successful
    ///         receipt and every candidate contract was created by one of them. SIDE is not among them: it exists before
    ///         the run. `sidequestBlock` is the first block of the run; `coreBlock` is the core proxy's block.
    function blocks(Vm vm, string memory path, SidequestRecipe.Deployed memory d)
        internal
        view
        returns (uint256 coreBlock, uint256 sidequestBlock)
    {
        string memory json = vm.readFile(path);
        if (vm.keyExistsJson(json, ".pending[0]")) revert BadBroadcast("pending transactions");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".transactions[", vm.toString(n), "]"))) ++n;
        if (n == 0) revert BadBroadcast("no transactions");

        address[] memory created = new address[](n);
        uint256[] memory blockOf = new uint256[](n);
        sidequestBlock = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            string memory t = string.concat(".transactions[", vm.toString(i), "]");
            bytes32 hash = vm.parseJsonBytes32(json, string.concat(t, ".hash"));
            (bool found, uint256 blockNumber,) = _receipt(vm, json, hash);
            if (!found) revert BadBroadcast("transaction without a successful receipt");
            blockOf[i] = blockNumber;
            if (blockNumber < sidequestBlock) sidequestBlock = blockNumber;
            if (_eq(vm.parseJsonString(json, string.concat(t, ".transactionType")), "CREATE")) {
                created[i] = vm.parseJsonAddress(json, string.concat(t, ".contractAddress"));
            }
        }
        address[4] memory expected = [address(d.fees), address(d.vault), address(d.holding), address(d.evaluator)];
        for (uint256 k; k < expected.length; ++k) {
            if (!_contains(created, expected[k])) revert BadBroadcast("candidate contract not created by this run");
        }
        for (uint256 i; i < n; ++i) {
            if (created[i] == address(d.core)) coreBlock = blockOf[i];
        }
        if (coreBlock == 0) revert BadBroadcast("core proxy not created by this run");
    }

    function _receipt(Vm vm, string memory json, bytes32 hash)
        private
        view
        returns (bool found, uint256 blockNumber, uint256 index)
    {
        for (uint256 j;; ++j) {
            string memory r = string.concat(".receipts[", vm.toString(j), "]");
            if (!vm.keyExistsJson(json, r)) return (false, 0, 0);
            if (vm.parseJsonBytes32(json, string.concat(r, ".transactionHash")) != hash) continue;
            if (vm.parseJsonUint(json, string.concat(r, ".status")) != 1) return (false, 0, 0);
            return (true, vm.parseJsonUint(json, string.concat(r, ".blockNumber")), j);
        }
    }

    function _contains(address[] memory list, address a) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
