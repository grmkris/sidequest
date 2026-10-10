# Work mining: one epoch (B8)

After the Safe has funded and published the epoch root, the coordinator publishes
the computed file for Collect:

```
bun run mining:publish <epoch-n.json> --stage dev|prod
```

This checks the selected network config, RPC chain id, every claim/proof, the
serialized standard-v1 tree (encoding, nodes, values and indexes), total and
recomputed `dataHash`, then requires the file's root/total/dataHash to equal
`EpochDistributor.rootOf(epoch)`. It uploads the captured file bytes to
`mining/epoch-<n>.json` in the existing Manifests bucket and reads them back to
compare sha256. A failed readback exits unsuccessfully; retry the same file.
It sends no on-chain transaction and never creates or changes Alchemy state.

Credentials come from the chosen stage environment:
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `MONAD_RPC_URL`. Existing stage/network env
settings must agree with `--stage`. Values, bucket names, URLs and provider
error bodies are never printed. `infra/<stage>.json` supplies the network, chain id,
origin and exact resource identities. Publication requires exactly one Api Worker
with the expected ownership tags and the exact name in that file, matching runtime
stage/network bindings, and the exact Manifests bucket binding and bucket readback.
`infra/dev.json` and `infra/prod.json` select independent resources on the same testnet deployment.
Unit tests use fake R2 only; the
coordinator runs live publication.

`bun run mining:epoch <n>` computes epoch `n`'s rewards from chain data alone, then writes the Merkle tree the
`EpochDistributor` pays from, plus the Safe's two calls. It never reads the indexer or D1. Rules: ADR-0011, D12 #2, D17
(rule v1, below); [ADR-0020](../../docs/adr/0020-mining-volume-credit.md) (rule v2, from `mining.creditRule.fromEpoch`).

```
bun run mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed price list JSON> --out <dir>
                      [--rpc <url>] [--config <config JSON>] [--page <blocks>] [--previous-prices <signed JSON>]
                      [--logs rpc|hypersync]
bun run mining:epoch <n> --recompute <published epoch-n.json> [--network ...] [--rpc <url>] [--config <config JSON>]
```

- **RPC.** `--rpc`, else `MONAD_TESTNET_RPC_URL` or `MONAD_MAINNET_RPC_URL`. It reads only and is never printed.
- **Config.** `--config` defaults to `contracts/config/<network>.json`; its `deployment.sidequest` and every
  `sidequest-v1` pair are used. The fork rehearsal passes a scratch config.
- **Rule choice.** The config's `mining.creditRule.fromEpoch` picks the rule per epoch: epochs below it run rule v1,
  epochs from it run rule v2. With no `creditRule`, every epoch is v1. Published epochs keep v1; mainnet sets
  `fromEpoch` 0, and testnet sets the first epoch after release.
- **`--recompute <file>`.** Re-derives a published epoch, v1 or v2, from chain data and the signed prices inside the
  file, and compares it with the file: same root, same `dataHash`. It works even after later epochs are funded, which a
  normal run refuses. It writes nothing and sends nothing.
- **Paging.** Logs are read with `eth_getLogs` in pages of `--page` blocks (default 1000; it must be a positive integer). A page the RPC refuses is
  halved and retried.
- **Tests.** `bun test scripts/mining` runs the fixture tests. The anvil fork run is step 7 of
  `contracts/script/rehearse-launch.sh`.
  - **Test floor:** 178 passed / 3 skipped across 23 files, recorded on 10 October 2026 with
    `heavy bun --no-env-file test scripts/mining` and RPC variables unset. The coordinator runs the three fork tests;
    the backer-share and credit fork tests check that a backer claim grows `positionOf(backer, backer)`.

## Log sources

The public Monad RPC caps `eth_getLogs` at 100 blocks. A full replay can therefore take hours even though contract
reads are quick. Rule v2 and recomputation accept `--logs hypersync`, with `HYPERSYNC_API_TOKEN` supplied by environment
name. HyperSync reads the entire requested range, follows its own pages and retries rate limits; it refuses stalled or
incomplete paging. Testnet uses `monad-testnet.hypersync.xyz`, mainnet `monad.hypersync.xyz`. The token is sent only in the
authorization header. All block, integrity and `eth_call` reads still use `--rpc`.

