// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../../vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "../../vendor/erc8004/IERC8004.sol";
import {IStakeVault} from "./IStakeVault.sol";
import {IFeeSchedule} from "./IFeeSchedule.sol";

/// @title ISidequestHolding
/// @notice The ERC-8183 *client* of every Sidequest v1 job (ADR-0011), forked from the legacy `JobHolding` without
///         contests. A creator publishes an offer with its own review, dispute and arbitration windows (within
///         `SidequestConstants` bounds) and its own arbitrator (zero = the default), escrowing the reward in any ERC-20
///         (ADR-0010) and reserving the creator bond from its SIDE stake. The selected worker's own `activate` is
///         the final confirmation: it reserves the worker bond, snapshots the worker's fee tier, and funds the core
///         with the reward minus the fee. Holding keeps the fee until `settle`.
///
///         Money table (`settle`, after a terminal core status; every transfer falls back to `owed`):
///
///         | Terminal state                          | Worker                 | Treasury       | Creator / contributors          |
///         | --------------------------------------- | ---------------------- | -------------- | ------------------------------- |
///         | Completed (the core paid `net`)         | bonus − bonusFee       | fee + bonusFee | —                               |
///         | Rejected/Expired, `earnedByWorker`      | net + bonus − bonusFee | fee + bonusFee | —                               |
///         | Rejected/Expired otherwise              | —                      | —              | reward to creator; each top-up refundable to its contributor |
///         | Cancelled or expired before activation  | —                      | —              | reward to creator (no fee)      |
///
///         Bonds are reservations in the `IStakeVault`: a bond is slashed (sent to the vault's slash recipient) when the evaluator says its penalty
///         is due, and released otherwise. `burnBond` and `returnBonds` are the evaluator's; `settle` handles whatever
///         the evaluator did not. A nonzero bond's slash requested at or after the listing's `expiredAt` instead
///         releases it, leaves its `*BondBurned` flag false, and emits `BondReleased`. A never-activated listing instead
///         forfeits its snapshotted creator-bond share to the treasury on expiry or cancellation at/after 600 seconds;
///         earlier cancellation releases the full bond. The unfilled rule is the explicit expiry-protection exception.
///
///         Fixes against the 2 Oct review: M3 (a `policyHash` is unique per creator, so copying someone's offer hash
///         cannot block their publish); M1 and M2 live in the evaluator. Hostile tokens (ADR-0010): the reward and every
///         top-up must arrive in full, entry points are non-reentrant, and escrow is pooled per token.
///
///         The EIP-712 domain is ("SidequestHolding", "1") and `Selection` keeps the legacy type string; the
///         `verifyingContract` separates this pair from the legacy ones.
///
///         The implementation is `Ownable2Step` through `NoRenounce` (owner: the Safe); the ownership functions come from
///         OpenZeppelin, and `renounceOwnership` always reverts.
interface ISidequestHolding {
    /// @dev A bonded listing cannot outlive the unstaking cooldown that protects its backers.
    error BondOutlastsUnbonding(uint256 expiredAt, uint256 latest);

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice The creator's pick of one worker for one listing, signed off-chain (EIP-712). `termsHash` must equal
    ///         the listing's `policyHash`; `activateBy` bounds how long the pick stands and must precede the delivery
    ///         deadline; `nonce` is in the creator's own nonce space (see `cancelSelection`).
    struct Selection {
        uint256 jobId;
        address worker;
        uint256 agentId;
        bytes32 termsHash;
        uint48 activateBy;
        uint256 nonce;
    }

    enum Side {
        Creator,
        Worker
    }

    /// @notice Where the reward went at `settle`: to the worker (`Paid`) or back to the creator (`Refunded`).
    enum Outcome {
        None,
        Paid,
        Refunded
    }

