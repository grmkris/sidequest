# Gas sponsorship

Sidequest v1 uses a root ERC-7710 delegation from the user's EIP-7702 DeleGator account to the configured relay.
The wallet signs its own delegation. The board holds only the operational relay key, never a user key.

The permission lasts 24 hours and allows at most 100 calls. Its known on-chain enforcers restrict targets to the
current v1 Holding, Evaluator, Vault and core, restrict methods to decision D15, forbid native value, and enforce
call count and expiry. Vault work allows `cancelUndelegate(account)` and `withdraw(account)`.
It grants no permission to approve tokens, publish, top up, add SIDE backing, request an exit,
change a Holding veto, change a payout receiver, or perform owner, arbitrator or verifier actions.

Anyone can back anyone with SIDE. The operator signs `delegate(agentWallet, amount)`
from wallet[0], approves SIDE to the vault and pays gas. The operator owns that
position and withdraws from its own wallet. Backing means the total SIDE behind
an account; a position means one owner's shares behind it. The vault holds the
tokens. Routine grants add no principal-spending targets.

Managed-agent vault calls are restricted to its own self-position, which
`delegateFor(account, account, amount)` creates. An exact operator-approved agent
exit uses the one-off `unstake` grant: `requestUndelegate(agentWallet, exactShares)`,
account and calldata pinned, one call and 600-second expiry. The routine signer
signs only after verifying that exact decision. Operator-funded positions are
outside agent exits and sweeps.

Managed-agent exits and earnings sweeps now require Sidequest's hosted API and the
relay: Explore's browser emergency recovery (Privy owner + plain RPC) was removed on
6 Oct 2026. During an API or relay outage, funds and permissions stay at their
recorded on-chain addresses until service returns; nothing moves them in the
meantime. See the ADR-0013 amendment.

Active backing sets the tier and supports new bonds. Queueing is allowed while
bonded, stops the queued shares counting immediately and restarts the whole
queue's cooldown (three days with the fresh testnet clocks, fourteen days in production). All shares
remain slashable until successful withdrawal. After unlock, `StillBonded` prevents
withdrawal if remaining pool assets cannot cover reservations. Canceling restores
active backing. Wallet rotation does not move either owner's positions.

Managed-agent publishing is a separate allowance-funded exception. The operator
signs a token allowance with a fixed-period spending cap and expiry. Within that
cap the relay atomically redeems the exact reward, approves Holding under B2 and
publishes under B1. A failed publish reverts the pull and approval. Over-limit or
unknown-token hires wait in Approvals for an operator-signed exact one-off
allowance. For an unknown token, only after verifying that decision may the routine
signer sign agent-approve-once: that token, Holding spender, exact calldata, one
call and ten-minute expiry.

Agent B1 covers D15 plus publish and delegation redemption/disable; B2 approves
known reward tokens to Holding (SIDE is excluded); B3 transfers configured
tokens, including SIDE, only to the operator. The browser always uses the
operator wallet. These authorities and the executor's checks are recorded in [ADR-0013](adr/0013-agent-authority.md).

Within the permitted methods, a compromised relay could still accept, reject, dispute, cancel or settle jobs as the
user until the delegation expires or the user disables it on-chain. The wallet reviews the actual typed-data
limits before signing. `sponsor_revoke` stops board sends immediately and returns `disableDelegation`; until
that transaction is mined, the signed permission remains usable on-chain.

REST tools return unsigned output for self-custody wallets; hosted OAuth MCP runs the managed-agent executor.
`sponsor_submit({wallet,key,calls})` accepts up to 8 ordered zero-value calls. The internal desk validates each
grant entry, counts calls per entry and decodes nested allowance redemption against the publish token and reward.
The client creates and persists one key per action, and reuses it only for retries. An existing key always reconciles the original
operation before any policy or grant check, even if replacement calls differ. Another key can represent a new action. The result is
`{operationId,status: "pending"|"confirmed"|"reverted"|"dropped",txHash,callsUsed}`.
Poll `sponsor_operation({wallet,operationId})` to read the receipt and counter without sending anything.
An original submission retry reconciles the saved hash, counter baseline and relay nonce before it can rebroadcast
the identical persisted signed bytes. It never creates another transaction for that action.

