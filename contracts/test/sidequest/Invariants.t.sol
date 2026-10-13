// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {SidequestHolding} from "../../src/sidequest/SidequestHolding.sol";
import {SidequestEvaluator} from "../../src/sidequest/SidequestEvaluator.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {BlocklistToken} from "../mocks/OddTokens.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Drives random v1 lifecycles over two reward tokens (one of which can blocklist the worker, exercising M2 and
///      the `owed` fallback), top-ups, stake moves and direct core calls. Every action may revert; a reverted action
///      leaves no trace, so the handler keeps no ghost state that a revert could desynchronise.
contract SidequestHandler is Test {
    uint32 internal constant REVIEW = 1 days;
    uint32 internal constant DISPUTE = 1 days;
    uint32 internal constant ARBITRATION = 3 days;
    uint48 internal constant MARGIN = 1 days;
    uint256 internal constant AGENT_ID = 42;

    BaseV1Env internal env;
    uint256[] public jobs;
    bool public bondOutlastedExit;

    constructor(BaseV1Env env_) {
        env = env_;
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return jobs[seed % jobs.length];
    }

    modifier withJobs() {
        if (jobs.length == 0) return;
        _;
    }

    function _token(uint256 seed) internal view returns (IERC20) {
        return seed % 2 == 0 ? IERC20(address(env.pay())) : IERC20(address(env.blk()));
    }

    function _mint(IERC20 token, address to, uint256 amount) internal {
        if (address(token) == address(env.pay())) env.pay().mint(to, amount);
        else env.blk().mint(to, amount);
    }

    function _ensureAvailable(address who, uint256 amount) internal {
        StakeVault vault = env.vault();
        uint256 available = vault.availableOf(who);
        if (available >= amount) return;
        vm.prank(who);
        vault.delegate(who, amount - available);
    }

    // ------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------

    function publish(uint256 tokenSeed, uint96 reward, uint96 creatorBond, uint96 workerBond, uint32 review) external {
        IERC20 token = _token(tokenSeed);
        reward = uint96(bound(reward, 1, 1_000e6));
        creatorBond = uint96(bound(creatorBond, env.holding().minimumCreatorBond(), 100_000e18));
        workerBond = uint96(bound(workerBond, 0, 100e18));
        review = uint32(bound(review, 1 hours, 2 days));
        address creator = env.creator();
        _mint(token, creator, reward);
        _ensureAvailable(creator, creatorBond);
        uint48 dd = uint48(block.timestamp + 7 days);
        ISidequestHolding.PublishParams memory p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256(abi.encode(reward, jobs.length)),
            policyHash: keccak256(abi.encode("policy", jobs.length)),
            token: token,
            reward: reward,
            creatorBond: creatorBond,
            workerBond: workerBond,
            deliveryDeadline: dd,
            expiredAt: dd + review + DISPUTE + ARBITRATION + MARGIN,
            reviewWindow: review,
            disputeWindow: DISPUTE,
            arbitrationWindow: ARBITRATION
        });
        SidequestHolding holding = env.holding();
        vm.prank(creator);
        jobs.push(holding.publish(p));
    }

    function activate(uint256 seed, uint96 extraStake) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestHolding holding = env.holding();
        ISidequestHolding.Listing memory l = holding.getListing(jobId);
        address worker = env.worker();
        // Sometimes move the worker into a cheaper tier first.
        uint256 extra = bound(extraStake, 0, 300_000e18);
        if (extra > 0) {
            StakeVault vault = env.vault();
            vm.prank(worker);
            vault.delegate(worker, extra);
        }
        _ensureAvailable(worker, l.workerBond);
        ISidequestHolding.Selection memory sel = ISidequestHolding.Selection({
            jobId: jobId,
            worker: worker,
            agentId: AGENT_ID,
            termsHash: l.policyHash,
            activateBy: l.deliveryDeadline - 1,
            nonce: jobId
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(env.creatorPk(), holding.selectionDigest(sel));
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            env.budgetAuthFor(jobId, address(l.token), net, uint72(jobId));
        vm.prank(worker);
        holding.activate(sel, abi.encodePacked(r, s, v), auth);
    }

    function topUp(uint256 seed, uint96 amount) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestHolding holding = env.holding();
        IERC20 token = holding.getListing(jobId).token;
        amount = uint96(bound(amount, 1, 100e6));
        address contributor = env.contributor();
        _mint(token, contributor, amount);
        vm.startPrank(contributor);
        token.approve(address(holding), amount);
        holding.topUp(jobId, amount);
        vm.stopPrank();
    }

    function submit(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        ERC8183WithAuthorization core = env.core();
        vm.prank(env.worker());
        core.submit(jobId, keccak256("deliverable"), "");
    }

    function cancel(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestHolding holding = env.holding();
        vm.prank(env.creator());
        holding.cancel(jobId);
    }

    function accept(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        vm.prank(env.creator());
        evaluator.accept(jobId);
    }

    function reject(uint256 seed, uint8 violation) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        vm.prank(env.creator());
        evaluator.reject(jobId, ISidequestEvaluator.Violation(violation % 3), keccak256("reason"));
    }

    function dispute(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        vm.prank(env.worker());
        evaluator.dispute(jobId);
    }

    function rule(uint256 seed, bool forWorker, bool slashLoser) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        vm.prank(env.arbitrator());
        evaluator.rule(jobId, forWorker, slashLoser, keccak256("ruling"));
    }

    /// @dev Walks one submitted job down the dispute path: reject (naming a violation), then dispute, then rule.
    function progress(uint256 seed, uint8 violation, bool forWorker, bool slashLoser) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        ISidequestEvaluator.Case memory c = evaluator.caseOf(jobId);
        if (c.rejectedAt == 0) {
            vm.prank(env.creator());
            evaluator.reject(jobId, ISidequestEvaluator.Violation(violation % 3), keccak256("reason"));
        } else if (c.disputedAt == 0) {
            vm.prank(env.worker());
            evaluator.dispute(jobId);
        } else {
            vm.prank(env.arbitrator());
            evaluator.rule(jobId, forWorker, slashLoser, keccak256("ruling"));
        }
    }

    function timeout(uint256 seed, uint8 which) external withJobs {
        uint256 jobId = _pick(seed);
        SidequestEvaluator evaluator = env.evaluator();
        which %= 4;
        if (which == 0) evaluator.completeAfterSilence(jobId);
        else if (which == 1) evaluator.rejectAfterWindow(jobId);
        else if (which == 2) evaluator.refundAfterArbitrationTimeout(jobId);
        else evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    /// @dev The core's permissionless outage path, straight at the core.
    function claimRefund(uint256 seed) external withJobs {
        env.core().claimRefund(_pick(seed));
    }

    function settle(uint256 seed) external withJobs {
        env.holding().settle(_pick(seed));
    }

    function claimTopUpRefund(uint256 seed) external withJobs {
        env.holding().claimTopUpRefund(_pick(seed), env.contributor());
    }

    function withdrawOwed(uint256 who, uint256 tokenSeed) external {
        address[4] memory payees = [env.creator(), env.worker(), env.contributor(), env.treasury()];
        SidequestHolding holding = env.holding();
        vm.prank(payees[who % 4]);
        holding.withdraw(_token(tokenSeed));
    }

    // ------------------------------------------------------------------------------------------
    // Environment
    // ------------------------------------------------------------------------------------------

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 4 days));
    }

    function toggleWorkerBlocked() external {
        BlocklistToken blk = env.blk();
        blk.setBlocked(env.worker(), !blk.blocked(env.worker()));
    }

    function requestUnstake(uint96 amount, bool creatorSide) external {
        StakeVault vault = env.vault();
        address account = creatorSide ? env.creator() : env.worker();
        vm.prank(account);
        vault.requestUndelegate(account, bound(amount, 1, 1_000_000e18));
        uint48 unlockAt = vault.positionOf(account, account).unlockAt;
        for (uint256 i; i < jobs.length; ++i) {
            ISidequestHolding.Listing memory l = env.holding().getListing(jobs[i]);
            bool open = creatorSide
                ? l.creatorBond != 0 && !l.creatorBondSettled
                : l.workerBond != 0 && l.workerBondReserved && !l.workerBondSettled;
            if (open && l.expiredAt > unlockAt) bondOutlastedExit = true;
        }
    }

    function withdrawStake() external {
        StakeVault vault = env.vault();
        vm.prank(env.worker());
        vault.withdraw(env.worker());
    }
}