The default is `--logs rpc`, with the shrinking `--page` pager above. Normal v1 epoch runs retain their original RPC
path. Use RPC recomputation as the independent check of a HyperSync-built artifact:

```
bun run mining:epoch <n> --recompute <dir>/epoch-<n>.json --network monad-testnet --logs rpc --from-genesis
```

For large independent replays, use a keyed RPC that supports larger log ranges. Free-tier RPCs can have the same or
smaller caps as the public endpoint. `--from-genesis` also checks the checkpoint chain without loading saved state.

## What it counts (rule v1)

This is the rule every epoch below `fromEpoch` keeps. Rule v2 is the next section.

1. **Window.** From `MiningReserve.epochStart(n)` to `epochEnd(n)`, using the deployed reserve's clock getters.
   Production epochs are 72 h then 7 days; testnet may use minute-scale constructor clocks. Never infer the window
   from those production durations. A log counts when its block timestamp is at or after the start and before the end.
   - Everything is read up to the **finalized** head, which must be past the window's end, so a reorg cannot change
     what was counted.
   - The window's last block hash is in `inputs.window.toBlockHash`.
2. **Events.** `FeeCharged`, `PayoutOwed` and `OwedWithdrawn` from every `sidequest-v1` Holding in the config, over the
   window's blocks.
3. **Priced tokens only.** A fee counts only if its token is on the epoch's signed price list.
4. **Received fees only.** A fee counts only once the treasury holds it.
   - `_settle` emits `FeeCharged`, then pays the worker, then the treasury.
   - A refused leg is a `PayoutOwed` after the fee in that transaction, for the same Holding, job and token.
   - The treasury's leg is always `FeeCharged.amount`. So a refused leg counts as the treasury's when it is not to the
     worker, or when its amount is the fee's. A worker that is also the treasury, or a worker leg of exactly the
     fee's amount, therefore fails closed: the fee is not counted.
   - Such a fee counts only if the treasury withdrew that token later in the window. `withdraw` takes the whole owed
     balance, so any later `OwedWithdrawn` to the same address and token clears it.
5. **Fee value.** `fee USD = amount × usdPrice ÷ 10^decimals`, 18 decimals, rounded down.
6. **Emission.** `min(budget, 0.5 × Σ fee USD ÷ max(factoryUsdPrice, 10^14))`, in SIDE wei. `10^14` is $0.0001.
7. **Budget.** Each scheduled epoch budget is one lot. Replay `EpochFunded(epoch < n)` oldest-first against the
   unspent lots of that epoch and its four predecessors. Only lots `n-4..n` remain usable; older balances expire
   permanently in the reserve and never become a new lot. Epoch 0 gets `3W/7`, epochs 1–26 get `W`, and epoch 27
   starts halving every 26 epochs, capped at the 500M reserve. The tool verifies the deployed cumulative schedule.
   Run epochs in order; funding after a later epoch or funding beyond live lots refuses.
   - The tool refuses while `totalFunded()` differs between latest and the finalized head (a funding transaction not
     yet final), and when the logs don't add up to it.
   - `fund` adds to what is already there, so the printed call is only right while `totalFunded()` is what the run
     read. `calls.fund.expect` records that value; if it has moved, run the tool again.
8. **Split.** 60 % of the emission to workers and 40 % to creators, each pro rata by fee USD. Arbitrators get nothing.
   - The base fee belongs to the original creator; `FeeCharged.bonusPart` belongs to top-up contributors pro rata
     by contribution amount. Their complete `ToppedUp` history may precede the fee window. Cumulative bonus values
     must match the replay; missing history refuses instead of assigning that share to the original creator.
   - An account that was both worker and creator gets one leaf with both parts.
   - Each part is rounded down, and zero leaves are dropped.
   - `total` is the sum of the leaves, so it can sit a few wei under the emission.
