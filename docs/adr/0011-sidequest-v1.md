# ADR-0011: Sidequest v1 contracts

Date: 2026-10-02. Status: **implemented, unit-tested, fork-rehearsed on Monad testnet and mainnet; audited — C9 signed
off 2 Oct (`review/contracts-C9-signoff.md`, at 4dfc039); not deployed** (`~/code/sidequest.wt/briefs/plan.md`).
Findings and resolutions are in "C9 audit" below. The sign-off is a source review, not deployment authorization. Decided in myplan note 17 (`doc_eea3BzAG1fugdaPf`, rev 8) and the
v1 build plan. Supersedes the retired protocol decisions for all v1 jobs.

## Context

The v1 design defines one `sidequest-v1` pair per network. Every listed job is a hire with a frozen
reward, terms, approver, arbitrator and settlement windows. Rewards are escrowed through `SidequestHolding`; stake
reservations and outcome recording are handled by the v1 evaluator and vault.

## Decision

### One pair, per-offer terms

- `SidequestHolding` + `SidequestEvaluator` are the v1 pair. Discovery is request → quotes → selection off-chain;
  on-chain every job is one hire.
- Each offer sets its own `reviewWindow` and `disputeWindow` (1 h–14 d) and `arbitrationWindow` (12 h–14 d), and its
  own `arbitrator` (zero = `defaultArbitrator`). All are frozen into the listing at publish and are part of the terms
  the worker activates against. The evaluator reads them through `termsOf` everywhere; it has no window of its own.
- `publish` refuses an arbitrator equal to the creator or the approver, and requires
  `expiredAt ≥ deliveryDeadline + review + dispute + arbitration + margin` so the core's own expiry can never
  pre-empt a settlement still in progress.
- `activate` refuses a worker who is the listing's creator, approver or arbitrator. The plan named the approver and
  arbitrator; the creator is added because it is the same conflict (the approver defaults to the creator anyway).
- `defaultArbitrator` is settable by the owner (the Safe, `Ownable2Step`), not immutable: it is resolved and stored per
  listing at publish, so changing it never touches a live job, and arbiter keys may need to rotate.
- The EIP-712 domains ("SidequestHolding" / "SidequestEvaluator", version "1") and the `Selection`, `Ruling` and
  `EvidenceAttestation` type strings are unchanged. `verifyingContract` separates the pairs, so the SDK's
  `typed-data.ts` signs for v1 unchanged.

### The review fixes

- **M1, ruling order.** Every terminal path in the evaluator runs: checks → record `outcome` and `slashed` → emit →
  settle the loser's bond → release the other bonds → core call → feedback. A hostile reward token that re-enters
  `SidequestHolding.settle` during the core call finds both bonds already settled, and `settle` itself consults
  `creatorPenaltyDue` and `workerPenaltyDue`. These are findings, not proof of a burn: Holding burns only before
  `expiredAt`, and releases at or after expiry (HR-001, decided by Kris on 2026-10-08). The trade-off is that a no-show
  is punished only if someone resolves it before expiry. The creator has an incentive to call the permissionless
  timeout because it refunds the reward sooner than the core refund available after expiry.
- **M2, `_payWorker`.** Accept, silence and a ruling for the worker `try core.complete{gas: CORE_GAS}` (300k). On
  failure (a refusing or gas-burning token, an expensive worker hook, a paused core), or when the core charges fees,
  the evaluator sets `payoutDeferred`, emits `PayoutDeferred`, and tries `core.reject("payout-deferred")` with whatever
  gas is spare so the net reward lands in Holding; otherwise the permissionless `retryDeferred` (or the core's
  `claimRefund` after expiry) brings it there. `earnedByWorker` is true for a deferred payout and for an `Accepted`,
  `Silence` or `RuledForWorker` outcome, so `settle` pays the worker or records the amount as `owed`. A ruling for the
  creator tries `core.reject{gas: CORE_GAS}` the same way. Before the core call the evaluator requires gas for the full
  `CORE_GAS`, the bookkeeping and the feedback (`CoreGasTooLow`), so a starved core call can never pass for a refusing
  token, and a gas-burning one consumes at most `CORE_GAS` and cannot roll the decision back (C9-001). Feedback is best
  effort. Once an outcome is recorded every other terminal path reverts (`AlreadyResolved`); the arbitration timeout
  reverts `AlreadyRuled`, so a deferred ruling for the worker can never become a refund, and `retryDeferred` only
  finishes the recorded outcome (C9-003).