/// @dev Exposes the BaseV1 deployment to the handler.
contract BaseV1Env is BaseV1 {
    BlocklistToken public blk;

    function deploy() external {
        setUp();
        blk = new BlocklistToken();
        vm.prank(creator);
        blk.approve(address(holding), type(uint256).max);
    }

    function budgetAuthFor(uint256 jobId, address token, uint256 amount, uint72 nonce)
        external
        view
        returns (ERC8183WithAuthorization.Authorization memory)
    {
        return budgetAuth(workerPk, worker, jobId, token, amount, nonce);
    }
}

/// forge-config: default.invariant.depth = 96
contract SidequestInvariantsTest is Test {
    uint256 constant SUPPLY = 1_000_000_000e18;

    BaseV1Env env;
    SidequestHandler handler;

    function setUp() public {
        env = new BaseV1Env();
        env.deploy();
        handler = new SidequestHandler(env);
        // The handler acts for every role through pranks; give it the env's view of the world.
        targetContract(address(handler));
    }

    function _owedSum(IERC20 token) internal view returns (uint256 sum) {
        address[4] memory payees = [env.creator(), env.worker(), env.contributor(), env.treasury()];
        for (uint256 i; i < 4; ++i) {
            sum += env.holding().owed(token, payees[i]);
        }
    }

    /// @dev What Holding must hold for one job right now, from its own state and the core status.
    function _held(uint256 jobId) internal view returns (IERC20 token, uint256 amount) {
        ISidequestHolding.Listing memory l = env.holding().getListing(jobId);
        token = l.token;
        ERC8183.JobStatus s = env.core().getJob(jobId).status;
        if (!l.rewardSettled) {
            if (!l.funded) return (token, l.reward);
            bool inCore =
                s == ERC8183.JobStatus.Funded || s == ERC8183.JobStatus.Submitted || s == ERC8183.JobStatus.Completed;
            return (token, inCore ? l.fee + l.bonus : l.reward + l.bonus);
        }
        if (l.outcome == ISidequestHolding.Outcome.Refunded) {
            return (token, env.holding().topUpOf(jobId, env.contributor()));
        }
        return (token, 0);
    }

    /// @dev Escrow per token: Holding's balance in each token is exactly what its jobs and its `owed` book say.
    function invariant_escrowPerToken() public view {
        IERC20[2] memory tokens = [IERC20(address(env.pay())), IERC20(address(env.blk()))];
        uint256[2] memory expected = [_owedSum(tokens[0]), _owedSum(tokens[1])];
        uint256[2] memory inCore;
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            uint256 jobId = handler.jobs(i);
            (IERC20 token, uint256 amount) = _held(jobId);
            uint256 k = token == tokens[0] ? 0 : 1;
            expected[k] += amount;
            ERC8183.Job memory job = env.core().getJob(jobId);
            if (job.status == ERC8183.JobStatus.Funded || job.status == ERC8183.JobStatus.Submitted) {
                inCore[k] += job.budget;
            }
        }
        for (uint256 k; k < 2; ++k) {
            assertEq(tokens[k].balanceOf(address(env.holding())), expected[k], "Holding escrow per token");
            assertEq(tokens[k].balanceOf(address(env.core())), inCore[k], "core escrow per token");
        }
    }

    /// @dev Vault conservation, and no reservation outlives its bond.
    function invariant_bondsReservedBeforeExitExpireByUnlock() public view {
        assertFalse(handler.bondOutlastedExit(), "every pre-exit bond expires by unlockAt");
    }

    function invariant_vaultBooks() public view {
        StakeVault vault = env.vault();
        LaunchToken factory = env.factory();
        assertEq(factory.balanceOf(address(vault)), vault.totalAssets(), "vault balance");
        assertLe(vault.totalReserved(), vault.totalAssets(), "totalReserved <= totalStaked");
        assertLe(vault.reservedOf(env.creator()), vault.poolOf(env.creator()).assets, "creator reserved <= staked");
        assertLe(vault.reservedOf(env.worker()), vault.poolOf(env.worker()).assets, "worker reserved <= staked");

        assertEq(
            vault.totalAssets(), vault.poolOf(env.creator()).assets + vault.poolOf(env.worker()).assets, "sum of pools"
        );

        uint256 open;
        uint256 burned;
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            ISidequestHolding.Listing memory l = env.holding().getListing(handler.jobs(i));
            if (!l.creatorBondSettled) open += l.creatorBond;
            if (l.workerBondReserved && !l.workerBondSettled) open += l.workerBond;
            if (l.creatorBondBurned) burned += l.creatorBond;
            if (l.workerBondBurned) burned += l.workerBond;
        }
        assertEq(vault.totalReserved(), open, "reservations equal open bonds");
        assertEq(factory.balanceOf(vault.slashRecipient()), burned, "SIDE leaves only by slashing");
        assertEq(factory.totalSupply(), SUPPLY, "SIDE has no burn");
    }

    /// @dev A bond burns only on a finding the evaluator recorded.
    function invariant_slashOnlyOnAFinding() public view {
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            uint256 jobId = handler.jobs(i);
            ISidequestHolding.Listing memory l = env.holding().getListing(jobId);
            if (l.creatorBondBurned) {
                assertTrue(env.evaluator().creatorPenaltyDue(jobId), "creator burn needs a finding");
            }
            if (l.workerBondBurned) assertTrue(env.evaluator().workerPenaltyDue(jobId), "worker burn needs a finding");
        }
    }
}
