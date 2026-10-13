// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/vendor/erc8004/IERC8004.sol";
import {IFactory} from "../src/sidequest/interfaces/IFactory.sol";
import {FeeSchedule} from "../src/sidequest/FeeSchedule.sol";
import {StakeVault} from "../src/sidequest/StakeVault.sol";
import {SidequestHolding} from "../src/sidequest/SidequestHolding.sol";
import {SidequestEvaluator} from "../src/sidequest/SidequestEvaluator.sol";
import {IFeeSchedule} from "../src/sidequest/interfaces/IFeeSchedule.sol";
import {SidequestConstants} from "../src/sidequest/interfaces/SidequestConstants.sol";
import {SidequestClocks} from "../src/sidequest/SidequestClocks.sol";

/// @dev The one nad.fun token function the mainnet pin reads.
interface INadToken {
    function bondingCurve() external view returns (address);
}

/// @title SidequestRecipe
/// @notice The Sidequest v1 deployment (ADR-0011), from `config/<network>.json` (`sidequest` input block; no address in
///         code). Each `step*` is one broadcast transaction or a few, in the plan's order, so the fork rehearsal can put
///         a third party's calls between them:
///
///         1. core: a fresh proxy with fees 0;
///         2. FeeSchedule → StakeVault (on the configured SIDE) → SidequestHolding → SidequestEvaluator, then
///            `setEvaluator` and the attester as verifier;
///         3. `bootstrapHolding` (staking opens here, after every piece it depends on exists);
///         4. every owner handed to the Safe (`transferOwnership`; the Safe must `acceptOwnership`), and the core has
///            both admin roles moved to the Safe and renounced by the deployer.
///
///         SIDE is not deployed here: it exists before the recipe runs (`sidequest.token`; on mainnet, the nad.fun
///         token) and the recipe only checks it. There is no mining reserve, distributor or vesting wallet.
library SidequestRecipe {
    uint256 internal constant MAINNET = 143;

    struct Config {
        string network;
        uint256 chainId;
        /// @dev The deployer EOA (`roles.admin`): every CREATE and setup call is its.
        address admin;
        address attester;
        /// @dev `roles.arbitrator`, when the config has one: on chain 143 the default arbitrator must be it.
        address arbitrator;
        IERC8004Identity identity;
        IERC8004Reputation reputation;
        address safe;
        address slashRecipient;
        address defaultArbitrator;
        uint48 margin;
        /// @dev Raw SIDE units.
        uint256 minimumCreatorBond;
        uint256 maxMinimumCreatorBond;
        uint16 unfilledForfeitBps;
        /// @dev Fee tiers in whole SIDE (multiplied by 1e18 here) and basis points.
        uint256[4] thresholds;
        uint16[4] bps;
        address feeTreasury;
        /// @dev SIDE, created outside the protocol (on mainnet by the nad.fun launcher). The recipe deploys against it
        ///      and mints nothing.
        IFactory token;
        /// @dev Mainnet only (`nadfun` in the config): the launcher's bonding curve and token implementation, which SIDE
        ///      must be an EIP-1167 clone of (`checkLaunchToken`).
        address launchCurve;
        address launchImplementation;
        SidequestClocks.Config clocks;
    }

    struct Deployed {
        ERC8183WithAuthorization core;
        /// @dev SIDE: the configured token, recorded as `factory` like every deployment record before it.
        IFactory factory;
        FeeSchedule fees;
        StakeVault vault;
        SidequestHolding holding;
        SidequestEvaluator evaluator;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error BadConfig(string what);
    error MainnetNotGo();

    /// @notice Every script calls this before any broadcast or readback (review C10-001): the RPC must be the config's
    ///         chain, so a testnet config on a mainnet RPC cannot skip the guard; and when the script sends
    ///         transactions to chain 143 it needs MAINNET_GO=yes, judged by the connected chain.
    function guardChain(Vm vm, string memory json, bool sends) internal view returns (uint256 chainId) {
        chainId = vm.parseJsonUint(json, ".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        if (
            sends && block.chainid == MAINNET
                && keccak256(bytes(vm.envOr("MAINNET_GO", string("")))) != keccak256("yes")
        ) {
            revert MainnetNotGo();
        }
    }

    /// @notice The mainnet relay, attester and arbitrator keys retired on 1 Oct (LAUNCH-AUDIT-008), the same three as
    ///         `RETIRED_ROLE_ADDRESSES` in `apps/api/src/prod-config.ts` (test/sidequest/Recipe.t.sol checks both match).
    function retiredKeys() internal pure returns (address[3] memory) {
        return [
            0xac7282b6a519665dcb71563317C71d1F357f9e7e,
            0x66b72404Ad8ce4C650C4f67F13AAd1Ee82F2963f,
            0xc657F023F938BB89de590Ed96f79B775c7dDd632
        ];
    }

    function retired(address a) internal pure returns (bool) {
        address[3] memory keys = retiredKeys();
        return a == keys[0] || a == keys[1] || a == keys[2];
    }

    function path(Vm vm, string memory network) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/", network, ".json");
    }

    /// @notice The network fields every recipe shares (roles and registries), without the `sidequest`
    ///         block: the fork rehearsals fill that in themselves.
    function loadBase(Vm vm, string memory network) internal view returns (Config memory c) {
        string memory json = vm.readFile(path(vm, network));
        c.network = vm.parseJsonString(json, ".network");
        c.chainId = vm.parseJsonUint(json, ".chainId");
        c.admin = vm.parseJsonAddress(json, ".roles.admin");
        c.attester = vm.parseJsonAddress(json, ".roles.attester");
        if (vm.keyExistsJson(json, ".roles.arbitrator")) c.arbitrator = vm.parseJsonAddress(json, ".roles.arbitrator");
        c.identity = IERC8004Identity(vm.parseJsonAddress(json, ".erc8004.identity"));
        c.reputation = IERC8004Reputation(vm.parseJsonAddress(json, ".erc8004.reputation"));
        c.clocks = SidequestClocks.production();
        c.minimumCreatorBond = vm.parseJsonUint(json, ".sidequest.minimumCreatorBond");
        c.maxMinimumCreatorBond = vm.parseJsonUint(json, ".sidequest.maxMinimumCreatorBond");
        c.unfilledForfeitBps = SafeCast.toUint16(vm.parseJsonUint(json, ".sidequest.unfilledForfeitBps"));
        if (vm.keyExistsJson(json, ".nadfun")) {
            c.launchCurve = vm.parseJsonAddress(json, ".nadfun.curve");
            c.launchImplementation = vm.parseJsonAddress(json, ".nadfun.tokenImplementation");
        }
    }

    /// @notice The full input: `loadBase` plus the `sidequest` block (schema in `contracts/SURFACE.md`).
    function load(Vm vm, string memory network) internal view returns (Config memory c) {
        c = loadBase(vm, network);
        string memory json = vm.readFile(path(vm, network));
        c.safe = vm.parseJsonAddress(json, ".sidequest.safe");
        c.slashRecipient = vm.parseJsonAddress(json, ".sidequest.slashRecipient");
        c.defaultArbitrator = vm.parseJsonAddress(json, ".sidequest.defaultArbitrator");
        // Narrowing casts revert instead of wrapping (C9 MATH-6): a typo like 66536 bps must not load as 1000.
        c.margin = SafeCast.toUint48(vm.parseJsonUint(json, ".sidequest.margin"));
        c.minimumCreatorBond = vm.parseJsonUint(json, ".sidequest.minimumCreatorBond");
        c.maxMinimumCreatorBond = vm.parseJsonUint(json, ".sidequest.maxMinimumCreatorBond");
        c.unfilledForfeitBps = SafeCast.toUint16(vm.parseJsonUint(json, ".sidequest.unfilledForfeitBps"));
        uint256[] memory thresholds = vm.parseJsonUintArray(json, ".sidequest.schedule.thresholds");
        uint256[] memory bps = vm.parseJsonUintArray(json, ".sidequest.schedule.bps");
        if (thresholds.length != 4 || bps.length != 4) revert BadConfig("schedule needs 4 tiers");
        for (uint256 i; i < 4; ++i) {
            c.thresholds[i] = thresholds[i];
            c.bps[i] = SafeCast.toUint16(bps[i]);
        }
        c.feeTreasury = vm.parseJsonAddress(json, ".sidequest.schedule.treasury");
        c.token = IFactory(vm.parseJsonAddress(json, ".sidequest.token"));
        c.clocks = loadClocks(vm, json, ".sidequest.clocks");
    }

    /// @notice Defaults only for a completely absent block; a partial block refuses.
    function loadClocks(Vm vm, string memory json, string memory p)
        internal
        view
        returns (SidequestClocks.Config memory clocks)
    {
        clocks = SidequestClocks.production();
        if (vm.keyExistsJson(json, p)) {
            clocks.minReviewWindow = SafeCast.toUint32(vm.parseJsonUint(json, string.concat(p, ".minReviewWindow")));
            clocks.minDisputeWindow = SafeCast.toUint32(vm.parseJsonUint(json, string.concat(p, ".minDisputeWindow")));
            clocks.minArbitrationWindow =
                SafeCast.toUint32(vm.parseJsonUint(json, string.concat(p, ".minArbitrationWindow")));
            clocks.unstakeDelay = SafeCast.toUint48(vm.parseJsonUint(json, string.concat(p, ".unstakeDelay")));
            clocks.holdingDelay = SafeCast.toUint48(vm.parseJsonUint(json, string.concat(p, ".holdingDelay")));
            clocks.feeDelay = SafeCast.toUint48(vm.parseJsonUint(json, string.concat(p, ".feeDelay")));
            clocks.proposalGrace = SafeCast.toUint48(vm.parseJsonUint(json, string.concat(p, ".proposalGrace")));
        }
    }

    function check(Config memory c) internal view {
        if (block.chainid != c.chainId) revert WrongChain(c.chainId, block.chainid);
        SidequestClocks.validate(c.clocks);
        if (c.minimumCreatorBond == 0 || c.maxMinimumCreatorBond < c.minimumCreatorBond || c.unfilledForfeitBps > 5000)
        {
            revert BadConfig("invalid creator bond policy");
        }
        if (
            c.safe == address(0) || c.slashRecipient == address(0) || c.defaultArbitrator == address(0)
                || c.feeTreasury == address(0) || c.attester == address(0)
        ) revert BadConfig("zero address");
        // SIDE exists before the deploy and is exactly the launcher's token: code, 18 decimals and the fixed 1e9
        // supply (nad.fun V2 tokens have no mint and no burn, so live totalSupply cannot drift).
        if (address(c.token).code.length == 0) revert BadConfig("SIDE has no code");
        if (c.token.decimals() != 18) revert BadConfig("SIDE decimals");
        if (c.token.totalSupply() != SidequestConstants.SIDE_SUPPLY) revert BadConfig("SIDE supply");
        if (
            keccak256(bytes(c.token.name())) != keccak256("Sidequest")
                || keccak256(bytes(c.token.symbol())) != keccak256("SIDE")
        ) revert BadConfig("SIDE name or symbol");
        if (address(c.identity).code.length == 0 || address(c.reputation).code.length == 0) {
            revert BadConfig("ERC-8004 registries missing");
        }
        if (c.defaultArbitrator == c.admin) revert BadConfig("arbitrator must not be the deployer");
        // LAUNCH-AUDIT-FIX-001: the Holding's default arbitrator rules every offer that names none. On mainnet it is
        // the configured fresh arbiter, never a key retired on 1 Oct, whatever the API preflight was given.
        if (c.chainId == MAINNET) {
            if (c.feeTreasury != c.safe) revert BadConfig("mainnet fee treasury must be the Safe");
            if (c.slashRecipient != c.safe) revert BadConfig("mainnet slash recipient must be the Safe");
            if (retired(c.defaultArbitrator)) revert BadConfig("defaultArbitrator is a retired 1 Oct key");
            if (c.defaultArbitrator != c.arbitrator) revert BadConfig("defaultArbitrator is not roles.arbitrator");
            // The exposed attester would become an Evaluator verifier if `roles.attester` were never replaced.
            if (retired(c.attester)) revert BadConfig("attester is a retired 1 Oct key");
        }
        // A fresh core's admin roles move to the Safe in one irreversible step (C9 ACL-6): it must exist here.
        if (c.safe.code.length == 0) revert BadConfig("safe has no code");
        // Thresholds are whole SIDE; a value entered in wei would put every cheaper tier out of reach (C9 MATH-6).
        for (uint256 i; i < 4; ++i) {
            if (c.thresholds[i] * 1e18 > SidequestConstants.SIDE_SUPPLY) revert BadConfig("threshold above supply");
        }
        // A bonded listing must expire within the vault's unstake delay (BondOutlastsUnbonding), and its expiry is at
        // least deliveryDeadline + review + dispute + arbitration + margin. Clocks whose shortest windows and margin
        // leave under an hour of delivery inside that delay would make every bonded hire impossible.
        if (
            uint256(c.clocks.minReviewWindow) + c.clocks.minDisputeWindow + c.clocks.minArbitrationWindow + c.margin
                    + 1 hours > c.clocks.unstakeDelay
        ) revert BadConfig("clocks leave no bonded hire inside the unstake delay");
    }

    /// @notice On mainnet SIDE is the nad.fun launch token: an EIP-1167 clone of the launcher's token implementation, on
    ///         its bonding curve. A same-ticker look-alike (nad.fun does not enforce unique tickers) refuses, which matters
    ///         because the vault's token is immutable. DeploySidequest and the promotion check it; off mainnet it passes.
    function checkLaunchToken(Config memory c) internal view {
        if (c.chainId != MAINNET) return;
        if (c.launchCurve == address(0) || c.launchImplementation == address(0)) {
            revert BadConfig("nad.fun pin missing");
        }
        bytes memory clone =
            abi.encodePacked(hex"363d3d373d3d3d363d73", c.launchImplementation, hex"5af43d82803e903d91602b57fd5bf3");
        if (keccak256(address(c.token).code) != keccak256(clone)) revert BadConfig("SIDE is not a nad.fun token");
        if (INadToken(address(c.token)).bondingCurve() != c.launchCurve) {
            revert BadConfig("SIDE is not on the nad.fun curve");
        }
    }

    /// @dev Every step, in order, from the caller's context (under `vm.startBroadcast(admin)`).
    function deploy(Config memory c) internal returns (Deployed memory d) {
        check(c);
        stepCore(c, d);
        stepFeeSchedule(c, d);
        stepVault(c, d);
        stepHolding(c, d);
        stepEvaluator(c, d);
        stepWire(c, d);
        stepBootstrap(d);
        stepHandover(c, d);
    }

    function stepCore(Config memory c, Deployed memory d) internal {
        d.factory = c.token;
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        // Initialised inside the proxy's CREATE: no initializer gap to front-run.
        d.core = ERC8183WithAuthorization(
            address(
                new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183WithAuthorization.initialize, (c.admin, c.admin)))
            )
        );
        d.core.setPlatformFee(0, c.safe);
        d.core.setEvaluatorFee(0);
    }

    function stepFeeSchedule(Config memory c, Deployed memory d) internal {
        IFeeSchedule.Schedule memory s;
        for (uint256 i; i < 4; ++i) {
            s.thresholds[i] = c.thresholds[i] * 1e18;
            s.bps[i] = c.bps[i];
        }
        s.treasury = c.feeTreasury;
        d.fees = new FeeSchedule(s, c.clocks);
    }

    function stepVault(Config memory c, Deployed memory d) internal {
        d.vault = new StakeVault(c.token, c.slashRecipient, c.clocks);
    }

    function stepHolding(Config memory c, Deployed memory d) internal {
        d.holding = new SidequestHolding(
            d.core,
            d.vault,
            d.fees,
            c.identity,
            c.defaultArbitrator,
            c.margin,
            c.minimumCreatorBond,
            c.maxMinimumCreatorBond,
            c.unfilledForfeitBps,
            c.clocks
        );
    }

    function stepEvaluator(Config memory c, Deployed memory d) internal {
        d.evaluator = new SidequestEvaluator(d.core, d.holding, c.reputation);
    }

    /// @dev Before this, `publish` reverts `EvaluatorNotSet`.
    function stepWire(Config memory c, Deployed memory d) internal {
        d.holding.setEvaluator(address(d.evaluator));
        d.evaluator.setVerifier(c.attester, true);
    }

    function stepBootstrap(Deployed memory d) internal {
        d.vault.bootstrapHolding(address(d.holding));
    }

    /// @dev Starts every handover; ownership is complete only once the Safe calls `acceptOwnership` on each. On a fresh
    ///      core the Safe gets both admin roles and the deployer renounces its own, so it keeps no upgrade, pause or
    ///      emergency-withdraw power.
    function stepHandover(Config memory c, Deployed memory d) internal {
        d.vault.transferOwnership(c.safe);
        d.fees.transferOwnership(c.safe);
        d.holding.transferOwnership(c.safe);
        d.evaluator.transferOwnership(c.safe);
        d.core.grantRole(d.core.DEFAULT_ADMIN_ROLE(), c.safe);
        d.core.grantRole(d.core.ADMIN_ROLE(), c.safe);
        d.core.renounceRole(d.core.ADMIN_ROLE(), c.admin);
        d.core.renounceRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin);
    }
}
