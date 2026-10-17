# General and precision-math contract review

Review date: 2026-10-17. Source: `f99c6a968bb1abd0f2193cf7f8a96340f0fd792e` on `dev`.

## Result

No concrete exploitable finding was established in this review's general or precision-math scope. There is no Critical, High, Medium, or Low vulnerability entry with a reproducing PoC from this reviewer. This is a bounded source review, not a formal audit or a certification of the deployed bytecode.

No repository file was changed, no transaction was sent, and no GitHub issue was filed. The only files written by this reviewer are audit evidence under `/tmp/sidequest-prod-review-20261017/`.

## Checklists and scope

Applied:

- `evm-audit-general/references/checklist.md`: external calls, return data, forced balance changes, reentrancy, storage/memory state, loops, role combinations, time boundaries, deployment initialization, compiler hazards.
- `evm-audit-precision-math/references/checklist.md`: multiplication/division ordering, rounding direction, share accounting, downcasts, decimal units, fee arithmetic, special values and time arithmetic.

The fetched checklist files are `checklist-general.md` and `checklist-precision-math.md` in this evidence directory. Their upstream is `https://github.com/austintgriffith/evm-audit-skills`.

Primary source read:

- `contracts/src/sidequest/SidequestHolding.sol`
- `contracts/src/sidequest/SidequestEvaluator.sol`
- `contracts/src/sidequest/StakeVault.sol`
- `contracts/src/sidequest/FeeSchedule.sol`
- `contracts/src/sidequest/SidequestClocks.sol`
- `contracts/src/sidequest/SeedHelper.sol`
- `contracts/src/sidequest/AgentSweep.sol`
- `contracts/src/sidequest/NoRenounce.sol`
- `contracts/src/sidequest/interfaces/IStakeVault.sol`
- `contracts/src/sidequest/interfaces/ISidequestHolding.sol`
- `contracts/src/sidequest/interfaces/ISidequestEvaluator.sol`
- `contracts/src/Signatures.sol`
- `contracts/src/vendor/erc8183/ERC8183.sol`: initialization/admin surface, lifecycle, fee distribution, milestone claims and refund paths.
- `contracts/src/vendor/erc8183/ERC8183WithAuthorization.sol`: initialization, nonce representation, common verification and representative wrappers; signature-specialist coverage is separate.
- `contracts/script/SidequestRecipe.sol`: config loading/validation and deployment order.
- `contracts/script/SidequestVerify.sol`: live wiring, clocks, token, role and schedule checks.
- `contracts/script/SeedPoolRecipe.sol`: config units, repair-cap and liquidity math.
- `contracts/config/monad-mainnet.json`, `contracts/foundry.toml`, `contracts/SURFACE.md`, `docs/protocol.md`, `docs/adr/0010-permissionless-tokens.md`.

Supporting regression source inspected or mapped: `StakeVaultDelegation.t.sol`, `StakeVaultInvariants.t.sol`, `StakeVaultLedger.t.sol`, `Invariants.t.sol`, `FeeSchedule.t.sol`, `SidequestHolding.t.sol`, `SidequestEvaluator.t.sol`, `V1Activation.t.sol`, `V1ArbitraryTokens.t.sol`, `BondPolicy.t.sol`, `BondHorizon.t.sol`, `HorizonLateSlash.t.sol`, `Recipe.t.sol`, `SeedPoolMath.t.sol`, and `Signatures.t.sol`.

## Explicit no-finding conclusions

