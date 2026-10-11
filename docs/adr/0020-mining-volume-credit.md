# ADR-0020: Mining v2: volume credit with a backing boost

Date: 2026-10-10. Status: accepted (Kris, 10 Oct). Amends ADR-0011's mining rule and ADR-0018's backer-share rule.
No contract changes; the new rule starts at a configured epoch (`mining.creditRule.fromEpoch`).

## Context

Mining v1 credits each paid job with its treasury fee: emission = 0.5 × fee USD, 60 % to the worker and 40 % to the
creator. The fee depends on the worker's backing tier: 30 % below 10k SIDE, 10 % from 10k, 3 % from 100k, 1 % from 1M.
So the same $100 job mints $15 of SIDE when the worker is unbacked and $0.50 when it is fully backed.

That rewards the wrong side:
- staking still pays for workers, but less than it should;
- creators earn 30× more mining for hiring unbacked, unaccountable workers.

Crediting raw volume instead would invite wash trading: LooksRare paid rewards by volume share and about 95 % of its
volume was self-dealing.

## Decision

### Credit

1. **Inputs per counted fee.** Each counted fee keeps its activation's exact amounts: `gross = fee + net + bonus`,
   from `Activated` and the job's last `ToppedUp` before the fee. The fee schedule in force at activation comes from
   `ScheduleExecuted` logs.
2. **Boost.** It comes from the tier, as the lower of:
   - the tier snapshotted at activation;
   - the tier of the worker's backing held through the epoch: the smaller of its `stakeOf` at the epoch's start and at
     its end, replayed from vault events.

   Tier ranks 0–3 boost 0.4, 0.6, 0.8 and 1.0. Backing borrowed for one activation lowers the fee but does not raise
   mining.
3. **Credit.** `credit = min(gross × lowest tier rate × boost, fee)`. With today's tiers a $100 job credits $0.40,
   $0.60, $0.80 or $1.00.
4. **Emission and splits.** Emission = 0.5 × credit USD at the SIDE price, within the budget. The 60/40 split,
   contributor split, backer split and funding rule are unchanged; they run on credit instead of fee USD.
5. **Refusals.** The tool refuses a run when:
   - an activation does not match its fee;
   - a bonus fee does not round as the contract does;
   - the replayed backing disagrees with an activation's snapshotted tier;
   - the fee schedule is degenerate (not four strictly falling rates, or a lowest rate of 0).

**Why it is safe.** Every job pays at least the lowest rate, so credit never exceeds the fee paid, and mining returns at
most half of it. Faking volume always costs more than it mints, at the reference SIDE price.

### Backer share (amends ADR-0018)

6. **Per wallet.** A worker's share is per wallet. It is the highest share among the agent IDs the wallet has worked
   under, before the epoch and inside it. A worker cannot dodge its share by doing one job under a second agent ID with
   0 %.
7. **Changes and notice.** A raise applies from the next epoch. A cut applies only after the vault's unstake delay
   (3 days on testnet, 14 on mainnet), so backers can leave before it reaches them. Formally: an epoch uses the highest
   value in force during the unstake delay before it starts.
8. **Dust.**
   - Positions below 100 SIDE of shares carry no weight.
   - Backer payments below 1 SIDE stay with the worker, and leaves below 1 SIDE are dropped.
   - The recorded positions list only weighted rows.

   One cheap `delegateFor` can no longer plant a leaf in every later epoch.

### Prices

9. **Price list rules.** The price list may not value SIDE itself as a fee token above the SIDE reference price. On
   mainnet it lists only USD-pegged tokens, priced within 1 % of $1.

### Checkpoints

10. **Chained state.** Each v2 epoch also publishes `mining/state-<n>.json`: the vault, fee-schedule, activation,
    agent-ID, share and funding state at its last block. Its hash is recorded in the epoch's `inputs.checkpoint`.
    - The next run checks the previous epoch on chain: `rootOf(k).dataHash` must equal the hash of its inputs, and the
      state hash and block hash must match.
    - It then replays only the new blocks, not history from deployment. Epoch 29 took 58 minutes that way.
    - A `--from-genesis` run must reproduce the same bytes.
    - `--recompute` re-verifies any published epoch, v1 or v2, even after later epochs are funded.

### Hosted agents

11. **Standing permission.** Hosted agents set their own share with a standing permission. The operator approves it
    once:
    - it allows only `setMetadata(agentId, "sidequest.backerShareBps", uint16)` on the identity registry, for that one
      agent;
    - it lasts at most 30 days and at most 20 calls.

    The agent's `set_backer_share` redeems it, or asks for approval when none is live. It cannot move funds or change
    any other setting.

## Consequences

- **Volume, not fee size, earns mining**, and backing raises it. Workers stake to lower fees and raise mining, and
  creators are drawn to backed workers. Backers of a sharing agent share in that boost.
- **Emission per job is much smaller than v1 for unbacked work.** That is the cost of staying wash-safe. With 0.5 of
  the credit paid out, self-hiring at the 1 % tier breaks even only if SIDE trades at twice the reference price.
- **Still verifiable, not trustless,** as in ADR-0018. The reference price depends on the official pool, which is not
  yet configured; see `docs/mainnet-gate-findings.md`.
- **Published epochs keep their v1 rule.** Testnet switches at the first epoch after release, and mainnet starts at
  epoch 0.

## Amendment — 11 October 2026

The Safe still signs price lists, funds epochs and sets roots. A GitHub Action
now computes epochs for the `dev` stage on Monad testnet and publishes them
after the root is on chain. Prod and mainnet remain manual until Kris enables them.
