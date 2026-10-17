# Sidequest token and staking review — 17 October 2026

Source reviewed: `f99c6a968bb1abd0f2193cf7f8a96340f0fd792e` on `dev`.

Verdict: no new Critical, High, or Medium defect was established in the reviewed token-transfer, fee, staking, share-accounting, or slash/withdraw paths. One low-impact documentation inconsistency is recorded below. This is a source and local-test review, not an independent professional audit or proof of live deployment acceptance.

## Scope and method

Applied the EVM audit ERC-20, staking, and relevant ERC-4626/share-accounting checklists. StakeVault is not an ERC-4626 implementation: ERC-4626 interface conformance, strategy yield, rewards emissions, external LSDs, Beacon Chain validators, restaking proofs, cross-chain shares, and price oracles are out of scope because they do not exist here.

Reviewed `StakeVault`, `IStakeVault`, `FeeSchedule`, `SidequestHolding`, `SidequestClocks`, the ERC-8183 token transfer/funding/settlement paths, `AgentSweep`, and their unit/fuzz/invariant coverage. Also inspected the testnet-only `SeedHelper` for exact pulls and bounded/reset allowances. Read protocol law and ADRs 0010/0011 rather than treating intentional permissionless-token risk as a new defect.

## [TOK-1] Staking interface documentation advertises the retired Holding delay
**Severity**: Low
**Category**: evm-audit-defi-staking
**Location**: `contracts/src/sidequest/interfaces/IStakeVault.sol:223`; related test names/comments at `contracts/test/sidequest/StakeVault.t.sol:211`, `:384`, and `:482`
**Description**: The `HOLDING_DELAY()` NatSpec says 15 days, while production configuration and implementation use 21 days. Two test names still say seven-day unstaking and eight-day admission although their assertions correctly use 14/21 days. The old bootstrap comment also says 15 days. Runtime behavior is correct; generated documentation and test output can mislead integrators about notice/exit timing.
**Proof of Concept**: Compare the getter's NatSpec with `SidequestConstants.HOLDING_DELAY = 21 days` and `test_holding_delayOutlastsCooldown`; run the test suite below. The assertions pass at 21 days, despite the stale public documentation and names.
**Recommendation**: Change the getter description to deploy-time Holding admission delay, noting 21 days in production. Rename stale tests/comments to match 14-day unstaking and 21-day admission. No contract behavior or storage change is required.

## Verified properties

- Stake assets are internal ledger values, not token `balanceOf`. Direct donations do not alter share prices. Deposits and withdrawals round down with full-precision `Math.mulDiv`; the last shares redeem all remaining accounted assets.
- A complete slash or forfeit resets the pool generation, so old positions cannot revive after a new deposit. Share counts are capped to `uint192` before transfer, preserving the ability to queue a full exit after repeated near-total slashes.
- Reservations are limited by active backing minus existing reservations; withdrawing queued backing cannot leave existing reservations undercollateralized. Queued shares stop helping new bonds and fee tiers but remain exposed to existing slashes.
- `delegateFor` does not reset another user's queue or unlock time; only the position owner may request/cancel/withdraw. A front-run permit is tolerated only when the original owner's sufficient allowance remains.
- Slashing and forfeiture consume only the caller's own reservation, cap at that reservation, and reduce pool/global assets by the same amount. Revocation stops new reservations while preserving settlement of old ones.
- Production clocks are pinned to 14-day exit, 21-day admission and 3-day fee notice on chain 143. Holding admission gives a week to request free exit. Activated-job slashes are suppressed at/after expiry; the explicit unfilled-listing forfeiture exception remains covered by tests.
- Fees are bounded to 3000 bps, non-increasing with stake, and snapshotted per job at activation. The main reward always retains at least one token atomic unit of net pay. Top-up fees use the same snapshotted rate and ceiling rounding.
- Reward inflows at publish, top-up and core funding are measured exactly. ERC-20 no-return behavior is supported; short inflows revert. The core receives only an exact approval at activation.
- Holding outflows use a bounded self-call. Failed/false/short-return transfers roll back before an `owed` liability is written, preventing double payment. Zero pushes are skipped. Tests cover blocklists, pauses, gas-burning transfers, and transfer callbacks attempting to reenter Holding/Evaluator.
- Settlement records the outcome and handles trusted SIDE reservations before hostile reward calls. A failed reward call preserves the earned/refund outcome for retry and cannot change the winner.
- AgentSweep is stateless and pulls only from the calling registered agent wallet to the current ERC-8004 owner. It holds no standing token balance or arbitrary third-party transfer authority.

## Accepted and deployment-dependent boundaries

1. Permissionless reward tokens can rebase, freeze, start taxing transfers, lie, or lose value. Escrow isolation is per token, not per listing; exact inflow does not guarantee future solvency or full recipient value. ADR-0010 and ADR-0011 already explicitly accept this, including the unmeasured core-to-Holding refund leg (prior ERC20-4). It is not newly introduced by the dev release delta.
2. StakeVault trusts the immutable SIDE token to be the specified plain, non-rebasing token. Its deposit path intentionally has no balance-delta check. Mainnet recipe/verify pin an EIP-1167 clone of the configured nad.fun implementation and the configured curve, name, symbol, decimals and supply. This lane did not repeat live bytecode verification; the coordinator's live preflight must establish the deployed configuration.
3. The Safe and admitted Holdings retain disclosed powers. A Holding may consume its own reservations; the Safe may change the slash recipient immediately. The core admin may pause, upgrade, and withdraw escrow while paused. Free exit does not bypass live reservations. Existing disclosure and live custody verification remain required.
4. An invalid governance-selected treasury can temporarily block unfilled forfeiture settlement. `BondPolicy.test_invalidTreasuryKeepsReservationUntilFixed` deliberately covers this recoverable administrative failure. It is not an unprivileged attack or a new finding.
5. Tests exercise the compiled code locally. No mainnet transaction, deployment, real token freeze, external account manipulation, or provider outage was performed.

## Fresh validation

Command from `contracts/`:

```sh
heavy forge test --match-path 'test/sidequest/{StakeVault*,V1ArbitraryTokens,SidequestHolding,SidequestEvaluator,HorizonLateSlash,FeeSchedule,BondPolicy}.t.sol'
```

Result: **226 passed, 0 failed, 0 skipped**, 12 suites; compilation cache reused. The StakeVault stateful invariant run exercised **64 runs, 2048 calls, 0 reverts**, checking pool/share conservation, reservation coverage, owner-only value, exact deposit/withdraw/slash/forfeit accounting, and supply preservation. Fuzz tests used 512 runs.

Full command log: `/tmp/sidequest-prod-review-20261017/tokens-staking-forge.log`.

Checklists retained alongside this report as `checklist-erc20.md`, `checklist-staking.md`, and `checklist-erc4626.md`.

No repository source file was changed and no public issue was filed by this review lane.