| Area | Source evidence and conclusion |
|---|---|
| Share accounting and donation inflation | `StakeVault` prices from its internal pool assets, not the token balance. Direct transfers do not alter prices. Deposits mint floor shares and reject zero; withdrawals burn the exact requested shares and return floor assets. The final shares receive the remaining assets. No profitable rounding cycle identified. |
| Share overflow after near-total slashes | `Math.mulDiv` covers products wider than 256 bits. Accepted pool shares are bounded to `uint192`, matching the exit queue representation; assets and reservations are bounded to `uint128`. The narrowing casts on released/slashed reservations consume amounts already bounded by those reservations. |
| Pool reset | Full slash/forfeit clears aggregate shares/queue and advances the generation. Position reads and the next mutation disregard earlier generations. No stale-position revival identified. |
| Reservation isolation | `_unreserve` caps consumption at `reservedBy[msg.sender][account]`; a second Holding cannot release or slash a first Holding's allocation. `withdraw` preserves enough pool assets for all reservations. |
| Fee precision | Activation and bonus fees use full-precision `Math.mulDiv(..., Ceil)`. Activation clamps a fee that would consume the whole reward to keep nonzero net funding; this is an explicit dust policy. Bonus fee cannot exceed bonus at the bounded fee rates. No unit mix between reward-token raw amounts and SIDE stake identified. |
| Aggregate arithmetic | `topUp` rejects bonus plus reward overflow. Paid-path worker and treasury amounts partition the reward and bonus; contributor refunds consume their own stored contribution once. |
| Bond forfeit arithmetic | Forfeit uses floor `amount * snapshotBps / 10000`, within the 5000-bps policy cap. The returned actual reservation consumption is deducted before the remainder is released. No double consumption or unintended token burn identified. |
| Deadline ordering | Listing expiry includes delivery, review, dispute, arbitration and margin, and is bounded by the unbonding horizon. Inclusive action deadlines pair with strictly later timeout conditions. Activated penalties are suppressed at or after expiry; unactivated forfeiture is the documented exception. |
| State before callbacks | Outcome/slash decisions are recorded before the evaluator touches bonds or core payout. Holding guards state-mutating accounting paths with a transient reentrancy guard. Core payout failure does not replace a worker-side outcome with a refund. Existing callback regressions specifically cover these interactions. |
| Payout return-data/gas attacks | `pushPayment` copies at most 32 bytes, rejects empty no-code success, and runs in a self-call frame so false/short return after a transfer rolls that transfer back before creating `owed`. Core and feedback calls have bounded budgets; core revert data is not copied and feedback copies at most 32 bytes. |
| Direct donation/forced native funds | Stake prices and liabilities do not derive from native balance or arbitrary token balance introspection. Token balance differences are used to validate inflows, not to assign donated stake. |
| Config scaling | Mainnet fee thresholds are whole SIDE in config and are scaled once by `1e18` in deployment. Creator bonds are already raw units. The recipe pins SIDE to 18 decimals and the fixed supply; configuration narrowing uses `SafeCast`. |
| Seed helper | The helper uses explicit raw token caps, exact inflows, atomic price verification/minting, bounded repair spend, one-shot caller authorization and allowance cleanup. Repair cap computation multiplies before division with `Math.mulDiv`. This helper is not the current nad.fun mainnet trading path. |
| No applicable economic modules | No lending interest accumulator, oracle-price conversion, Merkle claim, random/reveal selection, or user payable delegatecall batch occurs in the reviewed Sidequest v1 surface. Those checklist patterns are not applicable. |

## Compiler applicability review

The installed build configuration is Solidity `0.8.28`, `via_ir = true`, optimizer enabled, Cancun; installed Forge reports `1.8.3`.

Reviewed the Solidity known-bugs list pinned to release `v0.8.37`: `https://raw.githubusercontent.com/ethereum/solidity/v0.8.37/docs/bugs.json`, saved as `solidity-bugs-v0.8.37.json`.

- `SOL-2026-1` (transient clearing helper collision): no Solidity transient state variable is deleted. OpenZeppelin `ReentrancyGuardTransient` clears its flag through `TransientSlot.tstore(false)`, implemented with assembly `tstore`, so the required source trigger is absent.
- `SOL-2026-2` / `SOL-2026-4` (mutually recursive spill failures): no internal mutually recursive call graph was identified in the reviewed application contracts. External callbacks enter separate EVM call frames and do not establish the described internal spill-slot trigger.
- `SOL-2026-5` (memory-byte-element deletion): applies to the evmasm pipeline; this project compiles via IR.
- `SOL-2026-6` (named custom-error arguments in `require`): no affected named-error `require` usage was identified in the reviewed sources.
- `SOL-2025-1` (storage-array slot-boundary overflow): no user-controlled placement of an array across the end of the storage address space was identified.

The initial unpinned `develop` bug-list download included an advisory with a 2026-10-22 publication link, after the review date. That future-dated entry is not used to claim a current vulnerability; the report uses the release-pinned list above. This applicability review does not prove the compiler free from other bugs or replace a compiled-artifact comparison.

## Existing risks and boundaries, not newly discovered exploits

- The Safe can pause/upgrade the core and withdraw escrow while paused; the configured arbiter has adjudication authority. Those are disclosed trust assumptions, not a permissionless attacker path.
- Rebasing, lying, pausing or censoring reward tokens can impair jobs denominated in that token. ADR-0010 explicitly accepts token-local pooling and negative-rebase shortfall risk; full inflow checks cannot prevent later token behavior.
- Pause history relies on the Safe pairing core pause/unpause with evaluator `notePause`. This operational requirement is documented and should remain in incident procedures.
- The mainnet configuration names the Safe as treasury and slash recipient. Privileged future misconfiguration of recipients is outside a permissionless exploit claim and still needs operational checks.

## Non-security comment drift

- `IStakeVault.HOLDING_DELAY` NatSpec still says 15 days, while the production constant/config and the interface introduction correctly use 21 days.
- `ISidequestHolding.Listing.fee` NatSpec describes `reward * feeBps / 10000` without the implementation's ceiling and dust cap. The implementation and `SURFACE.md` explain the actual policy.

These observations are documentation cleanup candidates and are not vulnerability findings.

## Validation and limitations

