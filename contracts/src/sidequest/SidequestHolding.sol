// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NoRenounce} from "./NoRenounce.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Signatures} from "../Signatures.sol";
import {ERC8183} from "../vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "../vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "./interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "./interfaces/ISidequestEvaluator.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";
import {IFeeSchedule} from "./interfaces/IFeeSchedule.sol";
import {SidequestConstants} from "./interfaces/SidequestConstants.sol";
import {SidequestClocks} from "./SidequestClocks.sol";

/// @title SidequestHolding
/// @notice The ERC-8183 client of every Sidequest v1 job (ADR-0011). The full contract, including the money table, is
///         in `ISidequestHolding`. Forked from the legacy `JobHolding` without contests and hold gates; bonds are
///         reservations in the `StakeVault`; never-activated listings may forfeit a snapshotted part of the creator bond. The worker's fee rate is snapshotted at
///         activation and the core is funded with the reward minus the fee.
///
///         Hostile reward tokens (ADR-0010): the reward and every top-up must arrive in full; every state-changing
///         entry point is non-reentrant; escrow is pooled per token; and every outflow is a push with a fixed gas
///         budget that falls back to `owed`, so a token that refuses, reverts or burns gas can delay only its own
///         payees and never blocks a bond or another payee.
contract SidequestHolding is ISidequestHolding, EIP712, NoRenounce, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant SELECTION_TYPEHASH = keccak256(
        "Selection(uint256 jobId,address worker,uint256 agentId,bytes32 termsHash,uint48 activateBy,uint256 nonce)"
    );
    uint32 public immutable MIN_REVIEW_WINDOW;
    uint32 public constant MAX_REVIEW_WINDOW = SidequestConstants.MAX_REVIEW_WINDOW;
    uint32 public immutable MIN_DISPUTE_WINDOW;
    uint32 public constant MAX_DISPUTE_WINDOW = SidequestConstants.MAX_DISPUTE_WINDOW;
    uint32 public immutable MIN_ARBITRATION_WINDOW;
    uint32 public constant MAX_ARBITRATION_WINDOW = SidequestConstants.MAX_ARBITRATION_WINDOW;
    /// @notice The gas each payout push may use before it falls back to `owed`. Monad charges the gas limit, so this
    ///         is also a cost cap; a token needing more is paid through `withdraw`, which has no cap.
    uint256 public constant TRANSFER_GAS = 300_000;
    /// @dev Gas for the whole `pushPayment` frame: the token's own budget under the 63/64 rule, plus the frame's
    ///      checks, the cold token access (10,100 on Monad) and the revert.
    uint256 private constant PUSH_FRAME_GAS = TRANSFER_GAS * 64 / 63 + 25_000;

    ERC8183WithAuthorization public immutable core;
    IStakeVault public immutable vault;
    IFeeSchedule public immutable feeSchedule;
    uint256 public minimumCreatorBond;
    uint256 public immutable MAX_MINIMUM_CREATOR_BOND;
    uint16 public unfilledForfeitBps;
    uint16 public constant MAX_FORFEIT_BPS = 5000;
    uint48 public constant CANCEL_GRACE = 600;
    IERC8004Identity public immutable identity;
    uint48 public immutable margin;
    address public evaluator;
    address public defaultArbitrator;

    mapping(uint256 jobId => Listing) internal _listings;
    mapping(address creator => mapping(bytes32 policyHash => bool)) public policyListed;
    mapping(address creator => mapping(uint256 nonce => bool)) public selectionNonceUsed;
    mapping(uint256 jobId => mapping(address contributor => uint256)) public topUpOf;
    mapping(IERC20 token => mapping(address account => uint256)) public owed;

    constructor(
        ERC8183WithAuthorization core_,
        IStakeVault vault_,
        IFeeSchedule feeSchedule_,
        IERC8004Identity identity_,
        address defaultArbitrator_,
        uint48 margin_,
        uint256 minimumCreatorBond_,
        uint256 maxMinimumCreatorBond_,
        uint16 unfilledForfeitBps_,
        SidequestClocks.Config memory clocks
    ) EIP712("SidequestHolding", "1") Ownable(msg.sender) {
        if (
            address(core_) == address(0) || address(vault_) == address(0) || address(feeSchedule_) == address(0)
                || address(identity_) == address(0) || defaultArbitrator_ == address(0)
        ) revert ZeroAddress();
        SidequestClocks.validate(clocks);
        if (
            minimumCreatorBond_ == 0 || maxMinimumCreatorBond_ < minimumCreatorBond_
                || unfilledForfeitBps_ > MAX_FORFEIT_BPS
        ) {
            revert InvalidBondPolicy();
        }
        MIN_REVIEW_WINDOW = clocks.minReviewWindow;
        MIN_DISPUTE_WINDOW = clocks.minDisputeWindow;
        MIN_ARBITRATION_WINDOW = clocks.minArbitrationWindow;
        core = core_;
        vault = vault_;
        feeSchedule = feeSchedule_;
        minimumCreatorBond = minimumCreatorBond_;
        MAX_MINIMUM_CREATOR_BOND = maxMinimumCreatorBond_;
        unfilledForfeitBps = unfilledForfeitBps_;
        identity = identity_;
        defaultArbitrator = defaultArbitrator_;
        margin = margin_;
        emit DefaultArbitratorSet(defaultArbitrator_);
    }

    modifier onlyEvaluator() {
        if (msg.sender != evaluator) revert NotEvaluator();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setEvaluator(address evaluator_) external onlyOwner {
        if (evaluator != address(0)) revert EvaluatorAlreadySet();
        if (evaluator_ == address(0)) revert ZeroAddress();
        evaluator = evaluator_;
        emit EvaluatorSet(evaluator_);
    }

    function setDefaultArbitrator(address arbitrator) external onlyOwner {
        if (arbitrator == address(0)) revert ZeroAddress();
        defaultArbitrator = arbitrator;
        emit DefaultArbitratorSet(arbitrator);
    }

    function setMinimumCreatorBond(uint256 minimum) external onlyOwner {
        if (minimum == 0 || minimum > MAX_MINIMUM_CREATOR_BOND) revert InvalidBondPolicy();
        minimumCreatorBond = minimum;
        emit MinimumCreatorBondSet(minimum);
    }

    function setUnfilledForfeitBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FORFEIT_BPS) revert InvalidBondPolicy();
        unfilledForfeitBps = bps;
        emit UnfilledForfeitBpsSet(bps);
    }

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    function publish(PublishParams calldata p) external nonReentrant returns (uint256 jobId) {
        address evaluator_ = evaluator;
        if (evaluator_ == address(0)) revert EvaluatorNotSet();
        if (p.reward == 0) revert ZeroReward();
        if (p.creatorBond < minimumCreatorBond) revert CreatorBondTooLow(p.creatorBond, minimumCreatorBond);
        if (p.policyHash == bytes32(0)) revert PolicyHashRequired();
        if (policyListed[msg.sender][p.policyHash]) revert PolicyHashUsed();
        if (p.deliveryDeadline <= block.timestamp) revert DeadlineInPast();
        _checkWindow(p.reviewWindow, MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW);
        _checkWindow(p.disputeWindow, MIN_DISPUTE_WINDOW, MAX_DISPUTE_WINDOW);
        _checkWindow(p.arbitrationWindow, MIN_ARBITRATION_WINDOW, MAX_ARBITRATION_WINDOW);
        uint256 minExpiry =
            uint256(p.deliveryDeadline) + p.reviewWindow + p.disputeWindow + p.arbitrationWindow + margin;
        if (p.expiredAt < minExpiry) revert ExpiryTooShort(p.expiredAt, minExpiry);
        uint256 latest = block.timestamp + vault.UNSTAKE_DELAY();
        if (p.expiredAt > latest) revert BondOutlastsUnbonding(p.expiredAt, latest);
        address approver = p.approver == address(0) ? msg.sender : p.approver;
        address arbitrator = p.arbitrator == address(0) ? defaultArbitrator : p.arbitrator;
        if (arbitrator == msg.sender || arbitrator == approver) revert ArbitratorConflict();

        policyListed[msg.sender][p.policyHash] = true;
        uint256 before = p.token.balanceOf(address(this));
        p.token.safeTransferFrom(msg.sender, address(this), p.reward);
        uint256 received = p.token.balanceOf(address(this)) - before;
        if (received != p.reward) revert RewardTokenShortfall(p.reward, received);
        // Also checks that this Holding may still take bonds: a revoked Holding publishes nothing, even unbonded.
        vault.reserve(msg.sender, p.creatorBond);

        jobId = core.createJob(
            address(0), evaluator_, p.expiredAt, Strings.toHexString(uint256(p.manifestHash), 32), address(0), 0
        );
        Listing storage l = _listings[jobId];
        l.creator = msg.sender;
        l.approver = approver;
        l.deliveryDeadline = p.deliveryDeadline;
        l.expiredAt = p.expiredAt;
        l.arbitrator = arbitrator;
        l.reviewWindow = p.reviewWindow;
        l.disputeWindow = p.disputeWindow;
        l.arbitrationWindow = p.arbitrationWindow;
        l.token = p.token;
        l.reward = p.reward;
        l.creatorBond = p.creatorBond;
        l.workerBond = p.workerBond;
        l.manifestHash = p.manifestHash;
        l.policyHash = p.policyHash;
        l.publishedAt = uint48(block.timestamp);
        l.unfilledForfeitBps = unfilledForfeitBps;

        emit Published(
            jobId,
            msg.sender,
            approver,
            arbitrator,
            address(p.token),
            p.reward,
            p.creatorBond,
            p.workerBond,
            p.manifestHash,
            p.policyHash,
            p.deliveryDeadline,
            p.expiredAt,
            p.reviewWindow,
            p.disputeWindow,
            p.arbitrationWindow
        );
    }

    function cancelSelection(uint256 nonce) external {
        if (selectionNonceUsed[msg.sender][nonce]) revert SelectionNonceUsed();
        selectionNonceUsed[msg.sender][nonce] = true;
        emit SelectionCancelled(msg.sender, nonce);
    }

    function cancel(uint256 jobId) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.creator != msg.sender) revert NotCreator();
        if (l.funded) revert AlreadyActivated();
        core.reject(jobId, "cancelled", "");
        emit Cancelled(jobId);
        _settle(jobId, l);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker
    // ---------------------------------------------------------------------------------------------

    function activate(
        Selection calldata sel,
        bytes calldata creatorSig,
        ERC8183WithAuthorization.Authorization calldata budgetAuth
    ) external nonReentrant {
        uint256 jobId = sel.jobId;
        Listing storage l = _listings[jobId];
        address creator = l.creator;
        if (creator == address(0)) revert UnknownJob();
        if (l.funded) revert AlreadyActivated();
        if (msg.sender != sel.worker) revert NotSelectedWorker();
        if (msg.sender == creator || msg.sender == l.approver || msg.sender == l.arbitrator) revert RoleConflict();
        // Allowed at its deadline, refused strictly after (the boundary convention).
        if (block.timestamp > sel.activateBy) revert SelectionExpired();
        if (sel.activateBy >= l.deliveryDeadline) revert SelectionInvalid();
        if (sel.termsHash != l.policyHash) revert TermsMismatch();
        if (selectionNonceUsed[creator][sel.nonce]) revert SelectionNonceUsed();
        if (!Signatures.isValid(creator, selectionDigest(sel), creatorSig)) revert InvalidSignature();
        if (sel.agentId == 0) revert AgentIdRequired();
        if (identity.getAgentWallet(sel.agentId) != msg.sender) revert NotAgentWallet();
        // Holding keeps the fee and funds `net`; a core that charges on top would cut the worker twice (C9 ACL-5).
        if (core.platformFeeBP() != 0 || core.evaluatorFeeBP() != 0) revert CoreChargesFees();
        if (l.workerBond != 0) {
            uint256 latest = block.timestamp + vault.UNSTAKE_DELAY();
            if (l.expiredAt > latest) revert BondOutlastsUnbonding(l.expiredAt, latest);
        }

        (uint16 feeBps, uint256 fee, uint256 net) = _quote(l.reward, msg.sender);
        selectionNonceUsed[creator][sel.nonce] = true;
        l.worker = msg.sender;
        l.funded = true;
        l.workerBondReserved = true;
        l.feeBps = feeBps;
        l.fee = fee;
        emit Activated(jobId, msg.sender, sel.agentId, sel.nonce, feeBps, fee, net, l.workerBond);

        vault.reserve(msg.sender, l.workerBond);
        core.setProvider(jobId, msg.sender, sel.agentId);
        IERC20 token = l.token;
        core.setBudgetWithAuthorization(jobId, address(token), net, "", budgetAuth);
        token.forceApprove(address(core), net);
        core.fund(jobId, address(token), net, "");
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    function topUp(uint256 jobId, uint256 amount) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        if (amount == 0) revert ZeroAmount();
        if (!l.funded) revert NotActive();
        ERC8183.JobStatus status = core.getJob(jobId).status;
        if (status != ERC8183.JobStatus.Funded && status != ERC8183.JobStatus.Submitted) revert NotActive();
        // A decided job whose core call is deferred still reads Funded/Submitted; it takes no more money (C9-003).
        if (ISidequestEvaluator(evaluator).outcome(jobId) != ISidequestEvaluator.Outcome.None) revert NotActive();
        IERC20 token = l.token;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert RewardTokenShortfall(amount, received);
        uint256 bonus = l.bonus + amount;
        // `settle` adds reward and bonus; refuse here a total that could not be paid out (a token lying about balances).
        if (bonus > type(uint256).max - l.reward) revert TopUpTooLarge();
        l.bonus = bonus;
        topUpOf[jobId][msg.sender] += amount;
        emit ToppedUp(jobId, msg.sender, amount, bonus);
    }

    function claimTopUpRefund(uint256 jobId, address contributor) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.outcome != Outcome.Refunded) revert TopUpNotRefundable();
        uint256 amount = topUpOf[jobId][contributor];
        if (amount == 0) revert NothingToRefund();
        topUpOf[jobId][contributor] = 0;
        emit TopUpRefunded(jobId, contributor, amount);
        _pay(jobId, l.token, contributor, amount);
    }

    function settle(uint256 jobId) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        if (!_settle(jobId, l)) revert NothingToSettle();
    }

    function withdraw(IERC20 token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit OwedWithdrawn(msg.sender, address(token), amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Evaluator only
    // ---------------------------------------------------------------------------------------------

    function burnBond(uint256 jobId, Side side) external nonReentrant onlyEvaluator {
        Listing storage l = _listings[jobId];
        if (_bondOpen(l, side)) _settleBond(jobId, l, side, true);
    }

    function returnBonds(uint256 jobId) external nonReentrant onlyEvaluator {
        Listing storage l = _listings[jobId];
        if (_bondOpen(l, Side.Creator)) _settleBond(jobId, l, Side.Creator, false);
        if (_bondOpen(l, Side.Worker)) _settleBond(jobId, l, Side.Worker, false);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function quoteActivation(uint256 jobId, address worker)
        external
        view
        returns (uint16 feeBps, uint256 fee, uint256 net)
    {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        return _quote(l.reward, worker);
    }

    function termsOf(uint256 jobId) external view returns (Terms memory t) {
        Listing storage l = _listings[jobId];
        t.creator = l.creator;
        t.approver = l.approver;
        t.arbitrator = l.arbitrator;
        t.worker = l.worker;
        t.deliveryDeadline = l.deliveryDeadline;
        t.reviewWindow = l.reviewWindow;
        t.disputeWindow = l.disputeWindow;
        t.arbitrationWindow = l.arbitrationWindow;
        t.funded = l.funded ? l.reward - l.fee : 0;
        t.policyHash = l.policyHash;
    }

    function getListing(uint256 jobId) external view returns (Listing memory) {
        return _listings[jobId];
    }

    function selectionDigest(Selection calldata sel) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SELECTION_TYPEHASH, sel.jobId, sel.worker, sel.agentId, sel.termsHash, sel.activateBy, sel.nonce
                )
            )
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _checkWindow(uint32 window, uint32 min, uint32 max) private pure {
        if (window < min || window > max) revert WindowOutOfBounds(window, min, max);
    }

    function _quote(uint256 reward, address worker) private view returns (uint16 feeBps, uint256 fee, uint256 net) {
        feeBps = feeSchedule.feeBps(vault.stakeOf(worker));
        // Rounded in the treasury's favour (C9 MATH-1), but never the whole reward: `net == 0` reads as never activated.
        fee = Math.mulDiv(reward, feeBps, SidequestConstants.BPS, Math.Rounding.Ceil);
        if (fee >= reward) fee = reward - 1;
        net = reward - fee;
    }

    /// @dev Settles whatever of a terminal job is still open, each part once, and returns whether anything was. Bonds
    ///      go first (the vault is trusted); reward-token pushes go last and cannot revert.
    function _settle(uint256 jobId, Listing storage l) private returns (bool did) {
        ERC8183.JobStatus status = core.getJob(jobId).status;
        if (!_isTerminal(status)) revert NotTerminal();
        ISidequestEvaluator ev = ISidequestEvaluator(evaluator);
        if (_bondOpen(l, Side.Creator)) {
            did = true;
            _settleBond(jobId, l, Side.Creator, ev.creatorPenaltyDue(jobId));
        }
        if (_bondOpen(l, Side.Worker)) {
            did = true;
            _settleBond(jobId, l, Side.Worker, ev.workerPenaltyDue(jobId));
        }
        if (l.rewardSettled) return did;
        l.rewardSettled = true;
        IERC20 token = l.token;
        address worker = l.worker;
        // Completed: the core already paid `net`. Otherwise the reward is back here, and the evaluator says whose it is.
        bool paid = status == ERC8183.JobStatus.Completed || (l.funded && ev.earnedByWorker(jobId));
        if (paid) {
            l.outcome = Outcome.Paid;
            uint256 bonusFee = Math.mulDiv(l.bonus, l.feeBps, SidequestConstants.BPS, Math.Rounding.Ceil);
            uint256 toWorker = l.bonus - bonusFee;
            if (status != ERC8183.JobStatus.Completed) toWorker += l.reward - l.fee;
            uint256 toTreasury = l.fee + bonusFee;
            emit RewardSettled(jobId, worker, Outcome.Paid, toWorker);
            if (toTreasury > 0) emit FeeCharged(jobId, address(token), worker, l.creator, toTreasury, bonusFee);
            _pay(jobId, token, worker, toWorker);
            _pay(jobId, token, feeSchedule.treasury(), toTreasury);
        } else {
            // A refund returns the fee too (the core refunded `net`, Holding kept `fee`); each top-up becomes
            // refundable to its contributor through `claimTopUpRefund`.
            l.outcome = Outcome.Refunded;
            emit RewardSettled(jobId, l.creator, Outcome.Refunded, l.reward);
            _pay(jobId, token, l.creator, l.reward);
        }
        return true;
    }

    function _bondOpen(Listing storage l, Side side) private view returns (bool) {
        if (side == Side.Creator) return !l.creatorBondSettled;
        return l.workerBondReserved && !l.workerBondSettled;
    }

    function _settleBond(uint256 jobId, Listing storage l, Side side, bool slash) private {
        (address account, uint256 amount) = side == Side.Creator ? (l.creator, l.creatorBond) : (l.worker, l.workerBond);
        // Equality closes penalties before any same-timestamp exit; zero-amount bookkeeping stays unchanged.
        // HR-001 still suppresses every activated-job penalty at/after expiry. The one explicit exception is the
        // creator bond on a listing that never activated: it pays the snapshotted unfilled rate to the live treasury.
        bool unfilled = side == Side.Creator && !l.funded;
        ERC8183.JobStatus status = unfilled ? core.getJob(jobId).status : ERC8183.JobStatus.Open;
        bool shouldForfeit = unfilled && _isTerminal(status)
            && (block.timestamp >= uint256(l.publishedAt) + CANCEL_GRACE
                || block.timestamp >= l.expiredAt
                || status == ERC8183.JobStatus.Expired);
        if (amount != 0 && block.timestamp >= l.expiredAt && !shouldForfeit) slash = false;
        if (side == Side.Creator) {
            l.creatorBondSettled = true;
            if (slash && !shouldForfeit) l.creatorBondBurned = true;
        } else {
            l.workerBondSettled = true;
            if (slash) l.workerBondBurned = true;
        }
        if (amount == 0) return;
        if (shouldForfeit) {
            address treasury = feeSchedule.treasury();
            if (treasury == address(0) || treasury == address(this)) revert InvalidForfeitTreasury();
            uint256 forfeited = Math.mulDiv(amount, l.unfilledForfeitBps, SidequestConstants.BPS);
            if (forfeited != 0) {
                uint256 taken = vault.forfeit(account, forfeited, treasury);
                emit BondForfeited(jobId, account, treasury, taken);
                amount -= taken;
            }
            if (amount != 0) emit BondReleased(jobId, side, account, vault.release(account, amount));
        } else if (slash) {
            emit BondSlashed(jobId, side, account, vault.slash(account, amount));
        } else {
            emit BondReleased(jobId, side, account, vault.release(account, amount));
        }
    }

    /// @dev Pushes `amount` to `to` through `pushPayment`; anything short of a clean success (a revert, `false`, short
    ///      return data, no code, out of gas) is recorded in `owed` instead. The push runs in its own frame, so a token
    ///      that moves the balance and then reports failure is rolled back before `owed` records it (C9-002): each
    ///      liability is paid or owed, never both. The caller must leave room for the full budget, so an honest token
    ///      cannot be pushed into the fallback by starving the call.
    function _pay(uint256 jobId, IERC20 token, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 needed = PUSH_FRAME_GAS * 64 / 63 + 10_000;
        if (gasleft() < needed) revert TransferGasTooLow(gasleft(), needed);
        try this.pushPayment{gas: PUSH_FRAME_GAS}(token, to, amount) {
            return;
        } catch {}
        owed[token][to] += amount;
        emit PayoutOwed(jobId, to, address(token), amount);
    }

    /// @notice Internal to `_pay`; only this contract may call it. Transfers with at most `TRANSFER_GAS`, reads at
    ///         most 32 bytes back, and reverts (undoing whatever the token did) unless the transfer clearly succeeded.
    function pushPayment(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        uint256 gasBudget = TRANSFER_GAS;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gasBudget, token, 0, add(data, 0x20), mload(data), 0, 0x20)
            switch returndatasize()
            case 0 { ok := and(ok, gt(extcodesize(token), 0)) }
            default { ok := and(ok, and(gt(returndatasize(), 31), eq(mload(0), 1))) }
            if iszero(ok) { revert(0, 0) }
        }
    }

    /// @dev Rejected or Expired means the core either never held the reward or has refunded it to Holding.
    function _isTerminal(ERC8183.JobStatus status) private pure returns (bool) {
        return status == ERC8183.JobStatus.Completed || status == ERC8183.JobStatus.Rejected
            || status == ERC8183.JobStatus.Expired;
    }
}
