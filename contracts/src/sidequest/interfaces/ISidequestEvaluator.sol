// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC8183} from "../../vendor/erc8183/ERC8183.sol";
import {IERC8004Reputation} from "../../vendor/erc8004/IERC8004.sol";
import {ISidequestHolding} from "./ISidequestHolding.sol";

/// @title ISidequestEvaluator
/// @notice The evaluator of every Sidequest v1 job (ADR-0011), forked from the legacy `JobsEvaluator` without
///         contests. It only ever makes terminal calls on the core. The windows, the approver and the arbitrator are
///         the listing's own, read from `ISidequestHolding.termsOf`.
///
///         Lifecycle: the approver accepts or, within the review window, rejects a timely submission naming a
///         violation; the worker may dispute within the dispute window; the listing's arbitrator rules within the
///         arbitration window, directly or by an EIP-712 `Ruling` anyone relays (nonces are per arbitrator). Silence
///         after a timely submission is acceptance; every timeout is permissionless.
///
///         M1 (ruling order). Every terminal path runs: checks → record `outcome` and `slashed` → emit → slash the
///         loser's bond before expiry (release at or after expiry) → release the other bonds → core call → feedback. A hostile reward token that re-enters
///         `ISidequestHolding.settle` during the core call finds the bonds already settled.
///
///         M2 (`_payWorker`). Accept, silence and a ruling for the worker try `core.complete`. If it fails (a token
///         that refuses the worker, or a starved call), the evaluator sets `payoutDeferred`, emits `PayoutDeferred`,
///         and tries `core.reject("payout-deferred")` so the reward lands in Holding; if that fails too, the core's
///         permissionless `claimRefund` brings it there later. Either way `earnedByWorker` stays true, so Holding's
///         `settle` pays the worker or records the amount as owed: gas starvation changes only the route. A ruling for
///         the creator tries `core.reject` the same way (`RefundDeferred`). A paused core reverts instead.
///
///         Once an `outcome` is recorded the job is decided: every other terminal path reverts (`AlreadyResolved`),
///         and the arbitration timeout reverts `AlreadyRuled`.
///
///         EIP-712 domain ("SidequestEvaluator", "1"); `Ruling` and `EvidenceAttestation` keep the legacy type strings.
///
///         The implementation is `Ownable2Step` (owner: the Safe); the ownership functions come from OpenZeppelin.
interface ISidequestEvaluator {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum Violation {
        None,
        Quality,
        Falsified
    }

    /// @notice How a job was decided. `None` until a terminal path runs.
    enum Outcome {
        None,
        /// @dev The approver accepted.
        Accepted,
        /// @dev The review window passed with no decision on a timely submission.
        Silence,
        RuledForWorker,
        RuledForCreator,
        /// @dev A rejection nobody disputed within the dispute window.
        RejectionFinal,
        /// @dev The arbitrator did not rule in time: refund, no slash, no feedback.
        ArbitrationTimeout,
        /// @dev No timely submission by the delivery deadline.
        DeliveryMissed
    }

    /// @notice Which bond a finding penalizes. At most one side per job; Holding releases at or after `expiredAt`.
    enum SlashedSide {
        None,
        Creator,
        Worker
    }

    /// @notice The arbitrator's decision on a disputed job, signed off-chain by any harness and relayed by anyone.
    struct Ruling {
        uint256 jobId;
        bool forWorker;
        bool slashLoser;
        bytes32 reasonHash;
        uint256 deadline;
        uint256 nonce;
    }

    struct EvidenceAttestation {
        uint256 jobId;
        bytes32 submissionHash;
        bytes32 policyHash;
        bytes32 repo;
        bytes32 headSha;
        bytes32 testedSha;
        bytes32 checkRunsHash;
        uint8 conclusion;
        uint256 validUntil;
    }

    /// @notice One verifier's attestation for one job.
    struct Evidence {
        bytes32 digest;
        bytes32 submissionHash;
        bytes32 policyHash;
        bytes32 testedSha;
        uint48 at;
        uint48 validUntil;
        uint8 conclusion;
    }

    /// @notice One observed core pause; `end` is zero while it is open.
    struct PauseInterval {
        uint48 start;
        uint48 end;
    }

