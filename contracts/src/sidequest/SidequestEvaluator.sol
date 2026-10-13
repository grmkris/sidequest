// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NoRenounce} from "./NoRenounce.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Signatures} from "../Signatures.sol";
import {ERC8183} from "../vendor/erc8183/ERC8183.sol";
import {IERC8004Reputation} from "../vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "./interfaces/ISidequestHolding.sol";
import {ISidequestEvaluator} from "./interfaces/ISidequestEvaluator.sol";

/// @title SidequestEvaluator
/// @notice The evaluator of every Sidequest v1 job (ADR-0011; the full contract is in `ISidequestEvaluator`). Forked
///         from the legacy `JobsEvaluator` without contests. The windows, approver and arbitrator are each listing's
///         own (`holding.termsOf`). Every terminal path records the outcome and any slash before it touches a bond or
///         the core (M1), pays the worker through `_payWorker` (M2), and decides a job at most once.
contract SidequestEvaluator is ISidequestEvaluator, EIP712, NoRenounce, ReentrancyGuardTransient {
    bytes32 public constant EVIDENCE_TYPEHASH = keccak256(
        "EvidenceAttestation(uint256 jobId,bytes32 submissionHash,bytes32 policyHash,bytes32 repo,bytes32 headSha,bytes32 testedSha,bytes32 checkRunsHash,uint8 conclusion,uint256 validUntil)"
    );
    bytes32 public constant RULING_TYPEHASH = keccak256(
        "Ruling(uint256 jobId,bool forWorker,bool slashLoser,bytes32 reasonHash,uint256 deadline,uint256 nonce)"
    );
    /// @dev Upper bound for the ERC-8004 feedback call. Monad charges the gas limit, so this is also a cost cap.
    uint256 public constant FEEDBACK_GAS = 400_000;
    /// @dev Upper bound for each `core.complete` / `core.reject` a decision makes (C9-001). A token or worker hook that
    ///      needs more is not starved: the payout routes through Holding instead (M2).
    uint256 public constant CORE_GAS = 300_000;
    /// @dev What `_feedback` needs left: its budget under the 63/64 rule, plus the job read, the cold registry access
    ///      (10,100 on Monad) and the event.
    uint256 private constant FEEDBACK_RESERVE = FEEDBACK_GAS * 64 / 63 + 40_000;
    /// @dev The bookkeeping after a failed core call: the pause read, the flag, the event.
    uint256 private constant DEFER_RESERVE = 30_000;

    ERC8183 public immutable core;
    ISidequestHolding public immutable holding;
    IERC8004Reputation public immutable reputation;

    mapping(uint256 jobId => Case) internal _cases;
    mapping(address arbitrator => mapping(uint256 nonce => bool)) public rulingNonceUsed;
    mapping(uint256 jobId => mapping(address verifier => Evidence)) public evidence;
    mapping(address verifier => bool) public verifiers;
    mapping(address verifier => mapping(bytes32 digest => bool)) public usedDigest;
    /// @dev Every core pause observed here (`notePause`), oldest first, never overwritten (C9-007): a delivery deadline
    ///      inside any of them is never slashed (C9 ACL-2). `end == 0` while the pause is open.
    PauseInterval[] internal _pauses;

    constructor(ERC8183 core_, ISidequestHolding holding_, IERC8004Reputation reputation_)
        EIP712("SidequestEvaluator", "1")
        Ownable(msg.sender)
    {
        if (address(core_) == address(0) || address(holding_) == address(0)) revert ZeroAddress();
        core = core_;
        holding = holding_;
        reputation = reputation_;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Parties
    // ---------------------------------------------------------------------------------------------

    function accept(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (t.approver != msg.sender) revert NotApprover();
        Case storage c = _cases[jobId];
        _requireOpen(jobId, t, c);
        if (c.disputedAt != 0) revert DisputeOpen();
        c.outcome = Outcome.Accepted;
        emit Accepted(jobId, msg.sender);
        holding.returnBonds(jobId);
        _payWorker(jobId, "accepted");
        _feedback(jobId, 1, "completed");
    }

    function reject(uint256 jobId, Violation violation, bytes32 reasonHash) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (t.approver != msg.sender) revert NotApprover();
        Case storage c = _cases[jobId];
        uint48 submittedAt = _requireOpen(jobId, t, c);
        if (c.rejectedAt != 0) revert AlreadyRejected();
        if (submittedAt > t.deliveryDeadline) revert LateSubmission();
        // The review window closes on its own: once silence has become acceptance, a late rejection must not be able
        // to race the permissionless `completeAfterSilence` (R16-01).
        if (block.timestamp > uint256(submittedAt) + t.reviewWindow) revert ReviewWindowClosed();
        c.rejectedAt = uint48(block.timestamp);
        c.violation = violation;
        c.rejectionReason = reasonHash;
        emit Rejected(jobId, msg.sender, violation, reasonHash);
    }

    function dispute(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (t.worker != msg.sender || msg.sender == address(0)) revert NotProvider();
        Case storage c = _cases[jobId];
        _requireOpen(jobId, t, c);
        uint48 at = c.rejectedAt;
        if (at == 0) revert NotRejected();
        if (c.disputedAt != 0) revert AlreadyDisputed();
        if (block.timestamp > uint256(at) + t.disputeWindow) revert WindowClosed();
        c.disputedAt = uint48(block.timestamp);
        emit Disputed(jobId, msg.sender);
    }

    function rule(uint256 jobId, bool forWorker, bool slashLoser, bytes32 reasonHash) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (msg.sender != t.arbitrator || msg.sender == address(0)) revert NotArbitrator();
        _rule(jobId, t, forWorker, slashLoser, reasonHash);
    }

    function ruleWithSignature(Ruling calldata r, bytes calldata sig) external nonReentrant {
        if (block.timestamp > r.deadline) revert RulingExpired();
        ISidequestHolding.Terms memory t = holding.termsOf(r.jobId);
        if (rulingNonceUsed[t.arbitrator][r.nonce]) revert RulingNonceUsed();
        if (!Signatures.isValid(t.arbitrator, rulingDigest(r), sig)) revert InvalidSignature();
        rulingNonceUsed[t.arbitrator][r.nonce] = true;
        _rule(r.jobId, t, r.forWorker, r.slashLoser, r.reasonHash);
    }

    function rulingDigest(Ruling calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(RULING_TYPEHASH, r.jobId, r.forWorker, r.slashLoser, r.reasonHash, r.deadline, r.nonce)
            )
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------------------------------

    function attachEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes calldata sig)
        external
        nonReentrant
    {
        if (!verifiers[verifier]) revert NotVerifier();
        bytes32 digest = _evidenceDigest(a);
        if (!Signatures.isValid(verifier, digest, sig)) revert InvalidSignature();
        _storeEvidence(jobId, a, verifier, digest);
    }

    function attachEvidenceDirect(uint256 jobId, EvidenceAttestation calldata a) external nonReentrant {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _storeEvidence(jobId, a, msg.sender, _evidenceDigest(a));
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ---------------------------------------------------------------------------------------------

    function completeAfterSilence(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        uint48 submittedAt = _requireOpen(jobId, t, c);
        if (c.rejectedAt != 0) revert AlreadyRejected();
        if (submittedAt > t.deliveryDeadline) revert LateSubmission();
        if (block.timestamp <= uint256(submittedAt) + t.reviewWindow) revert WindowOpen();
        c.outcome = Outcome.Silence;
        emit TimedOut(jobId, "review-window");
        holding.returnBonds(jobId);
        _payWorker(jobId, "silence-is-acceptance");
        _feedback(jobId, 1, "completed");
    }

    function rejectAfterWindow(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        uint48 at = c.rejectedAt;
        if (at == 0) revert NotRejected();
        if (c.disputedAt != 0) revert AlreadyDisputed();
        if (block.timestamp <= uint256(at) + t.disputeWindow) revert WindowOpen();
        _requireOpen(jobId, t, c);
        Violation v = c.violation;
        c.outcome = Outcome.RejectionFinal;
        if (v != Violation.None) c.slashed = SlashedSide.Worker;
        emit TimedOut(jobId, "dispute-window");
        if (v != Violation.None) holding.burnBond(jobId, ISidequestHolding.Side.Worker);
        holding.returnBonds(jobId);
        _refundCreator(jobId, "rejection-undisputed", true);
        _feedback(jobId, 0, _rejectionTag(v));
    }

    function refundAfterArbitrationTimeout(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        // A ruling whose core call was deferred still stands: the timeout can never turn it into a refund.
        if (c.outcome != Outcome.None) revert AlreadyRuled();
        uint48 at = c.disputedAt;
        if (at == 0) revert NotDisputed();
        if (block.timestamp <= uint256(at) + t.arbitrationWindow) revert WindowOpen();
        _requireOpen(jobId, t, c);
        c.outcome = Outcome.ArbitrationTimeout;
        emit TimedOut(jobId, "arbitration-window");
        holding.returnBonds(jobId);
        _refundCreator(jobId, "arbitrator-inactive", false);
    }

    function rejectAfterDeliveryDeadline(uint256 jobId) external nonReentrant {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        if (c.outcome != Outcome.None) revert AlreadyResolved();
        if (t.funded == 0) revert NotFunded();
        // Nobody can deliver while the core is paused, so a missed delivery is not judged during a pause.
        if (core.paused()) revert CorePaused();
        _notePause();
        ERC8183.Job memory job = core.getJob(jobId);
        bool missed = job.status == ERC8183.JobStatus.Funded
            || (job.status == ERC8183.JobStatus.Submitted && job.submittedAt > t.deliveryDeadline);
        if (!missed) revert NotLate();
        if (block.timestamp <= t.deliveryDeadline) revert WindowOpen();
        // A deadline that fell inside a core pause still refunds the creator, but slashes nothing and records no
        // feedback: the worker could not submit (C9 ACL-2).
        bool excused = _excusedByPause(t.deliveryDeadline);
        c.outcome = Outcome.DeliveryMissed;
        if (!excused) c.slashed = SlashedSide.Worker;
        emit TimedOut(jobId, "delivery-deadline");
        if (!excused) holding.burnBond(jobId, ISidequestHolding.Side.Worker);
        holding.returnBonds(jobId);
        _refundCreator(jobId, "not-delivered", !excused);
        if (!excused) _feedback(jobId, 0, "not-delivered");
    }

    /// @notice Finishes a decision whose core call was deferred (C9-003): a recorded refund outcome, or a worker-side
    ///         outcome whose payout was deferred, while the core job is still Funded or Submitted. `core.reject` moves
    ///         the reward to Holding (and closes any pending milestone claim); `settle` then pays it under the
    ///         recorded outcome: a deferred worker payout stays the worker's (`earnedByWorker`), so this can never
    ///         turn Accepted, Silence or RuledForWorker into a refund. Redoes no outcome, slash, bond or feedback.
    function retryDeferred(uint256 jobId) external nonReentrant {
        Case storage c = _cases[jobId];
        Outcome o = c.outcome;
        if (o == Outcome.None) revert NotResolved();
        bool workerSide = o == Outcome.Accepted || o == Outcome.Silence || o == Outcome.RuledForWorker;
        if (workerSide && !c.payoutDeferred) revert NothingDeferred();
        ERC8183.JobStatus status = core.getJob(jobId).status;
        if (status != ERC8183.JobStatus.Funded && status != ERC8183.JobStatus.Submitted) revert NothingDeferred();
        emit DeferredRetried(jobId);
        core.reject(jobId, workerSide ? bytes32("payout-deferred") : bytes32("refund-retried"), "");
    }

    /// @notice Records the core's pause state: anyone, any time (the Safe batches it with `pause`/`unpause`; a worker
    ///         whose `submit` hits the pause calls it). Each pause is appended and kept.
    function notePause() external {
        _notePause();
    }

    function pausedSince() external view returns (uint48) {
        uint256 n = _pauses.length;
        if (n == 0) return 0;
        PauseInterval memory p = _pauses[n - 1];
        return p.end == 0 ? p.start : 0;
    }

    function pauseCount() external view returns (uint256) {
        return _pauses.length;
    }

    function pauseAt(uint256 i) external view returns (PauseInterval memory) {
        return _pauses[i];
    }

    /// @notice An arbitrator burns one of its own ruling nonces, revoking a signed ruling not yet relayed (C9 SIG-2).
    function cancelRuling(uint256 nonce) external {
        if (rulingNonceUsed[msg.sender][nonce]) revert RulingNonceUsed();
        rulingNonceUsed[msg.sender][nonce] = true;
        emit RulingCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------------------------------------
    // Views read by Holding's settle
    // ---------------------------------------------------------------------------------------------

    function earnedByWorker(uint256 jobId) external view returns (bool) {
        Case memory c = _cases[jobId];
        if (c.payoutDeferred) return true;
        if (c.outcome != Outcome.None) {
            return c.outcome == Outcome.Accepted || c.outcome == Outcome.Silence || c.outcome == Outcome.RuledForWorker;
        }
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (t.funded == 0 || c.rejectedAt != 0) return false;
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if (submittedAt == 0 || submittedAt > t.deliveryDeadline) return false;
        return block.timestamp > uint256(submittedAt) + t.reviewWindow;
    }

    function workerPenaltyDue(uint256 jobId) external view returns (bool) {
        Case memory c = _cases[jobId];
        if (c.outcome != Outcome.None) return c.slashed == SlashedSide.Worker;
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (t.funded == 0) return false;
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if ((submittedAt == 0 || submittedAt > t.deliveryDeadline) && block.timestamp > t.deliveryDeadline) {
            return !core.paused() && !_excusedByPause(t.deliveryDeadline);
        }
        return c.rejectedAt != 0 && c.disputedAt == 0 && c.violation != Violation.None
            && block.timestamp > uint256(c.rejectedAt) + t.disputeWindow;
    }

    function creatorPenaltyDue(uint256 jobId) external view returns (bool) {
        return _cases[jobId].slashed == SlashedSide.Creator;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function caseOf(uint256 jobId) external view returns (Case memory) {
        return _cases[jobId];
    }

    function rejectedAt(uint256 jobId) external view returns (uint48) {
        return _cases[jobId].rejectedAt;
    }

    function disputedAt(uint256 jobId) external view returns (uint48) {
        return _cases[jobId].disputedAt;
    }

    function violationOf(uint256 jobId) external view returns (Violation) {
        return _cases[jobId].violation;
    }

    function rejectionReasonOf(uint256 jobId) external view returns (bytes32) {
        return _cases[jobId].rejectionReason;
    }

    function outcome(uint256 jobId) external view returns (Outcome) {
        return _cases[jobId].outcome;
    }

    function slashed(uint256 jobId) external view returns (SlashedSide) {
        return _cases[jobId].slashed;
    }

    function payoutDeferred(uint256 jobId) external view returns (bool) {
        return _cases[jobId].payoutDeferred;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev A job still waiting on a decision: no outcome, the core job Submitted, and funded by Holding.
    function _requireOpen(uint256 jobId, ISidequestHolding.Terms memory t, Case storage c)
        private
        view
        returns (uint48 submittedAt)
    {
        if (c.outcome != Outcome.None) revert AlreadyResolved();
        ERC8183.Job memory job = core.getJob(jobId);
        if (job.status != ERC8183.JobStatus.Submitted) revert NotSubmitted();
        if (t.funded == 0) revert NeverFunded();
        return job.submittedAt;
    }

    /// @dev M1: checks, then the outcome and the slash are recorded and emitted, then the loser's bond is slashed to the vault's recipient and the
    ///      rest are released, and only then does the core move the reward.
    function _rule(uint256 jobId, ISidequestHolding.Terms memory t, bool forWorker, bool slashLoser, bytes32 reasonHash)
        private
    {
        Case storage c = _cases[jobId];
        if (c.outcome != Outcome.None) revert AlreadyRuled();
        uint48 at = c.disputedAt;
        if (at == 0) revert NotDisputed();
        // Strict cutoff: after the arbitration window only `refundAfterArbitrationTimeout` may settle (R16-01).
        if (block.timestamp > uint256(at) + t.arbitrationWindow) revert ArbitrationWindowClosed();
        _requireOpen(jobId, t, c);
        Violation v = c.violation;
        // Upholding a violation needs a rejection that named one.
        if (!forWorker && slashLoser && v == Violation.None) revert InvalidRuling();

        c.outcome = forWorker ? Outcome.RuledForWorker : Outcome.RuledForCreator;
        if (slashLoser) c.slashed = forWorker ? SlashedSide.Creator : SlashedSide.Worker;
        emit Ruled(jobId, t.arbitrator, forWorker, slashLoser, reasonHash);
        if (slashLoser) {
            holding.burnBond(jobId, forWorker ? ISidequestHolding.Side.Creator : ISidequestHolding.Side.Worker);
        }
        holding.returnBonds(jobId);
        if (forWorker) {
            _payWorker(jobId, "ruled-for-worker");
            _feedback(jobId, 1, "completed");
        } else {
            _refundCreator(jobId, "ruled-for-creator", true);
            _feedback(jobId, 0, slashLoser ? _rejectionTag(v) : "rejected");
        }
    }

    /// @dev M2. A failed `complete` (a refusing or gas-burning token, a worker hook, a paused core, a core that started
    ///      charging fees) defers the payout instead of blocking the decision: the reward reaches Holding through
    ///      `reject` now if gas allows, else through `retryDeferred` or the core's `claimRefund`, and Holding's `settle`
    ///      pays the worker because `earnedByWorker` stays true. The core call is capped at `CORE_GAS` and the caller
    ///      must leave room for it, the bookkeeping and the feedback (C9-001), so neither a starved nor a gas-burning
    ///      call can roll the decision back. The revert data is never copied.
    function _payWorker(uint256 jobId, bytes32 reason) private {
        // Holding funded `net` and keeps the fee; core fees would cut the worker again and strand the evaluator's
        // share here, so the payout goes through Holding instead (C9 ACL-5).
        bool coreCharges = core.platformFeeBP() != 0 || core.evaluatorFeeBP() != 0;
        _requireCoreGas(true);
        if (!coreCharges) {
            try core.complete{gas: CORE_GAS}(jobId, reason, "") {
                return;
            } catch {}
        }
        _cases[jobId].payoutDeferred = true;
        bool refunded = false;
        // Opportunistic: whatever gas is spare beyond the feedback's reserve. A starved or refused `reject` loses
        // nothing; the job waits for `retryDeferred`.
        uint256 spare = gasleft();
        if (spare > FEEDBACK_RESERVE + DEFER_RESERVE + 100_000 && !core.paused()) {
            uint256 budget = Math.min(CORE_GAS, spare - FEEDBACK_RESERVE - DEFER_RESERVE);
            try core.reject{gas: budget}(jobId, "payout-deferred", "") {
                refunded = true;
            } catch {}
        }
        emit PayoutDeferred(jobId, refunded);
    }

    /// @dev The refund side of M2: a failed `reject` (a refusing token, a paused core) leaves the reward in the core
    ///      until `retryDeferred` or its `claimRefund`; the recorded outcome already decides where Holding sends it.
    function _refundCreator(uint256 jobId, bytes32 reason, bool feedbackAfter) private {
        _requireCoreGas(feedbackAfter);
        try core.reject{gas: CORE_GAS}(jobId, reason, "") {}
        catch {
            emit RefundDeferred(jobId);
        }
    }

    /// @dev Refuses a call that cannot give the core its full `CORE_GAS` and still finish (C9-001): a starved core call
    ///      must never look like a refusing token.
    function _requireCoreGas(bool feedbackAfter) private view {
        uint256 needed = CORE_GAS * 64 / 63 + DEFER_RESERVE + (feedbackAfter ? FEEDBACK_RESERVE : 0);
        if (gasleft() < needed) revert CoreGasTooLow(gasleft(), needed);
    }

    function _notePause() private {
        bool paused = core.paused();
        uint256 n = _pauses.length;
        bool open = n != 0 && _pauses[n - 1].end == 0;
        if (paused && !open) {
            _pauses.push(PauseInterval(uint48(block.timestamp), 0));
            emit CorePauseNoted(block.timestamp);
        } else if (!paused && open) {
            PauseInterval storage p = _pauses[n - 1];
            p.end = uint48(block.timestamp);
            emit CorePauseEnded(p.start, block.timestamp);
        }
    }

    /// @dev Whether `deadline` fell inside any observed core pause (an unobserved end counts as still paused). The
    ///      intervals are appended in time order and never overlap, so the last one starting at or before `deadline`
    ///      decides; binary search keeps the lookup logarithmic.
    function _excusedByPause(uint256 deadline) private view returns (bool) {
        uint256 lo;
        uint256 hi = _pauses.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_pauses[mid].start <= deadline) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return false;
        PauseInterval memory p = _pauses[lo - 1];
        return p.end == 0 || deadline <= p.end;
    }

    function _rejectionTag(Violation v) private pure returns (string memory) {
        if (v == Violation.Quality) return "rejected-quality";
        if (v == Violation.Falsified) return "rejected-falsified";
        return "rejected";
    }

    function _evidenceDigest(EvidenceAttestation calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    EVIDENCE_TYPEHASH,
                    a.jobId,
                    a.submissionHash,
                    a.policyHash,
                    a.repo,
                    a.headSha,
                    a.testedSha,
                    a.checkRunsHash,
                    a.conclusion,
                    a.validUntil
                )
            )
        );
    }

    function _storeEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes32 digest) private {
        ISidequestHolding.Terms memory t = holding.termsOf(jobId);
        if (a.jobId != jobId || t.creator == address(0)) revert EvidenceJobMismatch();
        if (a.policyHash != t.policyHash) revert EvidencePolicyMismatch();
        if (block.timestamp > a.validUntil) revert EvidenceExpired();
        // Same verifier, same statement: acknowledged once, never a second endorsement (R16-06).
        if (usedDigest[verifier][digest]) return;
        // An expiry storage cannot hold is refused, so storage and the event always agree (C9 MATH-3, C9-005); a
        // statement that expires sooner than the stored one is older and cannot replace it (C9 SIG-1).
        uint48 validUntil = SafeCast.toUint48(a.validUntil);
        if (validUntil < evidence[jobId][verifier].validUntil) revert StaleEvidence();
        usedDigest[verifier][digest] = true;
        evidence[jobId][verifier] = Evidence({
            digest: digest,
            submissionHash: a.submissionHash,
            policyHash: a.policyHash,
            testedSha: a.testedSha,
            at: uint48(block.timestamp),
            validUntil: validUntil,
            conclusion: a.conclusion
        });
        emit EvidenceAttached(
            jobId, verifier, digest, a.submissionHash, a.policyHash, a.testedSha, a.conclusion, a.validUntil
        );
    }

    /// @dev Reason-aware ERC-8004 feedback for the worker's agent, as the client of record. Best effort (C9-001): a
    ///      registry failure or a missing budget is observable (`FeedbackFailed`) and never undoes a decision (R16-10).
    ///      The core call before it already refused a call without `FEEDBACK_RESERVE` left, so an honest caller cannot
    ///      skip it. At most 32 bytes of revert data are copied (C9 GEN-6).
    function _feedback(uint256 jobId, int128 value, string memory tag) private {
        if (address(reputation) == address(0)) return;
        uint256 agentId = core.getJob(jobId).providerAgentId;
        if (agentId == 0) return;
        if (gasleft() < FEEDBACK_GAS * 64 / 63 + 15_000) {
            emit FeedbackFailed(jobId, agentId, "gas");
            return;
        }
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(agentId, value, 0, "sidequest", tag, "", "", bytes32(jobId)) {
            emit FeedbackRecorded(jobId, agentId, value, tag);
        } catch {
            bytes memory reason;
            assembly ("memory-safe") {
                let n := returndatasize()
                if gt(n, 32) { n := 32 }
                reason := mload(0x40)
                mstore(reason, n)
                returndatacopy(add(reason, 0x20), 0, n)
                mstore(0x40, add(reason, 0x40))
            }
            emit FeedbackFailed(jobId, agentId, reason);
        }
    }
}