This reviewer did not run a duplicate Forge suite: the coordinating agent reported an active full repository check, including Forge, in session `23874`. Its final result must be attached by the coordinator; a running test process is not a passing receipt. No new PoC was executed because no candidate exploit survived source review.

No independent full contract coverage measurement, live mainnet transaction, newly fetched deployed-bytecode match, upgrade simulation, or external-service acceptance test was performed by this reviewer. A fresh Slither follow-up is recorded below. The cryptographic, token-specific and access-control specialists have separate scopes; this report must not be used as their substitute.

## Fresh Slither static analysis

Slither `0.11.6` was run through isolated `uvx --from slither-analyzer` under the repository's `heavy` wrapper against the `contracts/` Foundry project. The JSON reports `success: true`, `error: null`; the run analyzed 79 contracts with 102 detectors, producing 264 raw results: 5 High, 37 Medium, 58 Low, and 164 Informational. The markdown-printer invocation returned exit 255 because detections exist; this is not a clean scanner pass. Raw artifacts:

- `slither.json` (machine-readable output)
- `slither.log` (tool/build log)
- `slither-checklist.md` (markdown printer output; Slither's “not complete” banner means ignored findings are omitted by default)
- `slither-own-scope.json` (deduplicated results touching Sidequest/vendor/script source)

The raw run invokes `forge clean` and `forge build --build-info --deny never --skip ./test/** ./script/** --force` as Slither's compile step. It did not modify tracked source, compiler settings or tests. The compile output is generated under the normal Foundry output directories and was not staged.

Tool availability: `uv 0.12.15`, isolated Slither `0.11.6`, Forge `1.8.3`. The first sandboxed attempt could not write the shared heavy lock; the approved retry used the real shared lock. One CLI attempt supplied a filename to the boolean `--checklist` flag and exited 2 without analysis; the corrected JSON and markdown invocations completed. The resulting scan includes dependencies and testnet source contracts, but Foundry excludes `test/**` and `script/**` from this static compile. Script review above is manual, not Slither coverage.

### High/medium dispositions

- `arbitrary-send-eth` on `ERC8183.emergencyWithdraw` is an explicitly `ADMIN_ROLE`-only emergency escape hatch, and the contract is deliberately documented as Safe-controlled. It is privileged behavior, not an unprivileged drain.
- `arbitrary-send-erc20` on `SidequestTestnetPaymaster.postOp` is the intended ERC-4337 charge from the validated operation sender. The function is EntryPoint-only, and the context binds the sender/rate returned by validation. This fixture rejects chain 143 and is not a production mainnet component.
- `uninitialized-state` on `SidequestHolding._listings` is a false positive: mappings are zero-initialized by the EVM and each listing is populated by `publish` before use. The existing `UnknownJob` checks enforce the zero sentinel.
- `uninitialized-local` on `SidequestEvaluator._excusedByPause` is a false positive: `uint256 lo;` intentionally starts the lower bound at zero for binary search.
- `msg-value-in-nonpayable` on OpenZeppelin `ERC1967Utils._checkNonPayable` is a dependency call-graph false positive. `UUPSUpgradeable.upgradeToAndCall` is public payable and calls this guard through the upgrade helper when initialization data is empty; the guard correctly rejects value that would be stranded.
- `incorrect-equality` on `FeeSchedule`'s `_eta == 0` checks is intentional sentinel handling; an ETA of zero means no pending schedule. The testnet faucet's `last == 0` similarly encodes “never dripped.”
- `incorrect-exp` and `divide-before-multiply` findings are inside OpenZeppelin `Math.mulDiv`/`invMod`; the XOR is the documented modular-inverse seed, and the divisions occur in the full-precision assembly algorithm rather than user-facing fee/share math.
- `reentrancy-no-eth` findings on Sidequest lifecycle functions are expected analyzer reports: the external entry points are `nonReentrant`, the evaluator and Holding form separate guards, the core is `nonReentrant`, Holding's core jobs use no user hook (`hook = address(0)`), and arbitrary reward-token callbacks are intentionally isolated into `owed`/deferred routes. Relevant regression suites include `V1ArbitraryTokens.t.sol`, `SidequestHolding.t.sol`, and `SidequestEvaluator.t.sol`.
- `unused-return` findings in `SeedHelper` are intentional postcondition checks: initialization/unlock return data is followed by a live slot/position verification, while `settle()`'s returned paid amount is not needed after exact delta settlement. The ignored slot0 tick/fee fields do not affect its target-price check. `ECDSA.tryRecover` callers use both the recovered address and the error enum, deliberately discarding only the third diagnostic value. OpenZeppelin upgrade helpers deliberately ignore return bytes from `Address.functionDelegateCall`; that wrapper already reverts on call failure.

No high or medium Slither result survived triage as a new concrete exploitable vulnerability. This disposition does not suppress the separate specialist reviews or the production trust assumptions documented above.