    /// @notice A job's dispute state in one read.
    struct Case {
        uint48 rejectedAt;
        uint48 disputedAt;
        Violation violation;
        Outcome outcome;
        SlashedSide slashed;
        bool payoutDeferred;
        bytes32 rejectionReason;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event Accepted(uint256 indexed jobId, address indexed approver);
    event Rejected(uint256 indexed jobId, address indexed approver, Violation violation, bytes32 reasonHash);
    event Disputed(uint256 indexed jobId, address indexed worker);
    event Ruled(uint256 indexed jobId, address indexed arbitrator, bool forWorker, bool slashLoser, bytes32 reasonHash);
    event TimedOut(uint256 indexed jobId, bytes32 reason);
    /// @notice `core.complete` failed or was skipped (M2). `refundedToHolding` says whether `core.reject` then moved the
    ///         reward into Holding; if not, `retryDeferred` (or the core's `claimRefund`) will. The worker is paid
    ///         through `ISidequestHolding.settle`.
    event PayoutDeferred(uint256 indexed jobId, bool refundedToHolding);
    /// @notice `core.reject` failed on a refund outcome; `retryDeferred` (or the core's `claimRefund`) refunds later.
    event RefundDeferred(uint256 indexed jobId);
    event DeferredRetried(uint256 indexed jobId);
    event CorePauseNoted(uint256 since);
    event CorePauseEnded(uint256 start, uint256 end);
    event RulingCancelled(address indexed arbitrator, uint256 nonce);
    event EvidenceAttached(
        uint256 indexed jobId,
        address indexed verifier,
        bytes32 digest,
        bytes32 submissionHash,
        bytes32 policyHash,
        bytes32 testedSha,
        uint8 conclusion,
        uint256 validUntil
    );
    event VerifierSet(address indexed verifier, bool allowed);
    event FeedbackRecorded(uint256 indexed jobId, uint256 indexed agentId, int128 value, string tag);
    event FeedbackFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error NotApprover();
    error NotProvider();
    error NotArbitrator();
    error NotVerifier();
    error NotSubmitted();
    error NotFunded();
    error NeverFunded();
    error AlreadyRejected();
    error NotRejected();
    error AlreadyDisputed();
    error NotDisputed();
    error WindowClosed();
    error WindowOpen();
    error ReviewWindowClosed();
    error ArbitrationWindowClosed();
    error DisputeOpen();
    error LateSubmission();
    error NotLate();
    error InvalidRuling();
    error RulingExpired();
    error RulingNonceUsed();
    error InvalidSignature();
    /// @dev The dispute already has a ruling.
    error AlreadyRuled();
    /// @dev The job already has an outcome.
    error AlreadyResolved();
    /// @dev A missed delivery is not judged while the core is paused.
    error CorePaused();
    error EvidenceExpired();
    error EvidenceJobMismatch();
    error EvidencePolicyMismatch();
    /// @dev An older statement (sooner expiry) cannot replace the stored one.
    error StaleEvidence();
    /// @dev The transaction's gas cannot cover the core call's full budget plus what follows it.
    error CoreGasTooLow(uint256 left, uint256 needed);
    error NotResolved();
    error NothingDeferred();

    // ---------------------------------------------------------------------------------------------
    // Parties
    // ---------------------------------------------------------------------------------------------

    /// @notice The listing's approver accepts the submission: bonds back, the worker paid (`_payWorker`). Refused once
    ///         the worker has disputed (R114-02). A late submission may be accepted until the missed-delivery slash.
    function accept(uint256 jobId) external;

    /// @notice The listing's approver rejects a timely submission within its review window, naming a violation.
    ///         Nothing moves; the dispute window opens.
    function reject(uint256 jobId, Violation violation, bytes32 reasonHash) external;

    /// @notice The worker (the core provider) disputes a rejection within the dispute window.
    function dispute(uint256 jobId) external;

    /// @notice The listing's arbitrator rules within the arbitration window: who gets the reward, and whether the
    ///         loser broke a slashable obligation (for the worker: a bad-faith rejection slashes the creator bond to the vault's recipient; for the
    ///         creator: the named violation is upheld and the worker bond is penalized, which needs a named violation).
    ///         Holding slashes only before `expiredAt`; at or after expiry it releases even a penalized bond.
    function rule(uint256 jobId, bool forWorker, bool slashLoser, bytes32 reasonHash) external;

    /// @notice The same ruling, signed by the listing's arbitrator and relayed by anyone, under the same cutoff.
    function ruleWithSignature(Ruling calldata r, bytes calldata sig) external;

    // ---------------------------------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------------------------------

    /// @notice A registered verifier's signed statement about the named checks of the tested commit. Stored and
    ///         emitted; moves no money.
    function attachEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes calldata sig)
        external;

    /// @notice The same, from a verifier contract calling directly (the CRE receiver).
    function attachEvidenceDirect(uint256 jobId, EvidenceAttestation calldata a) external;

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ---------------------------------------------------------------------------------------------

    /// @notice A timely submission with no decision within the review window: silence is acceptance.
    function completeAfterSilence(uint256 jobId) external;

    /// @notice A rejection nobody disputed within the dispute window becomes final; a named violation records a worker
    ///         penalty. Resolve before `expiredAt` for a slash; Holding releases the bond at or after expiry.
    function rejectAfterWindow(uint256 jobId) external;