- **M3.** `policyListed` is keyed by creator and hash. A copied hash published by someone else no longer blocks the
  real creator; a creator still cannot fund the same offer twice (R114-07).
- **Ruling nonces** are per arbitrator (`rulingNonceUsed[arbitrator][nonce]`), since arbitrators are now per offer and
  one arbitrator's nonce must not burn another's.

### Fees and top-ups

- `FeeSchedule` maps the worker's stake to a rate: thresholds 0 / 10k / 100k / 1M SIDE at 30 / 10 / 3 / 1 %, the
  treasury Safe as recipient. The Safe retunes it through `propose` → `execute` (anyone, after 3 days) → `cancel`. A
  proposal needs a zero first threshold, strictly ascending thresholds, rates ≤ 3000 bps that never increase, and a
  nonzero treasury. Four tiers, fixed-size arrays: a bounded loop and a simple ABI.
- At `activate`, Holding snapshots `feeBps = feeSchedule.feeBps(vault.stakeOf(worker))` (reservations included,
  cooldown excluded) and `fee = ⌈reward · feeBps / 10 000⌉`, capped at `reward − 1` so `net ≥ 1` (C9 MATH-1), and
  funds the core with `net = reward − fee` only. The
  worker's `SetBudgetAuthorization` names `net`, so its signature pins the fee it agreed to; `quoteActivation` tells it
  the number. A schedule change never touches a live job. The core's own fee stays 0: `activate` refuses a core that
  charges one, and a fee set later routes the payout through Holding, so the worker is never charged twice and nothing
  strands in the evaluator (C9 ACL-5).
- Holding keeps the fee until `settle`: to the treasury when the worker is paid, back to the creator on a refund.
  `FeeCharged(jobId, token, worker, creator, amount, bonusPart)` is emitted on a paid settlement and is the input to
  mining. The treasury is read at payout time.
- `topUp` lets anyone add a bonus in the reward token after activation, while the core job is Funded or Submitted. The
  bonus pays the worker with the reward at the same rate (`bonusFee = ⌈bonus · feeBps / 10 000⌉` to the treasury), or is
  refundable per contributor with `claimTopUpRefund` (pull-based; anyone may trigger it, the money goes to the
  contributor). The worker agreed to "at least the reward"; the bonus sits outside the signed terms.
- Every outflow (worker, treasury, creator, contributor) is a push with a fixed gas budget (`TRANSFER_GAS` = 300k,
  reading at most 32 bytes back) and falls back to `owed[token][account]`, withdrawn with `withdraw(token)` (no gas
  cap). The push runs in its own call frame (`pushPayment`, callable only by Holding), which reverts unless the transfer
  clearly succeeded, so a token that moves the balance and then returns `false` is rolled back before `owed` records it
  (C9-002). A refusing, reverting or gas-burning token never blocks bonds or other payees. The caller must leave room
  for the full frame (`TransferGasTooLow` otherwise), so starving the call cannot push an honest payee into `owed`.
  `topUp` is refused once the evaluator has recorded an outcome.
- Accepted griefing vector: anyone can `delegate` to a worker, or request/cancel an exit, just before activation
  and change its active backing tier. The worker's budget authorization then names the wrong `net` and activation
  reverts until it re-quotes. The delegator retains its position, subject to slashing and exit rules; the mismatch
  reverts without moving job funds. See ADR-0014.

### SIDE v2, the vault and mining

- `Factory`: ERC-20 + ERC20Permit + ERC20Burnable, 18 decimals. The constructor takes `(recipients[], amounts[])`,
  requires a sum of exactly 1e9 · 1e18, mints once, and has no owner: no mint, pause, blocklist or upgrade, so nobody
  can freeze stake or bonds. Allocation: mining 500M (`MiningReserve`), treasury 200M (Safe), team 150M (OZ
  `VestingWalletCliff`, parameters from config, default `start = T0 + 1 y`, duration 3 y), ecosystem 100M (Safe; the
  deployer on testnet), liquidity 50M (deployer, then the pool seed).