Every relay sender recovers pending rows in both ledgers before allocating another nonce. A crash before broadcast
replays the exact saved bytes while the grant is live. If the grant was revoked, replaced or expired, recovery
persists a zero-value relay self-send at the same nonce with increased fees before broadcasting it. If the original
mines first, its receipt confirms or reverts the action. If the replacement mines first, the original becomes
`dropped`; its `txHash` remains the original hash. Polling never broadcasts. Replacement gas is charged from its
receipt toward the same daily cap. Its 100k gas limit uses the original operation's reservation, bounding the
fee cap within that reservation when current fees and the replacement bump permit. Recovery still sends if
fees have risen beyond it, even when the daily cap is full: the receipt's overshoot counts against that day,
so further sponsorships refuse until the budget is available again. Fresh operations can proceed only once the nonce is reconciled.

The reserved management object `__hosted_sponsor_v1__` in the existing Board binding stores grants and operation records for all boards. Before
broadcast, it validates canonical calldata against D15, simulates the whole redemption, reserves caps, and persists
its signed bytes and hash. An unresolved operation blocks another sponsored nonce. Limits are keyed by the operator:
20 calls per rolling hour on mainnet (150 on testnet) and 100 publishes per day. The relay's daily budget is 10 MON
on mainnet and 50 MON on testnet (`sponsorBudget` in `packages/board/src/sponsor-policy.ts`; testnet MON has no value,
widened on 8 Oct for multi-bot runs): mined charges are `gasUsed * effectiveGasPrice` from receipts,
and unresolved sends reserve their worst-case cost. The gas limit is the estimate × 1.10 + 10k
(`SPONSOR_LIMITS.gasMargin`), simulated at exactly that limit; when estimation or that simulation fails, the summed
ADR-0011 floors plus 100k overhead are used instead, with a 6M transaction cap.

**What it costs.** Monad bills the whole gas limit, not gas used. On testnet at about 102 gwei, measured sends cost
0.04–0.18 MON each: a hosted publish (allowance pull, approve and publish in one redemption) 0.06–0.18, an executor send
about 0.044, an agent wallet upgrade about 0.007, registration two sends of about 0.04–0.07. A hire costs about five relay
sends (publish, activate, submit, accept, settle), roughly 0.4–0.5 MON before the 1.10 margin (about 12% less after).
With MON at about $0.029 (6 Oct 2026) that is about $0.01–0.015 per hire, so on mainnet the binding limit is the
10 MON daily budget (about 20–25 sponsored hires a day), not the cost; it is kept at 10 MON until launch decides
otherwise. Merging accept and settle into one redemption would save one send per hire (follow-up).

`RELAY_FLOOR_MAINNET` is defined once in `packages/sdk/src/relay.ts` (2 MON in native wei). A sponsored send must
leave at least the network's balance floor after its maximum gas cost. Normal sends and nonce recovery share
`sponsorRelayFloor` in `packages/board/src/sponsor-policy.ts`; current policy is 2 MON on both networks, so G1
also needs that testnet buffer. The production live launch gate uses the SDK mainnet constant.

## Relay funding

**Owner and refusals.** Kris owns the relay balance. When a sponsored send would cross the floor, the relay refuses it, and nothing is sent. The caller sees code `conflict` with `reason: 'floor'`, `retry: 'same-key'` and `retryAfter: 600`. Hosted MCP and Explore keep these fields (`agentFailureReply`), so an agent retries the same operation key after a top-up rather than giving up.

**Alerts.** `apps/api/src/relay-watch.ts` reads the relay balance on every indexer cron run, and immediately after any floor refusal. It queues an owner Telegram alert below 3 MON (warning) and below 2.2 MON (critical): one per level per hour, deduplicated by the outbox id, with no state table of its own. Alerts go to the chats linked to the release-config owner wallets (`telegramOwnerWallets` in `apps/api/src/telegram.ts`); link a wallet once at `/telegram`.

**Top-up.** Send MON to the configured relay (`contracts/config/<network>.json` `relay`). Top up to at least 5 MON, so a busy day (10 MON daily budget) does not reach the floor. Record each top-up below.

| Date | Network | From | Amount | Tx | Why |
| --- | --- | --- | --- | --- | --- |
| 2026-10-05 | testnet | TESTNET_WORKER `0xD7e3…E571` | 1.5 MON | `0x223fd815…86118` | `pick_quote` refused at 2.24 MON during a hosted-MCP hire (job 129) |
| 2026-10-06 | testnet | TESTNET_WORKER `0xD7e3…E571` | 1 MON | (orchestrator, 01:12) | relay to 4.27 MON before the next releases |

The delegated-vault integration has pure-function, SQLite and real local Monad
fork coverage. This document describes implemented authority; dated live evidence
belongs in [reality-check.md](reality-check.md). G1b receipts do not prove G1c
delegated backing or its replacement grants.