    /// @notice The arbitrator did not rule in time: refund, both bonds released, no feedback. Reverts `AlreadyRuled`
    ///         once a ruling exists, even if its core call was deferred.
    function refundAfterArbitrationTimeout(uint256 jobId) external;

    /// @notice A funded job with no timely submission, strictly after the delivery deadline: refund, the worker bond
    ///         penalized, the creator bond released. Resolve before `expiredAt` for the worker bond to slash to the vault's recipient; Holding
    ///         releases at or after expiry. Reverts `CorePaused` while the core is paused; a deadline inside the
    ///         observed pause (`notePause`) refunds without the penalty.
    function rejectAfterDeliveryDeadline(uint256 jobId) external;

    /// @notice Finishes a deferred core call under the recorded outcome (C9-003): refund outcomes, and worker outcomes
    ///         whose payout was deferred, while the core job is Funded or Submitted. Never turns a worker outcome into a
    ///         refund.
    function retryDeferred(uint256 jobId) external;

    /// @notice Records the core's pause state (start or end); permissionless.
    function notePause() external;

    /// @notice Revokes one of the caller's own signed rulings by burning its nonce.
    function cancelRuling(uint256 nonce) external;

    // ---------------------------------------------------------------------------------------------
    // Owner (the Safe)
    // ---------------------------------------------------------------------------------------------

    function setVerifier(address verifier, bool allowed) external;

    // ---------------------------------------------------------------------------------------------
    // Views read by Holding's settle
    // ---------------------------------------------------------------------------------------------

    /// @notice Whether the worker is owed the reward whatever the core did since: a deferred payout, an `Accepted`,
    ///         `Silence` or `RuledForWorker` outcome, or (with no outcome yet) a funded, timely, unrejected submission
    ///         whose review window has passed (R114-03).
    function earnedByWorker(uint256 jobId) external view returns (bool);

    /// @notice Whether a worker penalty finding exists: a penalizing ruling or final rejection, or (with no outcome
    ///         yet) a missed delivery past the deadline or an undisputed named violation past the dispute window.
    ///         This is not proof of a slash: Holding releases the bond at or after `expiredAt`.
    function workerPenaltyDue(uint256 jobId) external view returns (bool);

    /// @notice Whether a creator penalty finding exists: a ruling for the worker found the rejection in bad faith.
    ///         This is not proof of a slash: Holding releases the bond at or after `expiredAt`.
    function creatorPenaltyDue(uint256 jobId) external view returns (bool);

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function caseOf(uint256 jobId) external view returns (Case memory);
    function rejectedAt(uint256 jobId) external view returns (uint48);
    function disputedAt(uint256 jobId) external view returns (uint48);
    function violationOf(uint256 jobId) external view returns (Violation);
    function rejectionReasonOf(uint256 jobId) external view returns (bytes32);
    function outcome(uint256 jobId) external view returns (Outcome);
    function slashed(uint256 jobId) external view returns (SlashedSide);
    function payoutDeferred(uint256 jobId) external view returns (bool);

    /// @notice Ruling nonces spent by `ruleWithSignature`, per arbitrator.
    function rulingNonceUsed(address arbitrator, uint256 nonce) external view returns (bool);

    /// @notice The EIP-712 digest an arbitrator signs for `r` (domain "SidequestEvaluator", version "1").
    function rulingDigest(Ruling calldata r) external view returns (bytes32);

    function evidence(uint256 jobId, address verifier)
        external
        view
        returns (
            bytes32 digest,
            bytes32 submissionHash,
            bytes32 policyHash,
            bytes32 testedSha,
            uint48 at,
            uint48 validUntil,
            uint8 conclusion
        );
    function verifiers(address verifier) external view returns (bool);
    function usedDigest(address verifier, bytes32 digest) external view returns (bool);

    function core() external view returns (ERC8183);
    function holding() external view returns (ISidequestHolding);
    /// @notice ERC-8004 Reputation Registry; zero disables feedback.
    function reputation() external view returns (IERC8004Reputation);

    function RULING_TYPEHASH() external view returns (bytes32);
    function EVIDENCE_TYPEHASH() external view returns (bytes32);
    /// @notice The gas cap (and, on Monad, cost cap) of the ERC-8004 feedback call.
    function FEEDBACK_GAS() external view returns (uint256);
    function CORE_GAS() external view returns (uint256);
    /// @notice The start of the pause still open in the history, or zero (what `/admin` shows).
    function pausedSince() external view returns (uint48);
    /// @notice The observed core pauses, oldest first; none is ever removed.
    function pauseCount() external view returns (uint256);
    function pauseAt(uint256 i) external view returns (PauseInterval memory);
}
