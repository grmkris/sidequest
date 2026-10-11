# Delegated staking API

StakeVault v2 uses **backing** and **positions**. Backing is the total SIDE
behind an agent account. A position is the shares one wallet owns behind that
account. Anyone can back anyone; the position owner keeps the right to queue and
withdraw its shares. Shares remain at risk until withdrawal succeeds.

HTTP read results use decimal strings for SIDE base-unit amounts, shares,
generations and block numbers. Product discovery uses a verified indexer checkpoint:

| Tool or route | Purpose |
| --- | --- |
| `get_stake({account?, wallet?})` | Read one account's assets, active/reserved/queued backing, fee tier, and the selected wallet's position. `account` defaults to the selected wallet; `wallet` defaults to the caller. |
| `list_delegations({wallet?, account?})` | Discover positions owned by `wallet`, or all indexed positions behind `account`; optional filters may be combined. |
| `GET /data/backing/<account>?wallet=<owner>` | Read the backing card, delegator count/top delegators, and one owner's position. |
| `GET /data/delegations?wallet=<owner>&account=<account>` | Discover positions, then read canonical vault values at one checkpoint block. Either filter is sufficient. |
| `POST /api/get_stake` | The existing read endpoint; JSON body accepts optional `account` and `wallet`. |
| `POST /api/list_delegations` | MCP/API equivalent of `list_delegations`; filters go in the JSON body. |

Discovery comes from the indexer over vault events. Canonical values come from
`poolOf` and `positionOf` at the same block. The API reports `source: "index+vault"`,
the checkpoint `blockNumber`, token and vault addresses, and decimal-string
amounts. It refuses when the checkpoint is stale, behind the vault deployment or
divergent from the public chain.

Each discovered position includes `account`, `delegator`, `shares`, `activeShares`,
`queuedShares`, `value`, `activeValue`, `queued`, `unlockAt`, `generation`,
`staleGeneration`, `shareBps` and its `backing`. `unlockAt` is a Unix-seconds number;
`shareBps` is the owner's fraction of pool shares in basis points. Retired positions
remain discoverable with zero value. The backing card includes `assets`, `active`,
`reserved`, `available`, `queued`, a `tier` with the next threshold, `delegatorCount`,
`topDelegators` (up to ten current nonzero positions) and optional `position`.
The retained `get_stake` fields `staked` and `unstaking` mean active pool backing
and the selected owner's queued value, respectively; `queued` is the pool's queue.

Wallet-paid write tools use whole-token decimal `amount` input (for example,
`"10000"` SIDE) and return unsigned transactions. Invoke them with a JSON body
at `POST /api/<tool>`:

- `stake({account?, amount})` prepares SIDE approval plus
  `delegate(account, amount)`. The payer is the caller and owns the position;
  `account` defaults to the caller.
- `request_unstake({account?, amount})` converts the requested SIDE amount to
  owned, unqueued shares and prepares `requestUndelegate(account, shares)`. The
  conversion rounds so it never asks for more than the owner's position.
- `cancel_unstake({account?})` prepares `cancelUndelegate(account)`.
- `withdraw_stake({account?})` prepares `withdraw(account)` and pays the caller's
  position value after the cooldown and any `StillBonded` condition clear.

For managed agents, `account` is the agent wallet and the routine signer may act
only on its own self-position. An operator-funded position belongs to the operator
and must be exited by that wallet. An agent-owned exit is sent only after an exact
operator approval; its one-off grant pins `requestUndelegate(agentWallet,
exactShares)`, one call and a 600-second expiry. Routine grants cover only
`cancelUndelegate` and `withdraw` for that same self-position.

Queueing is allowed while a bond is open. Queued shares stop counting for fee tiers
and new bonds immediately, but remain slashable until withdrawal. A new request
restarts the whole queue's cooldown: three days with the fresh testnet clocks and fourteen days in
production. `StillBonded` can extend the wait until remaining assets cover open
reservations. Backing earns no share of job revenue.