9. **Backer share (opt-in).** A worker can give 0–10000 basis points of its worker mining slice to its backers;
   unset means 0. The ERC-8004 identity registry stores `sidequest.backerShareBps` as `abi.encode(uint16)`.
   - The last `MetadataSet` for that agent/key **strictly before `fromBlock`** applies; changes in the epoch take
     effect next epoch. Exactly 32 bytes are decoded as uint256 and capped at 10000; any other length means 0.
     The indexed key is filtered by `keccak256(bytes("sidequest.backerShareBps"))`. Metadata history starts at
     `deployment.sidequest.block`.
   - Match `FeeCharged` to the same Holding's earlier `Activated(jobId, worker, agentId, ...)`. A missing match
     means 0. A worker whose counted jobs resolve to different agent IDs (or include a missing match) also gets 0:
     its combined worker allocation cannot choose one of those identities arbitrarily.
   - Replay `Delegated`, `UndelegateRequested` (sets the whole queue), `UndelegateCancelled` (clears it),
     `Withdrawn` (subtracts shares and clears the queue), and `PoolReset` from `deployment.sidequest.block`.
     `Slashed` and `Forfeited` only change assets. No historical vault or registry `eth_call` is used.
   - Active shares are shares minus queued shares, after block `fromBlock - 1` and after `toBlock`.
     Each delegator's weight is `min(start, end)`. A pool reset between those snapshots zeroes the start;
     joining inside the epoch gets no weight. The worker's own self-backing counts like every other position.
   - For worker allocation `W`, the backer cut is `floor(W × bps / 10000)`, split pro rata by weight and floored.
     The worker keeps `W - sum(backer payments)`, absorbing backer rounding. With no weighted backers it keeps
     all of `W`. Creators are unchanged; worker, creator and backer roles merge into one leaf per account.
     `EpochDistributor.claim` stakes every leaf into that account's own pool with `delegateFor(account, account, amount)`.

## Rule v2: volume credit with a backing boost

[ADR-0020](../../docs/adr/0020-mining-volume-credit.md) is the source. Window, finalized head, events, priced-token
and received-fee tests are as above; what changes is what a counted fee is worth, and who shares it.

1. **Inputs per counted fee.** The activation's exact amounts: `gross = fee + net + bonus`, from `Activated` and the
   job's last `ToppedUp` before the fee. The fee schedule in force at activation comes from `ScheduleExecuted` logs.
2. **Boost.** The lower of two tiers (rank 0-3, boost 0.4, 0.6, 0.8, 1.0):
   - the tier snapshotted at activation;
   - the tier of the backing the worker held through the epoch: the smaller of its `stakeOf` at the epoch's start and
     at its end, replayed from vault events.

   Backing borrowed for one activation lowers the fee but does not raise mining.
3. **Credit.** `credit = min(gross × lowest tier rate × boost, fee)`. With today's tiers, a $100 job credits $0.40,
   $0.60, $0.80 or $1.00. `feeUsd` is what the treasury received; `creditUsd` is what the rule counts.
4. **Emission.** `min(budget, 0.5 × Σ credit USD ÷ max(factoryUsdPrice, 10^14))`, in SIDE wei. The 60/40 worker and
   creator split, contributor split and funding rule are as in v1, but weighted by credit USD instead of fee USD.
5. **Refusals.** The tool refuses the run when:
   - an activation does not match its fee;
   - a bonus fee does not round as the contract does;
   - the replayed backing disagrees with an activation's snapshotted tier;
   - the fee schedule is degenerate (not four strictly falling rates, or a lowest rate of 0).

**Backer share, v2.** Per wallet, not per agent ID.
- A wallet's share is the MAX share among the agent IDs it has worked under, before the epoch and inside it, over the
  **share window**: from one unstake delay before the epoch's start to its first block. So a raise applies from the next
  epoch, and a cut applies only after the vault's unstake delay (3 days on testnet, 14 on mainnet).
- **Dust.** Positions below 100 SIDE of weight carry no weight. A backer payment below 1 SIDE stays with the worker, and
  a leaf below 1 SIDE is not created (its SIDE stays in the reserve). `backerPositions` lists only weighted rows.

**Price rules.** SIDE as a fee token must have 18 decimals and be priced at the SIDE reference price (the factory
price). On mainnet the list may hold only tokens in the config's `usdPegged` list, each priced within 1 % of $1. Signed
price tokens must be in address order. A list that breaks a rule refuses the run.

**Verifiable, not trustless.** Anyone can recompute an epoch from public chain data, but the Safe still funds each epoch
and publishes its root. The reference price depends on the official pool, which is not yet configured
(`docs/mainnet-gate-findings.md`, G2).