    /// @notice One listing. Fields are ordered for storage packing.
    struct Listing {
        address creator;
        Outcome outcome;
        /// @dev Set by `activate`: the core was funded with `reward - fee`.
        bool funded;
        bool rewardSettled;
        bool creatorBondSettled;
        bool workerBondSettled;
        /// @dev Legacy ABI name: true when the creator bond was sent to the vault's slash recipient.
        bool creatorBondBurned;
        /// @dev Legacy ABI name: true when the worker bond was sent to the vault's slash recipient.
        bool workerBondBurned;
        /// @dev Set by `activate` (also for a zero worker bond): the worker side exists and must be settled.
        bool workerBondReserved;
        /// @dev Judges the work (accept, reject); never pays or selects. Frozen at publish; defaults to the creator.
        address approver;
        uint48 deliveryDeadline;
        uint48 expiredAt;
        /// @dev Rules on disputes. Resolved at publish (zero → `defaultArbitrator`) and frozen into the listing.
        address arbitrator;
        uint32 reviewWindow;
        uint32 disputeWindow;
        /// @dev The worker's fee rate, snapshotted at activation from its stake; zero before.
        uint16 feeBps;
        address worker;
        uint32 arbitrationWindow;
        uint48 publishedAt;
        uint16 unfilledForfeitBps;
        IERC20 token;
        /// @dev The gross reward escrowed at publish.
        uint256 reward;
        /// @dev `reward * feeBps / 10_000`, fixed at activation. Holding keeps it until settle.
        uint256 fee;
        /// @dev The sum of every top-up.
        uint256 bonus;
        uint256 creatorBond;
        uint256 workerBond;
        bytes32 manifestHash;
        /// @dev The board's `termsHash`: the canonical snapshot of the offer the worker accepts. Unique per creator.
        bytes32 policyHash;
    }

    /// @notice What the evaluator reads about a job, in one call.
    struct Terms {
        address creator;
        address approver;
        address arbitrator;
        address worker;
        uint48 deliveryDeadline;
        uint32 reviewWindow;
        uint32 disputeWindow;
        uint32 arbitrationWindow;
        /// @dev The amount Holding funded into the core at activation (`reward - fee`); zero before activation.
        uint256 funded;
        bytes32 policyHash;
    }