- `StakeVault` v2 (ADR-0014, 5 Oct) keeps per-Holding bond reservations and account-owned vetoes, with
  `Ownable2Step` and `ReentrancyGuardTransient`. Wallets retain shares when delegating behind another account;
  `stakeOf` is total active backing, including reservations, while queued shares remain slashable but no longer
  count for the tier or new bonds. `requestUndelegate(account, shares)` is allowed while bonded and restarts the
  whole queue's cooldown. `withdraw(account)` pays its owner after unlock only when remaining pool assets cover
  reservations (`StillBonded`); `cancelUndelegate(account)` restores active backing. Slashes burn SIDE pro-rata,
  including queued shares, and a full slash advances the generation and invalidates older positions. Invariants:
  per-pool `reserved <= assets`, `totalReserved <= totalAssets`, vault balance >= `totalAssets` (queue included).
  Admission/bootstrap/revocation remain unchanged; revoked Holdings still settle only their own `reservedBy`.
  See ADR-0014 for the four accepted testnet edges and the event ledger for future profit-sharing epochs.
- `MiningReserve` holds the 500M and funds the distributor for epochs that have ended, capped so the total ever funded
  stays within the cumulative schedule (epoch 0: 72 h and W · 3/7; epoch k ≥ 1: a week and `W >> ((k − 1) / 26)`,
  W = 500M / 52). Unspent budget rolls over. The α = 0.5 cap on emissions against fee value is applied off-chain.
  The schedule sums to more than the reserve: `cumulativeBudget` converges to W · 3/7 + 26 · W · (1 + 1/2 + …) =
  500M + W · 3/7, so after about seven halving eras (about 3.5 years) it promises more than the 500M the reserve holds.
  `cumulativeBudget` is therefore capped at 500M, so past that point `fund` reverts `ExceedsBudget` cleanly instead of
  failing a transfer (review C6-002). Both mining contracts take one explicit, nonzero `genesis` (the recipe's `t0`);
  there is no implicit "now", so they can never disagree on an epoch boundary (review C6-001).
- `EpochDistributor`: the Safe posts `setRoot(epoch, root, total, dataHash)` after the epoch ends, backed by funds
  already in the distributor and not promised to an earlier root. `claim` is permissionless and stakes straight into
  the vault with `delegateFor(account, account, amount)`. Leaves are OZ double-hashed `(epoch, account, amount)`. A root can be replaced only while
  nothing was claimed from it, so a wrong root is correctable and a bad one can drain at most its own funded total.
  `resizeRoot` corrects a total after claims (never below what was claimed), so a total above the leaf sum no longer
  locks mining funds (C9 MATH-5). One leaf per account and epoch; the tree builder aggregates.

### Admin

Every owner is the Safe (`Ownable2Step`; the deployer hands over at the end of the recipe and the Safe accepts; a
pending proposal is dropped when ownership changes). The Safe's powers: the fee schedule (3-day timelock, 7-day
execution window), Holding authorization on the vault (15-day timelock, 7-day acceptance window, instant revoke), mining
funding, roots and root totals, the evaluator's verifier set, and the default arbitrator for new listings. None of
these moves escrowed rewards. Only a newly authorized Holding could touch stake, after 15 days' notice (updated by ADR-0014's unbonding horizon), and never stake
whose account has denied it. On mainnet the Safe also holds the core's admin roles, which are broader: pause,
`emergencyWithdraw` while paused, the fee setters, the hook whitelist and the UUPS upgrade. Those can move escrow, and
an upgrade could misreport a job's state to the evaluator and so burn an honest bond; they are disclosed as such and
the README commits to no upgrade during an active agreement. A pause no longer freezes decisions or bonds (it defers
the core call), and a core fee set later never reaches a worker (C9). Before meaningful value is at stake the Safe
should move from 1-of-2 to at least 2-of-3, and the core upgrade behind a timelock (C9 ACL-8, STAKE-1).

### Gas (Monad charges the gas limit)

Floors measured by `test/sidequest/GasFloors.t.sol`: a binary search for the smallest execution gas that succeeds,
excluding the 21k intrinsic gas and calldata. `foundry.toml` sets `network = "monad"`, and a probe confirms the tests run
with Monad's opcode pricing (a cold account access costs 10,117, not 2,600), so these are Monad floors; the earlier
"EVM pricing" note was wrong. They are dominated by fixed reserves the contracts require: about 345k per payout push
(the `pushPayment` frame), and on every evaluator decision `CORE_GAS` (300k under the 63/64 rule) plus the 446k
feedback reserve. The limits below are what the SDK and the relay should send (decisions D4a); each covers the floor
plus intrinsic gas, calldata and a margin for state that is colder than in the tests.

