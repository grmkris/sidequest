# ADR-0017: Required creator bond and unfilled forfeit

Status: accepted for G1e implementation; deployment remains separately gated.
Date: 2026-10-08

**Amended (11 Oct 2026, launch decisions in myplan note 22):** SIDE launches on nad.fun with a 1,000,000,000 supply. So
the mainnet floor is **1,000,000 SIDE** and its immutable cap **100,000,000 SIDE**
(`contracts/config/monad-mainnet.json`). Testnet keeps 10 and 1,000. The 10,000 / 100,000 mainnet values below are
superseded.

## Context

Gas alone is a weak deterrent to fake jobs. Refundable escrow and optional bonds let a creator publish cheaply and
recover everything after expiry. A board-only filter cannot protect other clients or direct contract calls.

## Decision

Require creator backing for every publication. The initial minimum is 10 SIDE on testnet and 10,000 SIDE on mainnet.
The owner Safe may adjust the minimum for future publications, above zero and within immutable caps of 1,000 and
100,000 SIDE respectively. The existing three-call hosted hire remains allowance pull, reward approval and publish.
Browser wallets can stake sufficient SIDE backing before publishing, batching where supported. Testnet links its faucet.

A listing that ends without ever activating forfeits a snapshotted percentage of the full creator bond to the current
`FeeSchedule.treasury()`, then releases the remainder. Initially the rate is 2500 bps; the Safe may set future rates from
zero through the hard cap of 5000 bps. Floor and rate changes never rewrite a published listing. Cancellation strictly
before 600 seconds after publication is free; at 600 seconds it forfeits. Expiry always forfeits, even before the grace
window ends. SIDE is transferred, not burned, and forfeiture does not enter earned-work fees or mining accounting.

The creator calls `cancel` to recover the escrow. Anyone can terminate an expired job through the core's `claimRefund`
and settle Holding, recovering rewards and freeing backing. These are explicit calls, not automatic timers. If nobody
calls, reservations stay open and withdrawal remains blocked until settlement.

Use `funded` as the exact ever-activated marker. The unfilled rule is an explicit exception to HR-001's expiry
protection; every activated-job penalty still releases instead of burning at or after expiry. Vault forfeiture consumes
only the caller Holding's reservation, shares losses across active and queued positions pro-rata, and resets an empty
pool's generation just like slash. Existing event signatures stay intact; `BondForfeited` records the treasury receipt
and `BondReleased` records the remainder.

G1e uses a fresh full recipe deployment and bootstrap admission. The superseded replacement-pair scripts are archived.

## Alternatives rejected

- Upfront posting fee: rejected by Kris. Legitimate mass publication would incur a permanent charge even for completed
  jobs and would need separate fee allowances. No fee, burn or swap is part of publication.
- Moderator-triggered slash: rejected. It would introduce subjective censorship and confiscation powers.
- Reputation discounts: deferred. History is susceptible to sybil and wash activity, and a uniform bond is easier to
  inspect and enforce through every client.
- UI-only filtering: useful later, but insufficient as the economic protocol rule.

## CROPS and accepted consequences

Censorship resistance: any creator with sufficient backing can publish through the SDK or direct contract calls.
No moderator decides whether the forfeiture applies. The Safe retains bounded economic policy control; the core's
existing pause and upgrade powers and hosted wallet/API/RPC dependencies remain disclosed in the trust guide.

Open source and freedom: the MIT-licensed contract, ABIs, SDK, indexer fold and UI live in this repository, so clients can
inspect and reproduce the rule. Hosted access is convenient; direct wallet calls and independent clients are the escape
path from hosted service refusal.

Privacy: publication, timestamps, creator and treasury addresses, bond amounts and forfeitures are public. This rule adds
no identity or history-based classification. Existing hosted identity and wallet provider exposure remains.

Security: caps bound future changes, snapshots preserve published economic terms, and reentrancy guards and vault
reservation accounting protect backing. Treasury rotation uses FeeSchedule's existing timelock and invalid zero or
Holding treasury destinations are rejected during forfeiture. Queued backing remains exposed until reservations settle.

A creator whose chosen worker never activates also forfeits: the chain cannot distinguish worker no-show from an
abandoned fake listing. A spam listing can remain visible for ten minutes and cancel for free. The rule raises the
capital cost of sustained open spam, but is not a complete content filter or sybil defense. Forfeiture is rounded down;
very small owner-configured floors can therefore weaken the deterrent.