    struct PublishParams {
        /// @dev Zero means the creator approves its own offer.
        address approver;
        /// @dev Zero means `defaultArbitrator`. May not resolve to the creator or the approver.
        address arbitrator;
        bytes32 manifestHash;
        bytes32 policyHash;
        IERC20 token;
        uint256 reward;
        /// @dev Reserved from the creator's stake now; at least `minimumCreatorBond()`.
        uint256 creatorBond;
        /// @dev Reserved from the worker's stake at activation; zero for none.
        uint256 workerBond;
        uint48 deliveryDeadline;
        /// @dev The core job's expiry. At least `deliveryDeadline + review + dispute + arbitration + margin`.
        uint48 expiredAt;
        uint32 reviewWindow;
        uint32 disputeWindow;
        uint32 arbitrationWindow;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event Published(
        uint256 indexed jobId,
        address indexed creator,
        address indexed approver,
        address arbitrator,
        address token,
        uint256 reward,
        uint256 creatorBond,
        uint256 workerBond,
        bytes32 manifestHash,
        bytes32 policyHash,
        uint48 deliveryDeadline,
        uint48 expiredAt,
        uint32 reviewWindow,
        uint32 disputeWindow,
        uint32 arbitrationWindow
    );
    /// @dev Activation is also funding: the core holds `net = reward - fee` from here on.
    event Activated(
        uint256 indexed jobId,
        address indexed worker,
        uint256 agentId,
        uint256 selectionNonce,
        uint16 feeBps,
        uint256 fee,
        uint256 net,
        uint256 workerBond
    );
    event SelectionCancelled(address indexed creator, uint256 nonce);
    event Cancelled(uint256 indexed jobId);
    event ToppedUp(uint256 indexed jobId, address indexed contributor, uint256 amount, uint256 bonus);
    event TopUpRefunded(uint256 indexed jobId, address indexed contributor, uint256 amount);
    /// @dev `amount` is what this settlement sent (or owed) to `to` from the reward and the bonus.
    event RewardSettled(uint256 indexed jobId, address indexed to, Outcome outcome, uint256 amount);
    /// @notice The fee a paid job charged: `amount = fee + bonusFee`, of which `bonusPart = bonusFee` came from top-ups.
    event FeeCharged(
        uint256 indexed jobId,
        address indexed token,
        address indexed worker,
        address creator,
        uint256 amount,
        uint256 bonusPart
    );
    /// @notice A transfer the token refused; the amount is recorded in `owed` for `to` to `withdraw`.
    event PayoutOwed(uint256 indexed jobId, address indexed to, address indexed token, uint256 amount);
    event OwedWithdrawn(address indexed to, address indexed token, uint256 amount);
    event BondReleased(uint256 indexed jobId, Side side, address indexed account, uint256 amount);
    event BondSlashed(uint256 indexed jobId, Side side, address indexed account, uint256 amount);
    event BondForfeited(uint256 indexed jobId, address indexed creator, address indexed treasury, uint256 amount);
    event MinimumCreatorBondSet(uint256 minimum);
    event UnfilledForfeitBpsSet(uint16 bps);
    event EvaluatorSet(address indexed evaluator);
    event DefaultArbitratorSet(address indexed arbitrator);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error InvalidBondPolicy();
    error InvalidForfeitTreasury();
    error CreatorBondTooLow(uint256 supplied, uint256 minimum);
    function minimumCreatorBond() external view returns (uint256);
    function MAX_MINIMUM_CREATOR_BOND() external view returns (uint256);
    function unfilledForfeitBps() external view returns (uint16);
    function MAX_FORFEIT_BPS() external view returns (uint16);
    function CANCEL_GRACE() external view returns (uint48);
    function setMinimumCreatorBond(uint256 minimum) external;
    function setUnfilledForfeitBps(uint16 bps) external;
    error EvaluatorAlreadySet();
    error EvaluatorNotSet();
    error NotCreator();
    error NotEvaluator();
    error UnknownJob();
    error ZeroReward();
    error ZeroAmount();
    error PolicyHashRequired();
    /// @dev This creator already listed this `policyHash` (R114-07); another creator's copy does not count (M3).
    error PolicyHashUsed();
    error DeadlineInPast();
    error WindowOutOfBounds(uint32 window, uint32 min, uint32 max);
    error ExpiryTooShort(uint48 expiredAt, uint256 minimum);
    /// @dev The arbitrator would be the creator or the approver.
    error ArbitratorConflict();
    error RewardTokenShortfall(uint256 expected, uint256 received);
    error NotSelectedWorker();
    /// @dev The activating worker is the creator, the approver or the arbitrator of this listing.
    error RoleConflict();
    error SelectionExpired();
    error SelectionInvalid();
    error SelectionNonceUsed();
    error TermsMismatch();
    error AgentIdRequired();
    error NotAgentWallet();
    error AlreadyActivated();
    error InvalidSignature();
    /// @dev Top-ups are taken only while the core job is Funded or Submitted.
    error NotActive();
    error TopUpNotRefundable();
    error NothingToRefund();
    error NothingToSettle();
    error NotTerminal();
    error NothingOwed();
    /// @dev A payout push needs `TRANSFER_GAS` left; send the call with more gas.
    error TransferGasTooLow(uint256 left, uint256 needed);
    /// @dev `pushPayment` is `_pay`'s own frame.
    error OnlySelf();
    /// @dev The core charges a platform or evaluator fee; Holding already took its fee.
    error CoreChargesFees();
    /// @dev Reward plus top-ups would overflow.
    error TopUpTooLarge();

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Escrows the reward (it must arrive in full), reserves the creator bond from the creator's stake, and
    ///         creates the core job with Holding as client and no provider. Checks the window bounds, that the
    ///         arbitrator is neither the creator nor the approver, a future delivery deadline, an expiry that covers
    ///         every window plus `margin`, and that this creator has not listed `policyHash` before.
    function publish(PublishParams calldata p) external returns (uint256 jobId);

    /// @notice Burns one of the caller's selection nonces, so a signed but unactivated `Selection` cannot be used.
    function cancelSelection(uint256 nonce) external;

    /// @notice Creator only, before activation: rejects the core job and settles in the same transaction (reward
    ///         back to the creator, no fee; creator bond released).
    function cancel(uint256 jobId) external;

    // ---------------------------------------------------------------------------------------------
    // Worker
    // ---------------------------------------------------------------------------------------------

    /// @notice The selected worker's final confirmation, sent by the worker itself (never relayed for it). Checks the
    ///         creator's `Selection` (signature, nonce, `activateBy`, `termsHash`), that the sender is the agent's
    ///         ERC-8004 wallet and is not the creator, approver or arbitrator; then snapshots
    ///         `feeBps = feeSchedule.feeBps(vault.stakeOf(worker))`, reserves the worker bond, sets the provider, applies
    ///         the worker's `SetBudgetAuthorization` for exactly `net = reward - fee` in the listed token, and funds the
    ///         core with `net`. All or nothing; at most once.
    /// @param budgetAuth The worker's signed core `SetBudgetAuthorization` for this job, token and `net` (see
    ///        `quoteActivation`).
    function activate(
        Selection calldata sel,
        bytes calldata creatorSig,
        ERC8183WithAuthorization.Authorization calldata budgetAuth
    ) external;

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds `amount` of the listing's token to the job's bonus. Anyone, only after activation while the core
    ///         job is Funded or Submitted; the amount must arrive in full. Paid to the worker with the reward (minus
    ///         the same fee rate), or refundable to the contributor if the creator is refunded.
    function topUp(uint256 jobId, uint256 amount) external;

