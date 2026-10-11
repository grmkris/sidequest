# ADR-0018: Backer share in work mining

Date: 2026-10-10. Status: superseded by [ADR-0022](0022-no-mining-at-launch.md) (11 Oct): no mining at launch. Extends ADR-0011's mining rule and the profit-sharing note in
ADR-0014. No contract changes and no redeploy; this ADR does not by itself establish a live epoch.

## Context

Backing an agent locks SIDE behind its account. Backing lowers the agent's fee tier, covers its bonds, and is slashed
with it, but until now it earned the backer nothing:

- every job fee goes to the treasury at settlement (`SidequestHolding._settle` → `FeeSchedule.treasury()`);
- work mining paid only workers (60 %) and creators (40 %), each into its own self-position;
- ADR-0014 recorded that positions "neither distribute job revenue nor promise earnings today".

A trustless fee cut paid by the contracts at settlement needs a vault reward ledger and a redeploy. That is the next
step, not this decision.

## Decision

1. **Workers choose a backer share.** Each agent publishes the part of its work-mining slice that goes to its backers,
   like a validator commission:
   - **Range:** 0–100 %, in basis points 0–10000.
   - **Default:** 0, so it is opt-in.
   - **Storage:** on chain as ERC-8004 metadata on the existing identity registry,
     `setMetadata(agentId, "sidequest.backerShareBps", abi.encode(uint16 bps))`. Only the agent's owner or approved
     operator can set it. Each change emits `MetadataSet`.
   - **Decoding:** a value of exactly 32 bytes is read as a uint, and values above 10000 count as 10000. Any other
     value, or none, counts as 0.
2. **A change applies from the next epoch.** An epoch uses the last `MetadataSet` for that agent and key strictly
   before its first block. A worker cannot cut its share after backers have committed for the epoch.
3. **Split.**
   - Creators keep their 40 %.
   - Each worker's slice `W` (its pro-rata part of the 60 %) splits as:
     - `W × share` to the wallets backing that worker, pro rata by weight;
     - the remainder to the worker, which also absorbs rounding, so no new dust appears.
   - With no weighted backers, `W` stays with the worker.
   - The worker's own self-position counts as a backer position.
4. **Weight = min(active shares at the epoch's start, at its end)**, per (account, delegator).
   - Active shares exclude a position's queue (shares leaving).
   - A position reset by a full slash between start and end has start counted as 0.
   - Positions are rebuilt from vault events (`Delegated`, `UndelegateRequested`, `UndelegateCancelled`, `Withdrawn`,
     `PoolReset`), because Monad nodes don't serve historical state.
   - Taking the minimum means backing late or leaving early earns nothing extra. Together with the unstake delay, that
     is enough against last-minute backing.
5. **Payout is unchanged.** Backers are more leaves in the same Merkle tree. `EpochDistributor.claim` stakes each leaf
   into its account's own pool (`delegateFor(account, account, amount)`): a backer's reward lands staked in the
   backer's own wallet, at risk only for jobs that wallet posts or takes. Collect and `mining_proof` already serve any
   wallet's leaf.
6. **Recorded inputs.**
   - When any worker in the epoch has a share above 0, the epoch's `inputs` record `backerShares` (agent, worker, bps,
     and the setting event) and `backerPositions` (start, end and weight per backer).
   - The `dataHash` covers both.
   - An epoch where every share is 0 is byte-identical to an epoch computed before this ADR.

## Trust model

Work mining, backer share included, is **verifiable, not trustless**.

**What anyone can check:** every input is public:

- the Holding fee events;
- the vault events;
- the registry metadata events;
- the Safe-signed price list.

The tool (`scripts/mining`) is deterministic, and each published `epoch-<n>.json` carries its inputs, `dataHash`, tree
and proofs. Anyone can recompute an epoch and compare its root with `EpochDistributor.rootOf(epoch)`.

**What is trusted:** the Safe funds each epoch and publishes its root. It could publish a wrong root or withhold one;
others could prove that, but not prevent it.

## Consequences

- Backing has an upside where an agent chooses one. The app shows each agent's share (agent page, the Agents directory
  and the backing picker) and lets the owner set it in Edit profile. MCP offers `set_backer_share`, which returns a
  transaction the owner signs.
- The share is a market signal, not a promise. An agent at 0 % shares nothing. Mining remains bounded by the fee-based
  emission and the reserve budget.
- **Next step (trustless):** with the next contract redeploy:
  - a vault reward ledger: a per-pool, per-token reward-per-share accumulator, settled on every share change;
  - a settlement-time fee cut paid to backers in the job's token.

  It replaces this off-chain split for job revenue, and needs its own ADR, tests and migration.
- ADR-0014's "no profit payments" now reads as "no on-chain profit payments"; its profit-sharing note is implemented
  off chain here.

**Amended (10 Oct 2026) by [ADR-0020](0020-mining-volume-credit.md):** from its cut-over epoch, the share is per
wallet (the highest share among the agent IDs the wallet works under), a cut applies only after the unstake delay,
positions below 100 SIDE carry no weight, and payments below 1 SIDE stay with the worker.
