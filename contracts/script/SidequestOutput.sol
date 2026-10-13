// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SidequestClocks} from "../src/sidequest/SidequestClocks.sol";
import {SidequestRecipe} from "./SidequestRecipe.sol";
import {BroadcastPath} from "./BroadcastPath.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IFactory} from "../src/sidequest/interfaces/IFactory.sol";
import {FeeSchedule} from "../src/sidequest/FeeSchedule.sol";
import {StakeVault} from "../src/sidequest/StakeVault.sol";
import {SidequestHolding} from "../src/sidequest/SidequestHolding.sol";
import {SidequestEvaluator} from "../src/sidequest/SidequestEvaluator.sol";

/// @title SidequestOutput
/// @notice Rewrites `.deployment` in a network config after the Sidequest v1 deploy has been verified on-chain
///         (`PromoteSidequest`), in the shape of decisions D1:
///         `factory` records SIDE (the launcher's token); `sidequest` lists the owner Safe (D5) and the protocol contracts; `main` is the v1 pair
///         (`kind: "sidequest-v1"`). A fresh core is recorded from its creation receipt. An unknown deployment key,
///         or a config that already records a v1 deployment, refuses. On mainnet
///         (LAUNCH-AUDIT-004) `rewardTokens` is kept or, when absent, taken from `knownTokens` (USDC and SIDE), and must
///         contain `x402.usdc` and `sidequest.token`: the SDK and Explore read their reward tokens from it, and
///         Sidequest's own tasks pay in SIDE.
library SidequestOutput {
    error UnknownKey(string where, string key);
    error AlreadyDeployed();
    error ClockMismatch();
    error SlashRecipientMismatch();
    /// @dev Mainnet: no `rewardTokens` and no `knownTokens`, or a reward list without `x402.usdc` or `sidequest.token`.
    error MainnetRewardTokens();

    uint256 private constant MAINNET = 143;

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _has(string[] memory keys, string memory key) private pure returns (bool) {
        for (uint256 i; i < keys.length; ++i) {
            if (_eq(keys[i], key)) return true;
        }
        return false;
    }

    function _keys(Vm vm, string memory json, string memory at) private view returns (string[] memory) {
        if (!vm.keyExistsJson(json, at)) return new string[](0);
        return vm.parseJsonKeys(json, at);
    }

    /// @notice Refuses a config this writer could not rewrite faithfully, before anything is broadcast.
    function preflight(Vm vm, string memory json) internal view {
        if (vm.keyExistsJson(json, ".deployment.sidequest")) revert AlreadyDeployed();
        string[] memory keys = _keys(vm, json, ".deployment");
        string[5] memory known = ["block", "core", "network", "factory", "rewardTokens"];
        for (uint256 i; i < keys.length; ++i) {
            string memory k = keys[i];
            bool ok;
            for (uint256 j; j < known.length; ++j) {
                if (_eq(k, known[j])) ok = true;
            }
            if (!ok) revert UnknownKey("deployment", k);
        }
        if (_mainnet(vm, json)) rewardTokens(vm, json);
    }

    /// @notice The reward tokens the record will carry: `.deployment.rewardTokens` if present, else on mainnet the
    ///         `knownTokens` list (USDC, and SIDE for Sidequest's own spending). On mainnet the list must contain `x402.usdc`
    ///         and `sidequest.token`.
    function rewardTokens(Vm vm, string memory json) internal view returns (address[] memory tokens) {
        bool mainnet = _mainnet(vm, json);
        if (vm.keyExistsJson(json, ".deployment.rewardTokens")) {
            tokens = vm.parseJsonAddressArray(json, ".deployment.rewardTokens");
        } else if (mainnet) {
            tokens = vm.parseJsonAddressArray(json, ".knownTokens");
            if (tokens.length == 0) revert MainnetRewardTokens();
        }
        if (!mainnet) return tokens;
        address usdc = vm.parseJsonAddress(json, ".x402.usdc");
        address side = vm.parseJsonAddress(json, ".sidequest.token");
        bool hasUsdc;
        bool hasSide;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == usdc) hasUsdc = true;
            if (tokens[i] == side) hasSide = true;
        }
        if (!hasUsdc || !hasSide) revert MainnetRewardTokens();
    }

    function _mainnet(Vm vm, string memory json) private view returns (bool) {
        return vm.keyExistsJson(json, ".chainId") && vm.parseJsonUint(json, ".chainId") == MAINNET;
    }

    /// @notice Writes the D1/D5 record. `coreBlock` is the fresh core's deploy block and
    ///         `sidequestBlock` the first block of the v1 deploy; `PromoteSidequest` takes both from the receipts.
    function write(
        Vm vm,
        string memory path,
        SidequestRecipe.Deployed memory d,
        address safe,
        uint256 coreBlock,
        uint256 sidequestBlock
    ) internal {
        string memory json = vm.readFile(path);
        preflight(vm, json);
        address recipient = d.vault.slashRecipient();
        if (recipient != vm.parseJsonAddress(json, ".sidequest.slashRecipient")) revert SlashRecipientMismatch();
        SidequestClocks.Config memory clocks = readClocks(d);
        SidequestClocks.Config memory input = SidequestRecipe.loadClocks(vm, json, ".sidequest.clocks");
        if (keccak256(abi.encode(clocks)) != keccak256(abi.encode(input))) revert ClockMismatch();
        if (_mainnet(vm, json) && keccak256(abi.encode(clocks)) != keccak256(abi.encode(SidequestClocks.production())))
        {
            revert ClockMismatch();
        }
        string memory o = "deployment";
        string[] memory keys = _keys(vm, json, ".deployment");

        vm.serializeAddress(o, "core", address(d.core));
        vm.serializeUint(o, "block", coreBlock);
        address[] memory rewards = rewardTokens(vm, json);
        if (_has(keys, "rewardTokens") || rewards.length > 0) vm.serializeAddress(o, "rewardTokens", rewards);
        vm.serializeAddress(o, "factory", address(d.factory));

        string memory h = "deployment.sidequest";
        vm.serializeUint(h, "block", sidequestBlock);
        vm.serializeAddress(h, "safe", safe);
        vm.serializeAddress(h, "factory", address(d.factory));
        vm.serializeAddress(h, "vault", address(d.vault));
        vm.serializeAddress(h, "slashRecipient", recipient);
        vm.serializeAddress(h, "feeSchedule", address(d.fees));
        string memory clockKey = "deployment.sidequest.clocks";
        vm.serializeUint(clockKey, "minReviewWindow", clocks.minReviewWindow);
        vm.serializeUint(clockKey, "minDisputeWindow", clocks.minDisputeWindow);
        vm.serializeUint(clockKey, "minArbitrationWindow", clocks.minArbitrationWindow);
        vm.serializeUint(clockKey, "unstakeDelay", clocks.unstakeDelay);
        vm.serializeUint(clockKey, "holdingDelay", clocks.holdingDelay);
        vm.serializeUint(clockKey, "feeDelay", clocks.feeDelay);
        vm.serializeString(
            o,
            "sidequest",
            vm.serializeString(h, "clocks", vm.serializeUint(clockKey, "proposalGrace", clocks.proposalGrace))
        );

        string memory m = "deployment.main";
        vm.serializeString(m, "kind", "sidequest-v1");
        vm.serializeAddress(m, "factory", address(d.factory));
        vm.serializeAddress(m, "holding", address(d.holding));
        vm.serializeAddress(m, "evaluator", address(d.evaluator));
        vm.serializeString(o, "main", vm.serializeBool(m, "openTokens", true));

        string memory result = vm.serializeString(o, "network", vm.parseJsonString(json, ".network"));
        vm.writeJson(result, path, ".deployment");
    }

    /// @notice The promoted clock tuple is derived from live getters, including duplicated clocks on both targets.
    function readClocks(SidequestRecipe.Deployed memory d) internal view returns (SidequestClocks.Config memory c) {
        c.minReviewWindow = d.holding.MIN_REVIEW_WINDOW();
        c.minDisputeWindow = d.holding.MIN_DISPUTE_WINDOW();
        c.minArbitrationWindow = d.holding.MIN_ARBITRATION_WINDOW();
        c.unstakeDelay = d.vault.UNSTAKE_DELAY();
        c.holdingDelay = d.vault.HOLDING_DELAY();
        c.feeDelay = d.fees.DELAY();
        c.proposalGrace = d.vault.PROPOSAL_GRACE();
        if (d.fees.PROPOSAL_GRACE() != c.proposalGrace) revert ClockMismatch();
        SidequestClocks.validate(c);
    }

    /// @notice True when the config already records exactly this deployment (promotion ran before); reverts
    ///         `AlreadyDeployed` when it records a different one.
    function isPromoted(Vm vm, string memory json, SidequestRecipe.Deployed memory d, address safe)
        internal
        view
        returns (bool)
    {
        if (!vm.keyExistsJson(json, ".deployment.sidequest")) return false;
        string memory h = ".deployment.sidequest.";
        bool same = vm.parseJsonAddress(json, string.concat(h, "safe")) == safe
            && vm.parseJsonAddress(json, string.concat(h, "factory")) == address(d.factory)
            && vm.parseJsonAddress(json, string.concat(h, "vault")) == address(d.vault)
            && vm.parseJsonAddress(json, string.concat(h, "feeSchedule")) == address(d.fees)
            && vm.parseJsonAddress(json, ".deployment.main.holding") == address(d.holding)
            && vm.parseJsonAddress(json, ".deployment.main.evaluator") == address(d.evaluator)
            && vm.parseJsonAddress(json, ".deployment.core") == address(d.core);
        if (!same || !vm.keyExistsJson(json, ".deployment.sidequest.clocks")) revert AlreadyDeployed();
        if (
            !vm.keyExistsJson(json, ".deployment.sidequest.slashRecipient")
                || d.vault.slashRecipient() != vm.parseJsonAddress(json, ".deployment.sidequest.slashRecipient")
                || d.vault.slashRecipient() != vm.parseJsonAddress(json, ".sidequest.slashRecipient")
        ) revert AlreadyDeployed();
        if (
            d.holding.minimumCreatorBond() != vm.parseJsonUint(json, ".sidequest.minimumCreatorBond")
                || d.holding.MAX_MINIMUM_CREATOR_BOND() != vm.parseJsonUint(json, ".sidequest.maxMinimumCreatorBond")
                || d.holding.unfilledForfeitBps() != vm.parseJsonUint(json, ".sidequest.unfilledForfeitBps")
        ) revert AlreadyDeployed();
        SidequestClocks.Config memory recorded = SidequestRecipe.loadClocks(vm, json, ".deployment.sidequest.clocks");
        bytes32 clockHash = keccak256(abi.encode(recorded));
        if (
            clockHash != keccak256(abi.encode(readClocks(d)))
                || clockHash != keccak256(abi.encode(SidequestRecipe.loadClocks(vm, json, ".sidequest.clocks")))
                || (_mainnet(vm, json) && clockHash != keccak256(abi.encode(SidequestClocks.production())))
        ) revert AlreadyDeployed();
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // The candidate record (review C8-001): what the deploy script believes it sent. Never authoritative;
    // `PromoteSidequest` verifies it on-chain before anything reaches `config/<network>.json`.
    // ---------------------------------------------------------------------------------------------

    function candidateDir(Vm vm) internal view returns (string memory) {
        return string.concat(BroadcastPath.root(vm), "/sidequest");
    }

    function candidatePath(Vm vm, string memory network) internal view returns (string memory) {
        return string.concat(candidateDir(vm), "/", network, ".candidate.json");
    }

    function writeCandidate(Vm vm, string memory path, uint256 chainId, SidequestRecipe.Deployed memory d, address safe)
        internal
    {
        // broadcast/ is gitignored, so the directory may not exist yet.
        vm.createDir(candidateDir(vm), true);
        string memory k = "candidate";
        vm.serializeUint(k, "chainId", chainId);
        vm.serializeAddress(k, "safe", safe);
        vm.serializeAddress(k, "core", address(d.core));
        vm.serializeAddress(k, "factory", address(d.factory));
        vm.serializeAddress(k, "feeSchedule", address(d.fees));
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "slashRecipient", d.vault.slashRecipient());
        vm.serializeAddress(k, "holding", address(d.holding));
        vm.writeJson(vm.serializeAddress(k, "evaluator", address(d.evaluator)), path);
    }

    function readCandidate(Vm vm, string memory path)
        internal
        view
        returns (SidequestRecipe.Deployed memory d, address safe, uint256 chainId)
    {
        string memory json = vm.readFile(path);
        chainId = vm.parseJsonUint(json, ".chainId");
        safe = vm.parseJsonAddress(json, ".safe");
        d.core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".core"));
        d.factory = IFactory(vm.parseJsonAddress(json, ".factory"));
        d.fees = FeeSchedule(vm.parseJsonAddress(json, ".feeSchedule"));
        d.vault = StakeVault(vm.parseJsonAddress(json, ".vault"));
        if (d.vault.slashRecipient() != vm.parseJsonAddress(json, ".slashRecipient")) revert SlashRecipientMismatch();
        d.holding = SidequestHolding(vm.parseJsonAddress(json, ".holding"));
        d.evaluator = SidequestEvaluator(vm.parseJsonAddress(json, ".evaluator"));
    }
}
