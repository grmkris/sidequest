# Sidequest v1 — signatures, access control, and DoS review

Scope: `contracts/src/sidequest/**`, the vendored ERC-8183 core and authorization
entry points, `contracts/src/Signatures.sol`, and the production wiring in
`contracts/script/SidequestRecipe.sol`. Reviewed at the current `dev` source
(`f99c6a968bb1abd0f2193cf7f8a96340f0fd792e`). This was a read-only review; no
onchain transaction or repository change was made.

## Result

No new unprivileged signature replay, authorization bypass, or terminal-state
DoS was reproduced. Six additional isolated Foundry probes confirmed two
cross-chain signature refusals and four privileged/operational behaviors below.
The main controls are sound:

- `Signatures.isValid` rejects zero signers and uses OpenZeppelin ECDSA (including
  low-`s` checks) before ERC-1271. The three EIP-712 domains include chain ID and
  verifying contract through OpenZeppelin's dynamic domain separator.
- Selection signatures bind job, worker, agent, terms, activation cutoff, and a
  creator-scoped nonce; activation also requires `msg.sender == sel.worker` and
  the live ERC-8004 wallet. Ruling signatures bind the job and deadline and use a
  nonce namespace keyed by the listing's arbitrator. Evidence binds job/policy,
  expiry, and verifier identity; repeated digests are idempotent and stale
  attestations are rejected.
- ERC-8183 authorization signatures include the signer in every struct, all
  action arguments, a deadline, and a packed signer/nonce key. The nonce is
  marked before the external action (with transaction rollback on failure).
- Core calls and payout pushes have explicit gas budgets and reserve checks;
  worker-side payout failures become a recorded deferred outcome and can be
  completed through `retryDeferred`/expiry. Payout transfer return data is
  capped at 32 bytes. Pause history lookup is binary-search based.
- Core lifecycle authorization is checked against the stored client/provider/
  evaluator, and Holding evaluator-only bond operations are guarded by the
  immutable configured evaluator. Focused regressions passed (14 tests covering
  relayed rulings, nonce cancellation/replay, evidence freshness, paused-core
  deferral, pause boundaries, and re-entry).
- The dedicated `test/Signatures.t.sol` suite also passed **3/3**: ERC-1271
  fallback/refusals, malleable/invalid recovery refusal, and raw ECDSA signatures
  both before and after EIP-7702 delegation.

## Residual finding AUTH-DOS-01 — pause observation is an operational security invariant

**Severity:** Medium (privileged/operational; no arbitrary caller can create the
pause)

**Location:** `SidequestEvaluator.rejectAfterDeliveryDeadline` lines 210–232 and
`_notePause`/`_excusedByPause` lines 448–474; core `ERC8183.pause` lines 256–259.

The evaluator can excuse a missed delivery only for pauses present in its own
append-only history. `core.pause()` does not notify the evaluator. If the Safe
pauses the core and fails to include `evaluator.notePause()` in the same
transaction, then unpauses, and a worker's delivery deadline falls during the
unrecorded interval, the first permissionless
`rejectAfterDeliveryDeadline(jobId)` call records `DeliveryMissed` and burns the
worker bond. At that point the pause is no longer observable (`core.paused()` is
false), so `_notePause()` cannot reconstruct the interval.

Reproduction (fork/unit setup): publish and activate a funded job; call only
`core.pause()`; advance across `deliveryDeadline`; call `core.unpause()`; then
call `evaluator.rejectAfterDeliveryDeadline(jobId)`. Without an earlier
`notePause`, `_excusedByPause` returns false and `holding.burnBond` executes.

This is already stated as a runbook requirement (pause and `notePause` must be
batched), but the contract does not enforce it. Keep the requirement as a
production launch/incident gate and monitor for every `Paused` event without a
same-block `CorePauseNoted`. A future redeploy could make the core pause wrapper
notify the evaluator or persist pause intervals in the core itself.