| Call | Floor | Limit to send |
| --- | --- | --- |
| `SidequestHolding.settle`, worst case (2 bond releases, worker and treasury pushes) | 619k | 1,000,000 |
| `SidequestHolding.settle` after an accept (bonus and fee pushes) | 478k | 1,000,000 |
| `SidequestHolding.claimTopUpRefund` | 367k | 450,000 |
| `SidequestHolding.cancel` (core reject, bond release, reward push) | 523k | 700,000 |
| `SidequestEvaluator.accept` / `completeAfterSilence` | 987k | 1,200,000 |
| `SidequestEvaluator.rule` (with a slash) | 1,011k | 1,200,000 |
| `SidequestEvaluator.ruleWithSignature` (with a slash) | 1,035k | 1,200,000 |
| `SidequestEvaluator.rejectAfterDeliveryDeadline` | 1,034k | 1,200,000 |
| `SidequestEvaluator.retryDeferred` | 133k | 300,000 |
| `StakeVault.reserve` | 88,474 | 200,000 |
| `StakeVault.delegate`, new pool and position | 132,602 | 300,000 |
| `StakeVault.requestUndelegate` | 70,179 | 200,000 |
| `StakeVault.withdraw` | 81,968 | 200,000 |

The vault v2 floors were measured on 5 Oct after the VV2-001 share cap, with the same binary-search harness.
These are local Monad-priced execution floors, rather than live receipt gas. Limits include intrinsic/calldata
and a margin; wallet estimation against the deployed state remains the final check.

The evaluator limits rose from 1.1M because each decision now reserves the full `CORE_GAS` before the core call
(C9-001). A gas-burning token costs a decision no more than this: the core call is capped, the second core attempt
uses only spare gas, and `retryDeferred` finishes it later. The C8 fork rehearsals run a disputed hire on Monad
testnet and mainnet forks under these limits; the live `eth_estimateGas` in B11 stays the final check.

### Deploy

`script/SidequestRecipe.sol` runs in the plan's order as separate steps (core; vesting, Factory, FeeSchedule, vault,
Holding, evaluator; wiring; `bootstrapHolding`; distributor, reserve, the 500M; handover), every parameter from the
`sidequest` config block and no predicted address: the deployer receives the mining allocation at genesis and forwards
it once the reserve exists. Staking stays closed until the bootstrap (C3-001), so nobody can force the launch onto the
timelocked admission path. A reused core must charge zero fees, since Holding keeps the fee itself. The deploy has two steps (review
C8-001): `DeploySidequest.s.sol` broadcasts and writes only a gitignored candidate, because forge runs it before anything
is sent; `PromoteSidequest.s.sol` then proves the candidate on-chain (`SidequestVerify`: code, wiring, bootstrap, the
untouched reserve, one genesis, owners and core roles) and against forge's receipts, and only then writes `.deployment`
in the D1/D5 shape, with receipt block numbers. A dry run or a failed broadcast leaves the config untouched; promotion is
idempotent and refuses a config it cannot rewrite faithfully.

### C9 audit (2 Oct)

Method: the ethskills audit skill (`evm-audit-skills` master index and checklists). Seven specialist passes ran in
parallel over `contracts/src/sidequest/`, with the vendored core as counterpart and the deploy recipe in scope:
general; precision and math; ERC-20 with flash loans; staking; signatures with proxies; governance with access
control; assembly with DoS and chain-specific (Monad). Slither and the ethskills security pre-deploy checklist ran
too, and the Codex reviewer traced C8-001…003 and C9-001…003. Findings from several passes are merged below. Agent
severities follow the skill's definitions; reviewer findings keep the reviewer's.

