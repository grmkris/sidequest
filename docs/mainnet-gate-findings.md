# Mainnet gate: contract and mining findings (10 Oct 2026)

**Why this exists.** Kris asked for an ethskills review of everything built so far, ahead of the mainnet decision. Three
read-only code reviews ran on 10 Oct: the contracts (an audit lens using the staking and ERC-4626 checklists), the
off-chain mining tool, and the backer share.

**Headline.** There is no new Critical or High bug in the contracts. The 2 Oct Mediums are fixed:
- ruling order: `SidequestEvaluator.sol:382-395`;
- refusing tokens defer: `:404-436`;
- `policyListed` is per creator: `SidequestHolding.sol:65,152`;
- JobPool was deleted (714b45b8).

The biggest exposures are admin trust (one Safe key) and the mining price reference. This file lists what is still
open and which fixes need a redeploy, so Kris can decide each one.

**Sources.**
- **Code read at origin/dev `de145437`.**
- **On-chain reads (testnet, 10 Oct):**
  - the ERC-8004 identity proxy `0x8004A818…BD9e` has owner `0x5472…2603`, an EOA, and implementation
    `0x7274…9c02`;
  - testnet fee tiers are 3000 / 1000 / 300 / 100 bps at 0 / 10k / 100k / 1M SIDE.
- **Mining handling:** ADR-0020 covers the rule changes. Rows marked "ADR-0020" are handled by mining v2 and need no
  contract change.

## Fix before mainnet without a redeploy

| # | Finding | Evidence | Fix |
| :--- | :--- | :--- | :--- |
| G1 | **One key controls the protocol.** The runbook plans a threshold-1 Safe, and that Safe has instant power to upgrade the core (UUPS), `pause`, and call `emergencyWithdraw` on all escrow. The core's platform and evaluator fee setters also apply instantly to live jobs. | `ERC8183.sol:252,257-280`; `SidequestRecipe.sol:355-358`; `docs/mainnet-runbook.md:20` | Threshold ≥ 2 (ADR-0011 already recommends 2-of-3). Put the core's admin roles behind a TimelockController longer than the unstake delay. |
| G2 | **The SIDE reference price is stuck at the $0.0001 floor.** No `mining.officialPool` is configured, so every epoch carries the floor forward. The mainnet seed pool (3M SIDE : 300 USDC) sits exactly on it. Pool sampling uses historical `eth_call`, which Monad doesn't serve, so it would fail even when configured. While SIDE trades above 2× the reference, self-hire (two wallets of one party) mints SIDE at a profit at the 1 % tier. ADR-0020 removes the profit at higher tiers; at 1 % it breaks even at 2×. | `pool-chain.ts:149-155,172-224`; `pool.ts:84-90`; `monad-mainnet.json` liquidity | Sample the official pool from Uniswap v4 `Swap`/`Initialize` logs (or record samples during the epoch), configure `mining.officialPool`, and use the median sample instead of the maximum. |
| G3 | **A single external key can upgrade the identity registry.** It is a UUPS proxy owned by the EOA `0x5472…2603`, outside Sidequest. An upgrade can change what `getAgentWallet` (activation checks), `setMetadata` (backer shares) and reputation mean. | On-chain read; `docs/erc-8004.md:17-25` | Document the owner. Alert on `Upgraded` / `OwnershipTransferred`. Mining records and pins the implementation per epoch (ADR-0020 follow-up). |
| G4 | **Instant Holding setters.** The Safe can change `setUnfilledForfeitBps`, `setMinimumCreatorBond` and `setDefaultArbitrator` at once, and `publish` takes no maximum. A compromised key can front-run a publish into a 50 % forfeit. | `SidequestHolding.sol:124-140,193` | Holding owner behind a timelock (no redeploy). A `maxForfeitBps` field in `PublishParams` would need a redeploy. |
| G5 | **The Safe can cancel unclaimed mining leaves.** `resizeRoot` can cut a live root down to what has already been claimed, instantly. ADR-0011 doesn't list this as a Safe power. | `EpochDistributor.sol:63-77` | Document it now; a redeploy can forbid cuts below the leaf sum. |
| G6 | **Mining runs depend on one operator.** Prices, the run, `fund`, `setRoot` and publishing are all by hand. No keeper exists for timeouts or settlement either; parties settle their own jobs. | `docs/mainnet-runbook.md:355-412` | A runbook cadence plus monitoring. `fund` could be opened to anyone (redeploy). |
| O1 | **Mining needs a large-range log source.** Public and free-tier RPCs cap `eth_getLogs` ranges at 100 or fewer blocks; full mining replay can take hours. | Mining v2 testnet epochs 44/45 live-run evidence supplied to lane FIN; `scripts/mining/hypersync.ts` | Use `--logs hypersync` with `HYPERSYNC_API_TOKEN`, or a keyed RPC supporting large log ranges. Keep RPC `--recompute --from-genesis` as the independent check. |