The inverse also occurs if the Safe records the start but omits `notePause` on
unpause: the interval remains open until the first later observer. A deadline
after the actual unpause is falsely excused if the first observer is its
`rejectAfterDeliveryDeadline` caller. Both directions are covered by the
isolated passing probe. Both pause and unpause must be paired atomically with
the evaluator observation.

## Residual finding AUTH-DOS-02 — fee treasury can be configured to the Holding

**Severity:** Low (owner/Safe configuration; causes listing liveness failure)

**Location:** `FeeSchedule._validate` lines 92–100 and
`SidequestHolding._settleBond` lines 446–475.

Fee schedule proposals reject only a zero treasury. The owner can therefore
queue and execute a schedule whose treasury is `address(holding)`. When an
unactivated listing reaches the cancel/expiry-forfeit path,
`_settleBond` reads that live treasury and explicitly reverts
`InvalidForfeitTreasury` for the Holding address. The listing's bond and reward
then remain unsettled until the Safe repairs the schedule (which itself has the
fee timelock); repeated settle calls continue to revert.

Reproduction: publish an unactivated listing; owner proposes a schedule with
`treasury = address(holding)`; wait `FeeSchedule.DELAY` and execute; call
`holding.cancel(jobId)` after `CANCEL_GRACE` (or settle an expired listing).
`InvalidForfeitTreasury` is raised at the guard in `_settleBond`. Restore a valid
treasury and the same listing can settle.

The production config uses the Safe, and this is a trusted-admin/misconfiguration
risk rather than an external privilege escalation. Keep the launch gate checking
the live treasury against the Holding and consider a redeploy-time invariant or
an owner-side setter guard that rejects known settlement contracts.

## Residual finding AUTH-DOS-03 — a core pause consumes the creator's cancellation grace

**Severity:** Medium (existing finding R2 in `docs/mainnet-gate-findings.md`;
triggered by privileged core pause)

**Location:** `SidequestHolding.cancel` lines 221–228,
`SidequestHolding._settleBond` lines 446–475, and core
`ERC8183.reject` line 641.

The evaluator's pause history excuses delivery penalties, but it is not used
by the unfilled-listing forfeit calculation. A creator who publishes and then
tries to cancel within the 600-second grace while the core is paused cannot
cancel; `core.reject` reverts `whenNotPaused`. If the pause ends after the grace,
the same cancellation succeeds but charges the snapshotted 25% bond forfeit to
the treasury. This occurs even when both pause observations were correctly
recorded. The isolated probe demonstrates the exact 25% stake reduction.

Recommendation: explicitly retain this known risk in release disclosure and
incident procedures. A future Holding version needs a pause-aware cancellation
grace or another way to preserve an attempted timely cancellation. The existing
immutable Holding cannot be corrected by a hosted UI release.

## Reproduction evidence

- Isolated project: `/tmp/sidequest-prod-review-20261017/auth-dos-probe/`.
- Probe source: `test/sidequest/AuthDosProbe.t.sol` beneath that project.
- Result: `/tmp/sidequest-prod-review-20261017/auth-dos-probe.log` — **6 passed,
  0 failed, 0 skipped**.
- Command: `cd /tmp/sidequest-prod-review-20261017/auth-dos-probe && heavy forge
  test --match-contract AuthDosProbe`.
- Source was copied from the reviewed repository; dependency libraries were
  linked read-only. No RPC or deployed-chain test was used. Thus these are local
  reproducible behaviors, not proof of an incident or exploit on production.

## Checklist notes

- No raw `ecrecover` use; no high-`s` or zero-address acceptance was found.
- No missing chain ID/verifying-contract domain field was found in the reviewed
  EIP-712 paths; cached domains use OpenZeppelin's fork-aware implementation.
- No user-growable array is iterated in a settlement path. The pause array is
  append-only but all lookups are logarithmic; `batchDetachHook` is owner-only.
- Arbitrary reward tokens can still refuse transfers or blacklist the Holding;
  this is the documented permissionless-token trust boundary. The M2 deferred
  route handles refusal of worker/treasury pushes, but a token that permanently
  rejects transfers to the Holding can strand that token's own escrow.

