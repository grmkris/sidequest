# ADR-0013: Managed agent authority and clean-break storage

Status: accepted for Sidequest spec v2 (5 October 2026)

ADR-0013 supersedes the companion and approval-only authority model in ADR-0012.
Hosted MCP connects one operator-owned managed agent. The operator wallet remains
the only signer for operator decisions and spending allowances; the routine Privy
signer can sign only the agent wallet's allowlisted typed data. The relay can
submit a live, bounded delegation but never signs for either wallet.

Privy enforces chain, verifying contract, typed-data shape, delegate and
`newWallet` conditions where its policy matcher supports those fields. Before
every routine-signer call, the executor also enforces domain, type, frozen job
terms, delegation caveats, pinned targets/selectors/arguments, amount and expiry.
Unknown tokens require a verified operator decision for that exact token and
amount before the agent signs its one-off approval grant.

The sponsor object `__hosted_sponsor_v1__` is the single management object. It
stores agents, grants, agent operations, approvals, OAuth state and the sponsor
ledger in one SQLite transaction. `__sidequest_fleet_v1__` is retirement-only and
receives no management tables.

The version-2 transition drops the old fleet, OAuth and `sponsor_grants` tables.
It never drops `sponsor_operations`, `sponsor_replacements` or `relay_operations`:
pending relay sends remain available for reconciliation. Old rows are not shimmed
into the new authority model.

| Action | Signer | Runtime limits |
| --- | --- | --- |
| Registration and setAgentWallet | operator | exact registry calls, 2 calls, 10 minutes |
| Routine work (B1) | agent | relay delegate, approved targets/selectors, bounded calls and expiry |
| Agent token approval (B2) | agent | known reward tokens, Holding spender; unknown token needs exact one-off calldata |
| Sweep (B3) | agent | operator recipient, configured token, expiring grant |
| Spending allowance | operator | exact token/agent recipient, period cap and expiry |
| Unknown-token hire | operator then agent | exact allowance decision, exact one-off B2, one publish batch |
| Back an account | position owner (operator wallet[0] for its agents) | wallet-paid SIDE approval and `delegate(account, amount)`; owner retains shares |
| Operator-owned position exit | operator | wallet-paid `requestUndelegate`, `cancelUndelegate`, `withdraw(account)`; owner receives value |
| Agent-owned self-position exit | operator decision, then agent grant | `requestUndelegate(agentWallet, exactShares)`, exact calldata, one call, 600-second expiry |
| Routine agent vault work | agent | `cancelUndelegate` / `withdraw`, self-account only; no principal spending |
| Revoke | operator | hosted access stops first; on-chain disable is confirmed by receipt |

StakeVault v2 keeps backing in one pool per account and shares in each owner's
position. Anyone can back anyone. Operator-funded positions belong to the operator;
the hosted agent cannot exit or sweep them. Mining calls
`delegateFor(account, account, amount)` and creates an account-owned self-position.
Agent exit and emergency recovery use only that self-position. An `unstake`
approval freezes the exact account and shares before the routine signer signs
its one-off grant; the executor checks them again before relay submission.

Active backing sets the fee tier and new bond capacity. Queueing may happen while
bonded and restarts the whole queue's cooldown: three days with the fresh testnet clocks, fourteen days
in production. Queued shares stop counting immediately, but all shares remain
slashable until successful withdrawal. `StillBonded` can delay withdrawal beyond
unlock until remaining assets cover reservations. Positions stay keyed by wallet
address when the agent rotates. See [ADR-0014](0014-delegated-stake.md).

_Note, 11 October 2026 ([ADR-0022](0022-no-mining-at-launch.md)):_ mining and backer share are removed, so the note
below no longer applies.

_Note, 10 October 2026 ([ADR-0018](0018-backer-share.md)):_ "agent-owned self-positions" above is too narrow for mining. A
worker's backers can now hold mining leaves, and each leaf stakes into that account's own pool, so a backer wallet gets
the same kind of self-position. The hosted agent's restrictions are unchanged: it can exit only its own self-position.

An approval is not acceptance of paid work. Chain receipts, not board records,
establish funding, payment, stake or settlement.

**Amendment, 6 Oct 2026.** Explore's browser emergency recovery (the owner signing a fresh short-lived grant as the
agent in Privy, the operator redeeming it over plain RPC without Sidequest's API or relay) was removed in the Explore
redesign. Agent exits and earnings sweeps now run only through the hosted API and relay; while those are down, funds
and permissions stay at their recorded on-chain addresses until service returns. `GET /api/agents/:id/recovery` and
`sdk.recoveryGrant` remain for scripts and tests. The sentence above about exit and emergency recovery is history.

**Amendment, 7 Oct 2026.** The routine signer may also sign the agent's own worker-directory records (`Enrollment`,
`ServiceAd`, `RevokeAd`; never `Heartbeat`), through the `advertise_service` and `withdraw_service` tools. The executor
pins the directory domain for this origin (zero verifying contract, origin salt), the record types, the agent wallet,
ID, registry and version, and a validity of at most 300 seconds (24 hours for a `ServiceAd`). A listing conveys no job,
payment or settlement authority. The operator can withdraw it. Testnet only until the Privy directory rules are
promoted on mainnet.

## x402 payments (6 Oct 2026)

Testnet `x402_pay` signs only EIP-3009 `TransferWithAuthorization` from the managed
agent wallet against the deployment's USDC domain (`USDC`, version `2`, configured
chain and token). No receive or cancel authorization is allowed. The exact payment,
32-byte nonce and signature request are frozen under an operationKey before Privy;
retrying it returns the same signature. Validity lasts at most ten minutes.

The Privy policy caps each payment at 5 USDC (5,000,000 atomic units). Separately,
the management object's SQLite ledger caps each agent at 20 USDC per rolling
24 hours. This is a hosted limit, not an on-chain constraint. It counts every
signed payment, with a reservation before signing so an uncertain provider result
also consumes capacity. Retries reuse that reservation; it ages out after 24 hours.

Payments use the agent's own USDC balance. The operator can fund it directly or
grant an `erc20-token-periodic` permission paying the agent, then let it redeem
that permission. Sidequest returns the x402 v2 PAYMENT-SIGNATURE header; the agent
sends it to the resource. Sidequest never fetches the paid resource. The testnet
`GET /x402/demo` charges 0.01 USDC to the deployment's owner Safe and verifies and
settles through its configured facilitator.

The Privy rule (`Allow TransferWithAuthorization`: chain, USDC contract, `from` =
the signing wallet, value at most 5 USDC) was applied to the legacy testnet policy on
6 Oct 2026 with Kris's go-ahead (`packages/sdk/scripts/privy/update-agent-rules.ts`).
The separate Sidequest testnet policy carries the same rules with fresh pins; until it
is bound to the dev stack, `x402_pay` cannot sign there. The tool, signing path and
demo remain unavailable on mainnet.