## Leaves

The leaves form an OpenZeppelin `StandardMerkleTree` with encoding `['uint256','address','uint256']` =
`(epoch, account, amount)`. Each leaf is `keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount))))`,
which is `EpochDistributor.leaf`.

`tree.ts` implements the library's format (`standard-v1`) without the dependency. Its dumps, proofs and roots are
byte-identical to `@openzeppelin/merkle-tree` 1.0.8, and `mining.test.ts` pins roots the library computed. Load a dump
with `StandardMerkleTree.load(epoch.tree)`.

## The price list (EIP-712)

A current Safe owner signs it. The tool recovers the signer and refuses unless it is in `Safe.getOwners()` (read
live) and the list is for this chain, distributor and epoch. Every listed token's `decimals` must match the token on
chain. Only EOA signatures (ECDSA) are accepted.

SIDE uses the highest available hourly mid price of `mining.officialPool` in the network config, floored at
$0.0001. The first block at/after each UTC hour in the epoch supplies the reserves. The artifact retains every
hour's block/hash, raw reserves (constant-product) or virtual active-liquidity reserves plus sqrt price and liquidity
(Uniswap v4), and missing-hour reasons. The quote token must be priced by the signed list. Missing reads use the
highest available sample; with none, epoch 0 uses the floor and later epochs require the immediately preceding
signed price list (`--previous-prices`, default `<out>/epoch-<n-1>.json`). Its signature is checked against current
Safe owners too. A signed SIDE price that differs from this rule refuses the run.

The official venue remains unset in the checked-in configs; this is recorded as `official-pool-unconfigured` and
uses the documented no-sample fallback. Before launch the coordinator must name the official pool. Supported shapes:

```json
{"mining":{"officialPool":{"kind":"constant-product","address":"<pair>","quoteToken":"<token>"}}}
```

```json
{"mining":{"officialPool":{"kind":"uniswap-v4","poolManager":"<manager>","stateView":"<view>","quoteToken":"<token>","fee":3000,"tickSpacing":60,"hooks":"0x0000000000000000000000000000000000000000"}}}
```

These examples are schema descriptions, not deployment addresses. No liquidity recipe is implicitly designated as
the official pool. The launch pool is not an oracle: one high sample can suppress everyone's emission, never inflate
it. There is no TWAP.

```ts
domain = {
  name: 'Sidequest Mining Prices',
  version: '1',
  chainId,                              // 10143 testnet, 143 mainnet
  verifyingContract: <EpochDistributor>, // deployment.sidequest.distributor
}
primaryType = 'PriceList'
types = {
  PriceList: [
    { name: 'epoch', type: 'uint256' },
    { name: 'tokens', type: 'TokenPrice[]' },
    { name: 'factoryUsdPrice', type: 'uint256' }, // USD per whole SIDE, 18 decimals; below 1e14 counts as 1e14
  ],
  TokenPrice: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },      // the token's own decimals
    { name: 'usdPrice', type: 'uint256' },    // USD per whole token, 18 decimals (USDC at $1 = 1e18)
  ],
}
```

The file `--prices` takes holds the integers as decimal strings:

```json
{
  "message": {
    "epoch": "0",
    "tokens": [{ "token": "0x7547…b603", "decimals": 6, "usdPrice": "1000000000000000000" }],
    "factoryUsdPrice": "100000000000000"
  },
  "signer": "0x…",
  "signature": "0x…"
}
```

`signer` is optional; when present it must match the recovered address. `domain` may be included for reference, but
the tool rebuilds the domain itself.

**Signing on the command line** uses a Foundry keystore, as on mainnet. It builds the typed data, signs it with
`cast wallet sign --data --from-file`, checks the recovered address, and writes the signed file:

```
bun scripts/mining/sign-prices.ts <unsigned.json> --network monad-testnet --out <signed.json> \
  --account <keystore name> --password-file <0600 file>    # or --keystore <path>
```

`<unsigned.json>` is the `message` above, on its own. The helper also reads `--config` and refuses `--private-key`
unless the network is testnet.

## Output: `<out>/epoch-<n>.json`

