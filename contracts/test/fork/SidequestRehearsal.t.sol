// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {SidequestRecipe} from "../../script/SidequestRecipe.sol";
import {SidequestVerify} from "../../script/SidequestVerify.sol";
import {IFactory} from "../../src/sidequest/interfaces/IFactory.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {RecipeDriver} from "../sidequest/Recipe.t.sol";

/// @dev The C8 rehearsal on a local fork of Monad (nothing is sent). The recipe runs step by step from the configured
///      deployer with third-party calls between the steps, the Safe accepts every handover, and one hire runs end to
///      end against the real ERC-8004 registries with a fresh core whose admin roles move to the Safe. The `sidequest` inputs are the rehearsal's own, since the coordinator owns the config
///      values. Skipped unless MONAD_TESTNET_RPC_URL / MONAD_MAINNET_RPC_URL are set (public RPCs work).
contract SidequestRehearsalForkTest is Test {
    address safe = makeAddr("rehearsal-safe");
    address stranger = makeAddr("stranger");
    address arbitrator;
    uint256 arbitratorPk;

    function _fork(string memory rpcVar) internal returns (bool) {
        string memory rpc = vm.envOr(rpcVar, string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function _config(string memory network) internal returns (SidequestRecipe.Config memory c) {
        (arbitrator, arbitratorPk) = makeAddrAndKey("rehearsal-arbiter");
        c = SidequestRecipe.loadBase(vm, network);
        // Testnet uses the configured clock tuple; mainnet keeps production values.
        if (c.chainId == 10143) c.clocks = SidequestRecipe.load(vm, network).clocks;
        vm.etch(safe, hex"00"); // the recipe requires code at the Safe
        c.safe = safe;
        c.defaultArbitrator = arbitrator;
        c.arbitrator = arbitrator; // the fixture's own role, not the shipped config's (LAUNCH-AUDIT-FIX-001/002)
        c.margin = 1 days;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        // SIDE exists before the recipe; a launcher-like token on the fork stands in for it (R7 creates the real one).
        c.token = IFactory(address(new LaunchToken(c.admin)));
    }

    function _deploy(SidequestRecipe.Config memory c) internal returns (SidequestRecipe.Deployed memory d) {
        RecipeDriver driver = new RecipeDriver();
        driver.configure(c);
        for (uint256 i; i < 8; ++i) {
            driver.step(i);
            d = driver.deployed();
            // A third party between every step: staking, early publishing and every one-time setup fail.
            if (address(d.vault) != address(0) && !d.vault.bootstrapped()) {
                vm.prank(stranger);
                vm.expectRevert(IStakeVault.NotBootstrapped.selector);
                d.vault.delegate(address(this), 1);
            }
            if (address(d.vault) != address(0)) {
                vm.prank(stranger);
                vm.expectRevert();
                d.vault.bootstrapHolding(stranger);
            }
            if (address(d.holding) != address(0)) {
                vm.prank(stranger);
                vm.expectRevert();
                d.holding.setEvaluator(stranger);
            }
        }
        vm.startPrank(safe);
        d.vault.acceptOwnership();
        d.fees.acceptOwnership();
        d.holding.acceptOwnership();
        d.evaluator.acceptOwnership();
        vm.stopPrank();
    }

    function _assertDeployed(SidequestRecipe.Config memory c, SidequestRecipe.Deployed memory d) internal view {
        SidequestVerify.verify(c, d);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);
        assertEq(d.factory.totalSupply(), 1_000_000_000e18);
        assertEq(address(d.vault.factory()), address(c.token));
        assertEq(d.core.platformFeeBP(), 0);
        assertEq(d.core.evaluatorFeeBP(), 0);
        assertEq(address(d.holding.identity()), address(c.identity));
        assertEq(address(d.evaluator.reputation()), address(c.reputation));
        assertTrue(d.evaluator.verifiers(c.attester));
        assertTrue(d.vault.isHolding(address(d.holding)));
        assertEq(d.holding.MIN_REVIEW_WINDOW(), c.clocks.minReviewWindow);
        assertEq(d.holding.MIN_DISPUTE_WINDOW(), c.clocks.minDisputeWindow);
        assertEq(d.holding.MIN_ARBITRATION_WINDOW(), c.clocks.minArbitrationWindow);
        assertEq(d.vault.UNSTAKE_DELAY(), c.clocks.unstakeDelay);
        assertEq(d.vault.HOLDING_DELAY(), c.clocks.holdingDelay);
        assertEq(d.fees.DELAY(), c.clocks.feeDelay);
        assertEq(d.fees.PROPOSAL_GRACE(), c.clocks.proposalGrace);
    }

    function _budgetAuth(
        ERC8183WithAuthorization core,
        uint256 pk,
        address signer,
        uint256 jobId,
        address token,
        uint256 amount
    ) internal view returns (ERC8183WithAuthorization.Authorization memory) {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
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
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return ERC8183WithAuthorization.Authorization(signer, 1, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev One hire with a dispute ruled for the worker by a relayed signed ruling, then settle.
    function _hire(SidequestRecipe.Config memory c, SidequestRecipe.Deployed memory d, IERC20 token, uint256 reward)
        internal
    {
        (address creator, uint256 creatorPk) = makeAddrAndKey("rehearsal-creator");
        (address worker, uint256 workerPk) = makeAddrAndKey("rehearsal-worker");
        deal(address(token), creator, reward);
        vm.prank(worker);
        uint256 agentId = c.identity.register();
        assertEq(c.identity.getAgentWallet(agentId), worker);
        vm.prank(c.admin);
        d.factory.transfer(creator, 20_000e18 + c.minimumCreatorBond);
        vm.startPrank(creator);
        d.factory.approve(address(d.vault), 20_000e18 + c.minimumCreatorBond);
        d.vault.delegate(worker, 20_000e18);
        d.vault.delegate(creator, c.minimumCreatorBond);
        vm.stopPrank();
        assertEq(d.vault.positionOf(worker, worker).shares, 0);
        assertEq(d.vault.positionOf(worker, creator).shares, 20_000e18);

        // Leave the complete review/dispute/arbitration tail and core margin inside the deployed bond horizon.
        uint256 deliveryDuration = c.clocks.unstakeDelay
            - (c.clocks.minReviewWindow + c.clocks.minDisputeWindow + c.clocks.minArbitrationWindow + c.margin);
        if (deliveryDuration > 2 days) deliveryDuration = 2 days;
        uint48 deadline = uint48(vm.getBlockTimestamp() + deliveryDuration);
        ISidequestHolding.PublishParams memory p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("rehearsal-manifest"),
            policyHash: keccak256("rehearsal-policy"),
            token: token,
            reward: reward,
            creatorBond: c.minimumCreatorBond,
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + c.clocks.minReviewWindow + c.clocks.minDisputeWindow + c.clocks.minArbitrationWindow
                + c.margin,
            reviewWindow: c.clocks.minReviewWindow,
            disputeWindow: c.clocks.minDisputeWindow,
            arbitrationWindow: c.clocks.minArbitrationWindow
        });
        vm.startPrank(creator);
        token.approve(address(d.holding), reward);
        uint256 jobId = d.holding.publish(p);
        vm.stopPrank();

        ISidequestHolding.Selection memory sel =
            ISidequestHolding.Selection(jobId, worker, agentId, keccak256("rehearsal-policy"), deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, d.holding.selectionDigest(sel));
        (, uint256 fee, uint256 net) = d.holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(d.core, workerPk, worker, jobId, address(token), net);
        vm.prank(worker);
        d.holding.activate(sel, abi.encodePacked(r, s, v), auth);
        assertEq(d.holding.getListing(jobId).feeBps, 1000, "delegated total backing sets the tier");
        assertEq(d.vault.reservedOf(worker), 10e18, "bond uses creator-owned backing");
        vm.prank(worker);
        d.core.submit(jobId, keccak256("rehearsal-work"), "");
        vm.prank(creator);
        d.evaluator.reject(jobId, ISidequestEvaluator.Violation.Quality, keccak256("reason"));
        vm.prank(worker);
        d.evaluator.dispute(jobId);

        ISidequestEvaluator.Ruling memory ruling =
            ISidequestEvaluator.Ruling(jobId, true, false, keccak256("ruling"), vm.getBlockTimestamp() + 1 hours, 1);
        (v, r, s) = vm.sign(arbitratorPk, d.evaluator.rulingDigest(ruling));
        uint256 workerBefore = token.balanceOf(worker);
        vm.prank(stranger);
        d.evaluator.ruleWithSignature{gas: 1_200_000}(ruling, abi.encodePacked(r, s, v));
        d.holding.settle{gas: 1_000_000}(jobId);
        assertEq(uint8(d.core.getJob(jobId).status), uint8(ERC8183.JobStatus.Completed));
        assertEq(token.balanceOf(worker) - workerBefore, net);
        assertEq(token.balanceOf(safe), fee);
        assertEq(d.vault.reservedOf(worker), 0);
        vm.prank(creator);
        d.vault.requestUndelegate(worker, 20_000e18);
        vm.warp(vm.getBlockTimestamp() + d.vault.UNSTAKE_DELAY());
        uint256 creatorBefore = d.factory.balanceOf(creator);
        vm.prank(creator);
        d.vault.withdraw(worker);
        assertEq(d.factory.balanceOf(creator) - creatorBefore, 20_000e18, "delegator retains exit ownership");
    }

    function test_fork_testnet_freshCore_rolesToSafe_oneHire() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        SidequestRecipe.Config memory c = _config("monad-testnet");
        SidequestRecipe.Deployed memory d = _deploy(c);
        _assertDeployed(c, d);
        assertTrue(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), safe));
        assertFalse(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin));
        assertFalse(d.core.hasRole(d.core.ADMIN_ROLE(), c.admin));
        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-testnet"));
        IERC20 mUsd = IERC20(vm.parseJsonAddressArray(json, ".deployment.rewardTokens")[0]);
        _hire(c, d, mUsd, 25e6);
    }

    function test_fork_mainnet_freshCore_rolesToSafe_oneHire() public {
        if (!_fork("MONAD_MAINNET_RPC_URL")) return vm.skip(true);
        SidequestRecipe.Config memory c = _config("monad-mainnet");
        SidequestRecipe.Deployed memory d = _deploy(c);
        _assertDeployed(c, d);
        assertTrue(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), safe));
        assertFalse(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin));
        assertFalse(d.core.hasRole(d.core.ADMIN_ROLE(), c.admin));
        string memory json = vm.readFile(SidequestRecipe.path(vm, "monad-mainnet"));
        IERC20 usdc = IERC20(vm.parseJsonAddressArray(json, ".knownTokens")[0]);
        _hire(c, d, usdc, 5e6);
    }
}
