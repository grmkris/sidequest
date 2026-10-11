# ADR-0022: No work mining at launch

Date: 2026-10-11. Status: accepted (Kris, 11 Oct). Supersedes [ADR-0018](0018-backer-share.md) and
[ADR-0020](0020-mining-volume-credit.md), and amends the mining part of [ADR-0011](0011-sidequest-v1.md). The launch's
token model gets its own ADR.

## Context

ADR-0011 planned a mining reserve that emits SIDE per epoch to the creators and workers of paid jobs. ADR-0018 let a
worker share its slice with its backers, and ADR-0020 credited job volume with a backing boost. Testnet epochs 29, 44
and 45 ran end to end on dev, with a dev-only pipeline for prices, compute and publishing.

For the mainnet launch Kris decided (11 Oct, the decision record in myplan note 22):
- SIDE launches on nad.fun as an existing token, so there is no Sidequest-minted supply or reserve to emit;
- there is no mining at launch, with backer share and team vesting removed with it.

## Decision

Mining is removed everywhere, not hidden behind a flag:
- **Off-chain:** the epoch tool (`scripts/mining`), the dev pipeline and its GitHub workflow, price-list uploads and
  `/data/mining`, `mining_proof`, Collect's mining claims, fee_quote's mining fields, the `/admin` Prices and Mining
  sections, backer share (`set_backer_share`, the `sidequest:backer-share` permission, its directory field and Edit
  profile control), and their docs and skills.
- **Contracts:** MiningReserve, EpochDistributor, MiningSchedule and team vesting leave the recipe in the launch build.

Collect stays: it closes jobs, refunds top-ups and withdraws owed payouts and unstaked SIDE. Staking, fee tiers and
bonds are unchanged.

## Consequences

- The last state with mining is the `mining-final` tag (origin, `ed006395`), which also holds the dev pipeline.
- Testnet keeps its deployed contracts. Published epochs stay claimable directly on the distributor with a proof from
  the tag's tooling, but Sidequest no longer serves proofs or offers the claims.
- Stored grants of the retired `sidequest:backer-share` permission are skipped in listings rather than re-parsed. On
  chain they can only set a metadata value nothing reads, and they expire on their own.
- D1 tables written only for mining or backer share (`backer_share_checkpoint`) stay, unused: migrations are additive.
- Bringing mining back is a new decision and a new ADR, not a revert.