**Testnet operations fixed by lane FIN:** `contracts/script/testnet-safe-policy.json` now pins the G1e Safe
(`0x77923113FD1a71Ad91F81064C3c05cA1EfB44CD8`), its two reviewed owners and threshold 1, matching the checked-in
testnet config and the coordinator's 10 Oct readback. The epoch runner validates the selected owner against both
that policy and live `getOwners()`, publishes v2 state and allows publication without a claimant. FIN's verification
is offline; the coordinator runs the updated live proof. This does not change G1's mainnet custody recommendation.

## Needs a redeploy (decide per item)

| # | Finding | Evidence | Fix |
| :--- | :--- | :--- | :--- |
| R1 | **Backers of a creator can escape the unfilled forfeit.** A backer who queued before `settle`/`cancel` can still withdraw while the pool has room (`remaining ≥ reserved`), leaving the 25 % forfeit to the others. ADR-0014/0017 say queued backing stays exposed. | `StakeVault.sol:105`; `SidequestHolding.sol:450-456,465-474` | Reserve creator bonds against the creator's own self-position, or document the exception. |
| R2 | **A pause can cost a listing its forfeit.** While the core is paused, `activate` and `cancel` revert (the core's `whenNotPaused`), so a listing whose 600 s grace or activation window falls inside a pause loses its forfeit. The money goes to the treasury, which is the Safe that paused. | `ERC8183.sol:456,641,684`; `SidequestHolding.sol:450-455` | A pause-aware grace. |
| R3 | **Self-activation evades the forfeit.** A creator can activate its own listing from a second registered agent with a zero worker bond, never deliver, and get the reward, fee and bond back. Spam stays up for the whole horizon. | `SidequestHolding.sol:244,252,450` | A non-refundable listing fee, a no-delivery forfeit, or a worker-bond floor. |
| R4 | **Backers have a short exit window after a Holding proposal.** A malicious Holding can reserve and forfeit whole pools, queued shares included. Backers are safe only if they request exit within `HOLDING_DELAY − UNSTAKE_DELAY`: 1 day on mainnet, 1 hour on current testnet. Only the account can veto a Holding (`holdingDenied`). | `StakeVault.sol:121-132,156-171`; `SidequestConstants.sol:24-28` | A longer `HOLDING_DELAY`. |
| R5 | **Anyone can force a claim.** `claim` stakes as active shares, so forcing an account's claim just before its bond is slashed shifts part of the loss from its backers to the account. | `EpochDistributor.sol:79-92` | Claim by the account or its approved operator only. |
| R6 | **Owners can renounce.** All six contracts inherit `renounceOwnership`. On the reserve or distributor it freezes the remaining mining SIDE; on the vault, a bad Holding could no longer be revoked. | `Ownable2Step` | Override it to revert. |
| R7 | **`FeeSchedule._validate` is too loose.** It allows the treasury to be the Holding (unfilled settles revert, and fees self-transfer while mining counts them) and allows 0-bps tiers. | `FeeSchedule.sol:91-100`; `SidequestHolding.sol:467` | Tighten `_validate`. ADR-0020's tool already refuses such schedules. |
| R8 | **VV2-001 share inflation (accepted and disclosed 7 Oct).** After repeated near-total slashes, a hostile queued backer can block deposits to that pool, including the account's mining claims. | `StakeVault.sol:299-301`; ADR-0014 edge 3 | Fix in the next vault redeploy. |

## Handled by mining v2 (ADR-0020; no contract change)

| Finding | Before | v2 |
| :--- | :--- | :--- |
| Creators earn 30× more mining for hiring unbacked workers | fee-based credit | volume credit × held-tier boost |
| Borrowed backing at activation wins the lowest tier | full fee discount (contract) and full mining | fee discount only; the boost uses backing held through the epoch |
| A worker dodges its share with a second agent ID | mixed IDs → 0 % | per-wallet maximum |
| Share cut right after backers commit | applies next epoch | applies only after the unstake delay |
| Dust `delegateFor` positions plant leaves forever and bloat Collect | no minimum | 100 SIDE weight floor, 1 SIDE leaf floor |
| SIDE priced as a fee token, unpegged tokens | unchecked | refused (mainnet: pegged only, ±1 %) |
| A run replays from deployment (58 min on testnet; it passes the 7-day epoch on mainnet within about 9 months) | full replay | chained checkpoints |
| Recompute refuses once a later epoch is funded; a skipped epoch's budget expires | `replayLots` | `--recompute` mode; runbook order |

## Accepted, unchanged

- Same-owner self-hire is allowed (only the same address is blocked). Mining stays bounded at half the credit.
- Tier griefing by delegate, queue or claim (STAKE-5).
- The HR-001 consequences: penalties end at expiry.
- A creator can choose its own arbitrator (ACL-7).