    /// @notice Refunds `contributor`'s top-ups on a job whose reward went back to the creator. Anyone may call; the
    ///         money goes to `contributor` (or to `owed` if the token refuses).
    function claimTopUpRefund(uint256 jobId, address contributor) external;

    /// @notice Settles whatever of a terminal job is still here, each amount once, per the money table. Bonds the
    ///         evaluator did not settle are slashed if their penalty is due before expiry and released otherwise.
    ///         Anyone may call; the effect is fixed.
    function settle(uint256 jobId) external;

    /// @notice Sends the caller everything in `token` that an earlier transfer could not.
    function withdraw(IERC20 token) external;

    // ---------------------------------------------------------------------------------------------
    // Evaluator only
    // ---------------------------------------------------------------------------------------------

    /// @notice Slashes one side's bond on a finding the evaluator made final: a ruling, an undisputed violation, a
    ///         missed delivery. Slashed SIDE is sent to the vault's slash recipient. At or after `expiredAt`, a nonzero bond is released instead. A side already settled
    ///         is left alone.
    function burnBond(uint256 jobId, Side side) external;

    /// @notice Releases every bond not yet settled. Idempotent.
    function returnBonds(uint256 jobId) external;

    // ---------------------------------------------------------------------------------------------
    // Owner (the Safe)
    // ---------------------------------------------------------------------------------------------

    /// @notice Once, at deploy: the evaluator (it needs this address in its constructor).
    function setEvaluator(address evaluator_) external;

    /// @notice The arbitrator a new listing gets when it names none. Resolved and stored at publish, so changing it
    ///         never touches a live job; lets arbiter keys rotate.
    function setDefaultArbitrator(address arbitrator) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice What `activate` would charge `worker` now: its fee rate, the fee, and the `net` its budget
    ///         authorization must name.
    function quoteActivation(uint256 jobId, address worker)
        external
        view
        returns (uint16 feeBps, uint256 fee, uint256 net);

    function termsOf(uint256 jobId) external view returns (Terms memory);

    function getListing(uint256 jobId) external view returns (Listing memory);

    /// @notice The EIP-712 digest a creator signs for `sel` (domain "SidequestHolding", version "1").
    function selectionDigest(Selection calldata sel) external view returns (bytes32);

    /// @notice Whether `creator` has listed `policyHash` (M3: the key includes the creator).
    function policyListed(address creator, bytes32 policyHash) external view returns (bool);

    function selectionNonceUsed(address creator, uint256 nonce) external view returns (bool);

    /// @notice `contributor`'s top-ups on `jobId` not yet refunded.
    function topUpOf(uint256 jobId, address contributor) external view returns (uint256);

    /// @notice What a refused transfer left owed to `account` in `token`.
    function owed(IERC20 token, address account) external view returns (uint256);

    function core() external view returns (ERC8183WithAuthorization);
    function vault() external view returns (IStakeVault);
    function feeSchedule() external view returns (IFeeSchedule);
    function identity() external view returns (IERC8004Identity);
    function evaluator() external view returns (address);
    function defaultArbitrator() external view returns (address);

    /// @notice Slack added to the windows when checking `expiredAt`.
    function margin() external view returns (uint48);

    /// @notice The gas budget of each payout push; a push that fails within it is recorded in `owed`.
    function TRANSFER_GAS() external view returns (uint256);

    /// @notice Internal to the payout path (C9-002): callable only by this contract.
    function pushPayment(IERC20 token, address to, uint256 amount) external;

    function SELECTION_TYPEHASH() external view returns (bytes32);
    function MIN_REVIEW_WINDOW() external view returns (uint32);
    function MAX_REVIEW_WINDOW() external view returns (uint32);
    function MIN_DISPUTE_WINDOW() external view returns (uint32);
    function MAX_DISPUTE_WINDOW() external view returns (uint32);
    function MIN_ARBITRATION_WINDOW() external view returns (uint32);
    function MAX_ARBITRATION_WINDOW() external view returns (uint32);
}
