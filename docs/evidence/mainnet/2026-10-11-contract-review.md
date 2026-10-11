# Contract review before the nad.fun launch — 11 October 2026

This records an independent review of the launch contracts and how each finding was handled. It
establishes implemented and tested changes only. Nothing here is deployed on Monad mainnet, and
R7, the full launch rehearsal, had not yet run end to end when this was written.

## Scope

An Opus 5.5 reviewer, working read-only, reviewed `git diff mining-final..a0391184 -- contracts/`.
The diff covers four changes:

- slashed SIDE goes to `0x…dEaD` (d4e45533);
- owners cannot renounce, finding R6 (910bbbca);
- the 21-day holding delay, finding R4 (8f4dc99c);
- the existing-token recipe with mining and vesting deleted (54fc54f2), and the R7 nad.fun
  rehearsal (a0391184).

The reviewer checked the nad.fun ABIs against `github.com/Naddotfun/nadfun-v2-intergration`. It
also made read-only calls on `rpc.monad.xyz` against a live nad.fun V2 token, VNGames
`0xf982…7777`. That token is a 45-byte EIP-1167 clone of
`0x4f44eAFa383FE5f97a0d6CfF97fC5d605D026Fbd`. It exposes ERC-20, permit and the curve getters, and
has no `burn`, `owner` or hooks. Its EIP-712 domain version is `"1"`.

**Verdict:** the contract changes are sound, with no Critical findings. The launch is blocked
until finding 1 is fixed and R7 passes on the launching commit.

## Findings and disposition

| # | Severity | Finding | Disposition |
| :-- | :-- | :-- | :-- |
| 1 | High | The API launch gate and the SDK deployment schema still require the deleted mining fields, so R7 and runbook §3.5/§3.7 cannot pass. | **Open.** This is the SDK schema step (P2.1 in note 23). It lands after the off-chain mining consumers are deleted. The fields are removed, not made optional, and the gate reads four owned contracts. R7 then runs end to end on the launching commit. |
| 2 | Medium | `check()` and `verify()` accept any 18-decimal, 1e27-supply token, but `StakeVault.factory` is immutable. | **Fixed.** On chain 143 the recipe pins SIDE to the nad.fun clone bytecode of `.nadfun.tokenImplementation` and requires `bondingCurve() == .nadfun.curve` (`SidequestRecipe.checkLaunchToken`). Both the deploy and the verify run it. `check()` also requires `name() == "Sidequest"` and `symbol() == "SIDE"`. Runbook §3.2 takes the address only from the `Create` log, with `creator` equal to Kris's wallet. |
| 3 | Medium | The SDK flow check expects a slash to transfer to the zero address. | **Fixed.** `verifyJobEconomics` accepts `SLASH_SINK` (`0x…dEaD`) or the zero address for older generations, and refuses any other recipient. |
| 4 | Low | No refusal of a retired attester key on chain 143. | **Fixed.** `check()` reverts `attester is a retired 1 Oct key`. |
| 5 | Low | The mainnet `rewardTokens` rule requires only USDC. | **Fixed.** On 143, `SidequestOutput` requires both `x402.usdc` and `.sidequest.token`. |
| 6 | Low | The Safe can renounce or revoke the core's last `DEFAULT_ADMIN_ROLE`. | **Disclosed, not changed for launch.** It goes in the governance known-issues list (T4.1). |
| 7 | Low | Runbook §3.8 omits the Safe's `approve`, and the module/guard check runs after SIDE reaches the Safe. | **Fixed.** §3.8 is a MultiSendCallOnly batch of `approve` and `delegateFor`. The module and guard check moved into §3.1, before any SIDE reaches the Safe. |
| 8 | Low | R7 doesn't prove the creator-fee claim or `delegateWithPermit` on the real clone. | **Fixed where a fork can prove it.** `RehearseHire` stakes the worker through `delegateWithPermit` against the real clone. R7 step 8 checks that the creator-fee vault names the Safe (`getCreator(SIDE)`). A mainnet-fork probe found the claim itself can't be rehearsed: after creation and a 50 MON buy, the vault credits the token nothing, and `FeeCollector.collectFee` (`0xE1C8…3022`) refuses a stranger with `NotAuthorized()`. nad.fun's operator moves fees in. Runbook §3.8 has the Safe call `claim(SIDE)` once the vault holds a balance, and records that first claim. |
| 9 | Low | `gen-abi.ts` still lists Factory, MiningReserve and EpochDistributor. | **Open.** Lands with finding 1 (SDK schema step). |
| 10 | Info | The 7-day exit window is slightly under 7 days in practice, and a blocked or queued exit still takes a pro-rata loss. | **Disclosed** in the governance docs (T4.1). |
| 11 | Info | Stale comments and leftovers. | **Fixed:** the comments in `IFeeSchedule`, `ISidequestHolding`, `IStakeVault` and `FeeSchedule`, and the unused R7 variables. **Kept:** `slash` still names its return value `burned`, so the ABIs don't change. Any "slashed" metric reads `Slashed` events, not the `0x…dEaD` balance, because anyone can send to that address. |

## Checks

Before these fixes, the full `forge test` passed with the fork suites on public RPCs:
`MONAD_MAINNET_RPC_URL=https://rpc.monad.xyz` and `MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz`.
That run covered the mainnet and testnet fresh core plus a hire, and SafeAccept against the real
testnet Safe.

With the fixes applied, the first full run passed 384 tests and failed 2. Both failures were
memory-aliasing bugs in the new Recipe tests. After correcting them and running `forge fmt`,
`forge test --match-path 'test/{sidequest/Recipe,MainnetRunbook}.t.sol'` passed 35 of 35
(Recipe 25, MainnetRunbook 10).

The creator-fee probe forked mainnet, then:

1. created a token through the router with the vault recipient set to a dev key;
2. checked that `getCreator(token)` returned that key;
3. bought 50 MON of the token;
4. found the vault credited nothing for the token;
5. found that `claim` reverted for both the stranger and the recipient;
6. found that `FeeCollector.collectFee` reverted `NotAuthorized()` for a stranger.