| Finding (passes) | Severity | Resolution |
| --- | --- | --- |
| C9-001, ERC20-1, DOS-1, GEN-4, DOS-7: a gas-burning reward token, or an expensive worker hook, made worker-side decisions revert at any limit (the 416k feedback reserve no longer fit), freezing the worker bond or letting the creator win by timeout | High | Fixed 41cb743: core calls capped at `CORE_GAS`, room for the cap, bookkeeping and feedback required up front, fallback `reject` on spare gas only, feedback best effort. DOS-1's overflow variant: `topUp` refuses a reward + bonus that would overflow (1c54e12) |
| C9-002: a token that moves the balance then returns `false` (or short data) was paid and also owed | Medium | Fixed 1c54e12: the push runs in its own only-self frame (`pushPayment`) that reverts on failure; `owed` only after the rollback |
| C9-003, GEN-1, ERC20-2, DOS-3: a pending milestone claim plus a deferred refund locked the job for good | Medium | Fixed 41cb743: permissionless `retryDeferred`, which only finishes the recorded outcome; `topUp` refuses a decided job (1c54e12) |
| ACL-2, GEN-2, DOS-5: deadlines kept running through a core pause (delivery burn, arbitration timeout) | Medium | Fixed 41cb743: a pause defers the core call instead of blocking the decision; `notePause` records the pause and a delivery deadline inside it refunds without the burn |
| C9-007: only the latest pause was remembered, so a later pause erased an unresolved job's exemption | Medium | Fixed: an append-only pause history searched by binary search, used identically by the timeout and `workerPenaltyDue` |
| ACL-1, GEN-3, STAKE-2: the 8-day Holding delay did not protect stake still bonded when a new Holding went live, nor mining rewards claimed for an account | Medium | Fixed a108863: `setHoldingDenied`, the account's veto, checked by `reserve` |
| STAKE-1: core pause froze bonds; a core upgrade could misreport job state and burn a bond | Medium | Pause: fixed 41cb743 (decisions and bonds proceed during a pause). Upgrade: an accepted Safe power, now disclosed in Admin, with the recommendation to timelock it |
| DOS-2, GEN-6: the feedback `catch` copied unbounded revert data (Monad's linear memory makes a returndata bomb cheap) | Medium | Fixed 41cb743: at most 32 bytes |
| C8-001: the deploy script wrote the config before the broadcast | Medium | Fixed 99f7c32: candidate + `PromoteSidequest` with live and receipt checks; anvil pipeline rehearsal |
| C8-002: promotion required exact balances anyone can change (dust, `burn`) | Medium | Fixed cdaad49: lower bounds; genesis supply from the Factory creation receipt |
| C8-003: promotion accepts a pending handover | Info | Kept (coordinator): `/admin` uses the promoted record for the six `acceptOwnership` calls; `owner() == safe` is a separate launch check |
| ACL-5, SIG-4, GEN-7, ERC20-6: core fee setters reached live jobs; an evaluator fee stranded in the evaluator | Low | Fixed: `activate` refuses a charging core (1c54e12); a payout under core fees goes through Holding (41cb743) |
| ACL-3: the deployer key keeps owner powers until the Safe accepts | Low | Proposals are dropped on ownership change (a108863); promotion refuses any pending proposal, funding or root (99f7c32). Residual: the Safe accepts at launch |
| ACL-4, STAKE-3: proposals never expired; revoke left a re-acceptable proposal | Low | Fixed a108863: 7-day windows; revoke and bootstrap clear proposals |
| ACL-6, SIG-3, GEN-9: the fresh core's roles went to a Safe address without checking it exists | Low | Fixed 99f7c32: `check` requires code at the Safe; promotion too |
| MATH-1: the fee rounded down, so tiny rewards in 0–2-decimal tokens paid none | Low | Fixed 1c54e12: rounds up, capped so `net ≥ 1` |
| C9-006: rounding up departs from the brief's worker-favour rounding (at most one raw unit per component) | Low | Accepted by coordinator decision D11: the fee and the bonus fee round **up** and the fee is clamped to `reward − 1`, so a fee-paying job always pays a fee and `net` is never 0 |
| MATH-5, STAKE-4, GEN-11: a root total above its leaf sum locked funds forever | Low | Fixed a108863: `resizeRoot`. Duplicate leaves per account: the tree builder aggregates |
| SIG-1, GEN-8: an older evidence attestation could replace a newer one | Low | Fixed 41cb743: `StaleEvidence` |
| SIG-2: an arbitrator could not revoke a signed ruling | Low | Fixed 41cb743: `cancelRuling` |
| GEN-5, DOS-4: a worker can suppress its ERC-8004 feedback by making the evaluator an operator of its agent | Low | Accepted: the evaluator's `outcome`/`caseOf` is the canonical record; indexers count a self-feedback `FeedbackFailed` as negative |
| ERC20-3: `withdraw` sends everything and only to the payee | Low | Accepted: redirecting a blocklisted payee's funds would invite the issuer to blocklist Holding itself |
| ERC20-4: the core-to-Holding refund leg is not measured, so a token that starts charging or rebases down draws from other listings in the same token | Low | Accepted: isolation is per token (ADR-0010); such tokens are unsupported for full value |
| ACL-8: the launch Safe is 1-of-2 | Low | Governance recommendation (Admin); the mainnet Safe is set at R2 |
| MATH-2, DOS-6: the 10k slack assumed Ethereum's cold-access price | Info | Fixed: push frame +25k (1c54e12), feedback reserve +40k (41cb743) |
| MATH-3, SIG-6, C9-005: `validUntil` truncated to 48 bits; then clamped, which left storage and event apart | Low | Fixed: an expiry above `uint48` is refused (`SafeCast`), so storage and event agree |
| MATH-4: `budget` overstated what `fund` allows past the cap | Info | Fixed a108863 |
| MATH-6, ACL-9 (config): recipe casts wrapped silently | Info | Fixed 99f7c32: `SafeCast` and bounds |
| STAKE-8, GEN-12: `stakeWithPermit` NatSpec promised relaying | Info | Fixed a108863 |
| ACL-9: replaced proposals emitted no cancel | Info | Fixed a108863. The fee treasury is read at payout, not per job, and Holdings are authorized by address (only non-upgradeable ones may be authorized); TeamVesting keeps OZ's single-step `Ownable` |
| STAKE-5, STAKE-6, STAKE-7: tier griefing via a worker's own unclaimed leaf; one stake lends its tier to many jobs; donations are unrecoverable | Info | Accepted |
| ACL-7, SIG-5, SIG-7: the default arbitrator resolves at inclusion; attestations do not name the verifier; `termsHash` is a label | Info | Accepted: clients pass an explicit arbitrator and compare `getListing` before activating; verifiers are EOAs |
| ERC20-5, GEN-10: `FeeCharged` is free in a self-minted token and is emitted even when the fee went to `owed` | Info | For the mining pipeline (B8): count only priced, allowlisted tokens and only fees the treasury received |

Slither (`slither-analyzer` via `uvx`, sidequest sources only) on the final code: `uninitialized-state` on
`_listings` is a false positive (written through a storage pointer); `incorrect-equality` is the `eta == 0` sentinel;
the `reentrancy-no-eth` and `reentrancy-events` hits are writes after calls to the trusted vault and core inside
transient `nonReentrant` frames, in the order M1 requires; `timestamp` is the windows. `uninitialized-local` (an
implicit `false`) was made explicit.

Pre-deploy checklist (ethskills security):
- Access control: every privileged function has an explicit guard, and every owner is a Safe via `Ownable2Step`.
- Pause: the only pause is the core's, held by the Safe, and it no longer freezes decisions or bonds.
- Reentrancy: every state-changing entry point is guarded.
- Token decimals: amounts are in the token's own units, with no hard-coded `1e18`.
- Oracles: none.
- Math: `mulDiv` throughout, with rounding in the protocol's favour.
- Return values: `SafeERC20` everywhere except the bounded push, which checks the result itself.
- Input validation: zero values, bounds and lengths are checked.
- Events: every state change emits one.
- Maintenance: timeouts, `retryDeferred`, `notePause` and `settle` are callable by anyone with a stake in the result.
- Approvals: exact `forceApprove` amounts. The one infinite approval is the distributor's to the immutable vault, which
  pulls only inside `claim`.
- Fee-on-transfer: refused, measured at every inflow.
- MEV: no swaps.
- Proxies: only the vendored core is a proxy; it initializes atomically, its implementation is disabled, and its
  upgrade authority is the Safe.
- EIP-712: domain, nonces and deadlines are enforced.
- Delegatecall: none.
- Testing: Slither ran, the five fuzz tests passed at 10,000 runs, and the invariant tests passed. Edge cases are
  covered: zero, max, unauthorized callers, reentrancy and hostile tokens.
- Source verification: due after deploy (the coordinator's step).

## Consequences

- Indexers and the SDK use the v1 ABIs generated from the implementations (`scripts/gen-abi.ts`:
  `sidequestHoldingAbi`, `sidequestEvaluatorAbi`, `stakeVaultAbi`, `feeScheduleAbi`, `factoryV2Abi`,
  `miningReserveAbi`, `epochDistributorAbi`).
- Bonds require stake: a creator stakes before publishing a bonded offer, a worker before activating one.
- The vault is the highest-value contract and the focus of the C9 audit.
- V1 excludes cross-chain settlement.

**Amended (11 Oct 2026) by [ADR-0022](0022-no-mining-at-launch.md):** there is no mining at launch; the reserve,
distributor, schedule and team vesting below leave the launch recipe. The mining sections are kept as history.

**Amended (10 Oct 2026) by [ADR-0020](0020-mining-volume-credit.md):** from its cut-over epoch, mining credits gross
volume at the lowest fee rate, boosted by the worker's held tier and capped at the fee paid, instead of the fee itself.
