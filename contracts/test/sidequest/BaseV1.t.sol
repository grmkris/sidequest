// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {LaunchToken} from "../mocks/LaunchToken.sol";
import {SidequestConstants} from "../../src/sidequest/interfaces/SidequestConstants.sol";
import {StakeVault} from "../../src/sidequest/StakeVault.sol";
import {FeeSchedule} from "../../src/sidequest/FeeSchedule.sol";
import {SidequestHolding} from "../../src/sidequest/SidequestHolding.sol";
import {SidequestEvaluator} from "../../src/sidequest/SidequestEvaluator.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "../../src/sidequest/interfaces/ISidequestEvaluator.sol";
import {IFeeSchedule} from "../../src/sidequest/interfaces/IFeeSchedule.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MockReputation} from "../mocks/MockReputation.sol";

/// @dev The whole Sidequest v1 system as the recipe deploys it: our core proxy (fees 0, no hooks), SIDE v2, the
///      vault bootstrapped with the Holding, the default fee schedule, the evaluator with the attester as verifier.
///      Creator and worker stake SIDE; bonds are reservations. Helpers walk a job through the lifecycle.
abstract contract BaseV1 is Test {
    uint32 internal constant REVIEW = 1 days;
    uint32 internal constant DISPUTE = 1 days;
    uint32 internal constant ARBITRATION = 3 days;
    uint48 internal constant MARGIN = 1 days;
    uint256 internal constant REWARD = 100e6;
    uint256 internal constant CREATOR_BOND = 10_000e18;
    uint256 internal constant WORKER_BOND = 10e18;
    /// @dev Default stakes: the creator covers its bonds; the worker sits in the 30 % tier.
    uint256 internal constant CREATOR_STAKE = 100_000e18;
    uint256 internal constant WORKER_STAKE = 1_000e18;
    uint256 internal constant AGENT_ID = 42;
    bytes32 internal constant MANIFEST = keccak256("manifest-v1");
    bytes32 internal constant POLICY = keccak256("policy-v1");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REASON = keccak256("reason");
    uint256 internal policyNonce;

    address public deployer = makeAddr("deployer");
    address public safe = makeAddr("safe");
    address public treasury = makeAddr("treasury");
    address public stranger = makeAddr("stranger");
    address public relayer = makeAddr("relayer");
    address public contributor = makeAddr("contributor");
    address public arbitrator;
    uint256 public arbitratorPk;
    address public creator;
    uint256 public creatorPk;
    address public worker;
    uint256 public workerPk;
    address public attester;
    uint256 public attesterPk;

    LaunchToken public factory;
    MockPaymentToken public pay;
    ERC8183WithAuthorization public core;
    StakeVault public vault;
    FeeSchedule public fees;
    SidequestHolding public holding;
    SidequestEvaluator public evaluator;
    MockReputation public reputation;
    MockIdentity public identity;

    /// @dev Override to deploy without an ERC-8004 reputation registry (feedback off).
    function withReputation() internal pure virtual returns (bool) {
        return true;
    }

    function defaultSchedule(address treasury_) internal pure returns (IFeeSchedule.Schedule memory s) {
        s.thresholds = [uint256(0), 10_000e18, 100_000e18, 1_000_000e18];
        s.bps = [uint16(3000), 1000, 300, 100];
        s.treasury = treasury_;
    }

    /// @dev SIDE outside the slash sink: SIDE has no `burn`, so a slash moves it to the sink and this drops instead of
    ///      the total supply.
    function circulating() internal view returns (uint256) {
        return factory.totalSupply() - factory.balanceOf(SidequestConstants.SLASH_SINK);
    }

    function clocks() internal pure virtual returns (SidequestClocks.Config memory) {
        return SidequestClocks.production();
    }

    function setUp() public virtual {
        (creator, creatorPk) = makeAddrAndKey("creator");
        (worker, workerPk) = makeAddrAndKey("worker");
        (arbitrator, arbitratorPk) = makeAddrAndKey("arbitrator");
        (attester, attesterPk) = makeAddrAndKey("attester");

        vm.startPrank(deployer);
        factory = new LaunchToken(deployer);
        pay = new MockPaymentToken("Mock USD (testnet)", "mUSD");
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        bytes memory init = abi.encodeCall(ERC8183WithAuthorization.initialize, (deployer, deployer));
        core = ERC8183WithAuthorization(address(new ERC1967Proxy(address(impl), init)));
        core.setPlatformFee(0, deployer);
        core.setEvaluatorFee(0);
        identity = new MockIdentity();
        reputation = new MockReputation();
        vault = new StakeVault(factory, clocks());
        fees = new FeeSchedule(defaultSchedule(treasury), clocks());
        holding = new SidequestHolding(
            core,
            vault,
            fees,
            IERC8004Identity(address(identity)),
            arbitrator,
            MARGIN,
            CREATOR_BOND,
            100_000e18,
            2500,
            clocks()
        );
        evaluator = new SidequestEvaluator(
            core, holding, IERC8004Reputation(withReputation() ? address(reputation) : address(0))
        );
        holding.setEvaluator(address(evaluator));
        evaluator.setVerifier(attester, true);
        vault.bootstrapHolding(address(holding));
        factory.transfer(creator, 10_000_000e18);
        factory.transfer(worker, 10_000_000e18);
        factory.transfer(contributor, 10_000_000e18);
        vm.stopPrank();

        pay.mint(creator, 10 * REWARD);
        pay.mint(contributor, 10 * REWARD);
        vm.startPrank(creator);
        pay.approve(address(holding), type(uint256).max);
        factory.approve(address(vault), type(uint256).max);
        vault.delegate(creator, CREATOR_STAKE);
        vm.stopPrank();
        vm.startPrank(worker);
        factory.approve(address(vault), type(uint256).max);
        vault.delegate(worker, WORKER_STAKE);
        vm.stopPrank();
        vm.prank(contributor);
        pay.approve(address(holding), type(uint256).max);
        identity.setAgentWallet(AGENT_ID, worker);

        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------------------------------------
    // Publish
    // ------------------------------------------------------------------------------------------

    function deliveryDeadline() internal view returns (uint48) {
        return uint48(vm.getBlockTimestamp() + 7 days);
    }

    function params(IERC20 token, uint256 reward, uint256 creatorBond, uint256 workerBond)
        internal
        returns (ISidequestHolding.PublishParams memory p)
    {
        uint48 deadline = deliveryDeadline();
        p = ISidequestHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: MANIFEST,
            policyHash: keccak256(abi.encode(POLICY, ++policyNonce)),
            token: token,
            reward: reward,
            creatorBond: creatorBond,
            workerBond: workerBond,
            deliveryDeadline: deadline,
            expiredAt: deadline + REVIEW + DISPUTE + ARBITRATION + MARGIN,
            reviewWindow: REVIEW,
            disputeWindow: DISPUTE,
            arbitrationWindow: ARBITRATION
        });
    }

    function params() internal returns (ISidequestHolding.PublishParams memory) {
        return params(IERC20(address(pay)), REWARD, CREATOR_BOND, WORKER_BOND);
    }

    function publishWith(ISidequestHolding.PublishParams memory p) internal returns (uint256 jobId) {
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    function publish() internal returns (uint256) {
        return publishWith(params());
    }

    // ------------------------------------------------------------------------------------------
    // Activate (the creator's signed Selection, the worker's own transaction for `net`)
    // ------------------------------------------------------------------------------------------

    function selectionFor(uint256 jobId, address who, uint256 agentId)
        internal
        view
        returns (ISidequestHolding.Selection memory)
    {
        ISidequestHolding.Listing memory l = holding.getListing(jobId);
        return ISidequestHolding.Selection({
            jobId: jobId,
            worker: who,
            agentId: agentId,
            termsHash: l.policyHash,
            activateBy: l.deliveryDeadline - 1,
            nonce: jobId
        });
    }

    function signSelection(uint256 pk, ISidequestHolding.Selection memory sel) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, holding.selectionDigest(sel));
        return abi.encodePacked(r, s, v);
    }

    function budgetAuth(uint256 pk, address signer, uint256 jobId, address token, uint256 amount, uint72 nonce)
        internal
        view
        returns (ERC8183WithAuthorization.Authorization memory)
    {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = signCore(
            pk,
            keccak256(
                abi.encode(
                    core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                    signer,
                    jobId,
                    token,
                    amount,
                    keccak256(""),
                    nonce,
                    deadline
                )
            )
        );
        return ERC8183WithAuthorization.Authorization(signer, nonce, deadline, sig);
    }

    /// @dev The worker's own activation with a budget authorization for exactly the quoted `net`.
    function activateAs(ISidequestHolding.Selection memory sel, uint256 workerKey) internal {
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(sel.jobId, sel.worker);
        address token = address(holding.getListing(sel.jobId).token);
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(workerKey, sel.worker, sel.jobId, token, net, uint72(sel.jobId));
        vm.prank(sel.worker);
        holding.activate(sel, sig, auth);
    }

    function activate(uint256 jobId) internal {
        activateAs(selectionFor(jobId, worker, AGENT_ID), workerPk);
    }

    function fundedJob() internal returns (uint256 jobId) {
        jobId = publish();
        activate(jobId);
    }

    function submit(uint256 jobId) internal {
        vm.prank(worker);
        core.submit(jobId, DELIVERABLE, "");
    }

    function submittedJob() internal returns (uint256 jobId) {
        jobId = fundedJob();
        submit(jobId);
    }

    function rejectAs(uint256 jobId, ISidequestEvaluator.Violation v) internal {
        vm.prank(creator);
        evaluator.reject(jobId, v, REASON);
    }

    function disputedJob() internal returns (uint256 jobId) {
        jobId = submittedJob();
        rejectAs(jobId, ISidequestEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function rule(uint256 jobId, bool forWorker, bool slashLoser) internal {
        vm.prank(arbitrator);
        evaluator.rule(jobId, forWorker, slashLoser, REASON);
    }

    function topUp(uint256 jobId, address from, uint256 amount) internal {
        vm.prank(from);
        holding.topUp(jobId, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------------------------------

    function status(uint256 jobId) internal view returns (ERC8183.JobStatus) {
        return core.getJob(jobId).status;
    }

    function listing(uint256 jobId) internal view returns (ISidequestHolding.Listing memory) {
        return holding.getListing(jobId);
    }

    function caseOf(uint256 jobId) internal view returns (ISidequestEvaluator.Case memory) {
        return evaluator.caseOf(jobId);
    }

    function signCore(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function signRuling(uint256 pk, ISidequestEvaluator.Ruling memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, evaluator.rulingDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    /// @dev The fee and net the worker's stake buys on `reward` under the default schedule.
    function feeOf(uint256 reward, uint256 stake) internal view returns (uint256 fee, uint256 net) {
        // Rounded up, never the whole reward (C9 MATH-1).
        fee = (reward * fees.feeBps(stake) + 9_999) / 10_000;
        if (fee >= reward) fee = reward - 1;
        net = reward - fee;
    }
}