```
{ chainId, epoch, window: { start, end, fromBlock, toBlock },
  priceList: { message, signer, signature },
  budget, feeUsd, factoryUsdPrice, demand, emission, total, root, dataHash,
  inputs, tree, claims: { <account>: { amount, proof } },
  calls: { fund: { to, data }, setRoot: { to, data } } }
```

A v2 file also has `rule: 2` and `creditUsd`. Under v2, `demand` and `emission` come from `creditUsd`, not `feeUsd`.

Integers are decimal strings, and addresses are lowercase.

- **`inputs`** is the canonical record:
  `{ chainId, epoch, window, holdings, priceList, factoryPriceEvidence, budget, fees, topUps }`.
  - `holdings` is sorted.
  - `fees` lists every `FeeCharged` in the window in chain order, with its position (block, logIndex, tx, holding),
    fields, `status` (`counted`, `unpriced` or `owed-to-treasury`) and `usd`.
  - `factoryPriceEvidence` records official-pool hourly samples, missing reads and the signed fallback price.
  - `topUps` records the complete contribution history for paid jobs with a bonus fee, in chain order.
  - When any counted worker has a positive share, `backerShares` lists every counted worker's `agentId`, `worker`,
    `bps` and `set` (`block`, `logIndex`, `tx`, or null when unset), sorted by worker address. `backerPositions`
    lists each positive-share worker's `account`, `delegator`, `start`, `end`, `weight`, sorted by account then
    delegator. With all shares 0, **both keys are omitted** so legacy inputs, `dataHash` and roots remain identical.
- **Inputs, rule v2.** Keys in this order:
  `{ chainId, epoch, rule, window, shareWindow, holdings, priceList, factoryPriceEvidence, budget, feeSchedules, fees,
  topUps, backing, backerShares, backerPositions }`.
  - `rule` records the version, `fromEpoch`, `payoutBps`, the 60/40 split, `boostBps`, `minBackerWeight`, `minLeaf`,
    `unstakeDelay` and the price rules (`peggedOnly`, tolerance, pegged tokens).
  - `shareWindow` is `{ start, block }`: the share window's first timestamp and first block.
  - `feeSchedules` lists every fee schedule set, in chain order.
  - Each fee's `credit` is `null` when it earns none, else its activation, `agentId`, `feeBps`, `fee`, `net`, `bonus`,
    `gross`, the schedule used, `floorBps`, `tier` (`activation` and `backing`), `boost`, `amount` and `usd`.
  - `backing` lists each worker's `stakeStart` and `stakeEnd`.
  - `backerShares` has one row per worker wallet, with `bps`, the sorted `agentIds` it worked under and the `source`
    setting event. `backerShares` and `backerPositions` are always present under v2.
- **`dataHash`** = `keccak256(utf8(JSON.stringify(inputs)))`, over `inputs` exactly as written. Parse the file,
  stringify `inputs`, and hash it to check.
- **`tree`** is `StandardMerkleTree.dump()`, and **`claims`** carries each account's amount and proof for
  `EpochDistributor.claim(epoch, account, amount, proof)`.
- **`calls`** are for the Safe, in this order:
  1. `calls.fund`, present only while the epoch still needs funding. It is `MiningReserve.fund(n, amount)`, where
     `amount` is the remainder (`total` minus what `n` already has). Leaf-rounding dust stays in the reserve's
     unspent budget rather than being funded to the distributor. Its `expect` records `totalFunded()`
     and the epoch's funded amount as this run read them.
  2. `calls.setRoot`: `EpochDistributor.setRoot(n, root, total, dataHash)`.

  `fund` is additive, so the Safe nonce guards it (D18):
  - Read `Safe.nonce()` and `MiningReserve.totalFunded()` at one block. `totalFunded` must still equal
    `calls.fund.expect.totalFunded`; otherwise run the tool again.
  - An owner signs the SafeTx at exactly that nonce, with ECDSA. Never use a pre-validated (v = 1) signature, which binds
    no nonce. A retry is recomputed, never re-signed at a later nonce.

  `/admin` does all of this. The terminal path is in `docs/mainnet-runbook.md` §4, and R7 rehearses it. `setRoot` is an
  ordinary `execTransaction`. Keystores are mandatory on mainnet. With no counted fees there is no tree and no calls.
