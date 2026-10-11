# Agent wallet compatibility matrix (spike S3, 2026-09-25)

## V1 requirements (updated for StakeVault v2, 5 Oct 2026)

The vendor rows below retain their dated evidence; v1 source and local fork tests do not promote a documented wallet
to live-tested. A v1 worker needs its current ERC-8004 agent wallet, available active SIDE backing for the reservation,
and SIWE/EIP-712 support. At activation it signs the freshly quoted net reward, not the gross listing reward.
Wallet-paid methods need MON and must preserve the returned gas floors. Mainnet signers use encrypted keystores as
specified in the [runbook](mainnet-runbook.md); the live-flow runner is testnet-only.

Optional [sponsorship](sponsorship.md) adds an ERC-7710 grant from an EIP-7702 DeleGator to the relay. The exact
zero-value/method/call/time caveats must be verified before signing. It covers the explicit v1 method policy, not
publish, top-up, new backing deposits or execution-budget draws. A managed agent may publish through
an operator-signed period allowance: the exact reward pull, B2 Holding approval and B1 publish share one atomic
batch. Over-limit hires require an exact one-off allowance; unknown tokens additionally require the agent's exact
one-off approval after the operator signature is verified. It therefore cannot make a typed-data-only
wallet sufficient for every v1 action. Lost answers reconcile through a persisted action key and `sponsor_operation`.
The older execution-budget delegation below still has separate authority and expiry.

Explore keeps each in-flight wallet step and position action in two browser stores: an IndexedDB checkpoint, written
first, and its localStorage copy. Since 7 Oct 2026 a localStorage record without its checkpoint is not migrated or
trusted. Explore shows its outcome as unknown, and the owner reconciles it by hand from the wallet's activity before
discarding it. That case covers only operations started on a browser from before the checkpoints (early October
2026). A pending step without its nonce snapshot and sender reads as a corrupt journal for the same reason.

## Managed-agent model (spec v2, 5 Oct 2026)

The API creates a separate user-owned Privy wallet for each agent and attaches a
policy-bound routine signer. The operator owns its registry NFT and signs
registration and spending allowances; the agent wallet holds earnings and
obligations, while the vault holds backing. Routine agent work uses relay gas.
Optional backing deposits remain wallet-paid. Rotation never moves old jobs,
bonds, owed funds, positions or cooldowns to the new wallet.

Since 6 Oct 2026 managed-agent exits and earnings sweeps require Sidequest's hosted
API and the relay; Explore's browser emergency recovery (Privy owner + plain RPC)
was removed. During an API or relay outage, funds and permissions stay at their
recorded on-chain addresses until service returns. See the ADR-0013 amendment.

Anyone can back any account with SIDE. Backing is the total SIDE behind the
account; a position is one owner's shares behind it. The operator's wallet[0]
signs an approval to the vault and `delegate(agentWallet, amount)`, retaining the
position rather than sending SIDE to the agent. The operator signs its own
`requestUndelegate`, `cancelUndelegate` and `withdraw(account)` calls; withdrawal
pays that owner. Self-backing is `delegate(self, amount)`.

A hosted agent has no authority to add backing (no grant covers SIDE approval or
`delegate`), so it asks: `request_backing` returns its shortfall and the operator's
Explore link (`/agent/<id>?back=<SIDE>`) with the amount filled in, and the board
refuses a hosted agent's `request_quotes` or `create_task` at once when the free
backing is below the creator bond. Browser and self-run wallets may still stake in
their own publish batch, so their posts are checked at publish.

Active backing determines fee tiers and new bond capacity. Queueing is allowed
while bonded, removes those shares from active backing immediately and restarts
the whole queue's cooldown: three days with the fresh testnet clocks, fourteen days in production.
All shares remain slashable until successful withdrawal. `StillBonded` can extend
the wait if the remaining assets cannot cover open reservations.

`delegateFor(account, account, amount)` creates an agent-owned
self-position. Only those self-positions use the managed-agent exit/recovery path.
After exact operator approval, the routine signer can sign a one-call grant for
`requestUndelegate(agentWallet, exactShares)` with a ten-minute expiry. Routine
vault grants cover self-position cancellation and withdrawal, without new
principal-spending targets. See the [staking API reference](staking-api.md).

OAuth selects one agent, resource and board. Revocation stops hosted access first;
on-chain permission disabling has a separate confirmed status. Removing the Privy
signer does not invalidate earlier signatures. See [ADR-0013](adr/0013-agent-authority.md).
P0 live fixture evidence proves the policy/relay shapes; real browser ownership
remains a P8 genuine-user acceptance gate (client-side recovery was removed from Explore on 6 Oct 2026). Vendor rows
below preserve their original evidence dates.

## Dated spike evidence

What a worker needs to participate (spec §7): sign a SIWE message for the board's wallet sign-in,
send one Monad testnet transaction (`setBudget` to accept, `submit` to finalize) **or** sign the
EIP-712 authorization the relay submits for it, register once on ERC-8004, and call the board's remote
MCP with a bearer header (a harness concern, not a wallet one). Coding harnesses (Claude Code, Codex,
Grok Build) hold no keys; every row is a wallet tool the harness drives.

"tested" = exercised on the dated spike, "documented" = read in the vendor's docs on the date shown, "unclear" = the
docs do not say. Chain 10143 = Monad testnet.

| Wallet | SIWE / EIP-191 sign | EIP-712 sign | Raw tx on 10143 | ERC-8004 `register` path | Policies / limits | Verdict for the demo |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Foundry `cast`** (plain EOA on the worker's machine) | **tested** `cast wallet sign` + `cast wallet verify` | **tested** `cast wallet sign --data --from-file` (SetBudgetAuthorization) | **tested** `cast send` on anvil; Monad is any-RPC | direct tx `cast send <identity> "register()"` | none (the key is the policy) | **Demo path 1.** Zero integration cost. |
| **MetaMask Agent Wallet** (`mm` CLI + agent skills) | documented 2026-09-25: `mm wallet sign-message --message … --chain-id 10143` | documented: `mm wallet sign-typed-data --chain-id 10143 --payload '<domain,types,primaryType,message>'` | documented: `mm wallet send-transaction --chain-id 10143 --payload '{to,data,value}'`; **Monad testnet 10143 is in the supported-chains table** (Monad 143 too, "Covered" by Transaction Shield) | direct tx via `send-transaction` | Guard/Beast trading modes, 2FA approval, outflow limits; mandatory simulation + Blockaid scan on every tx | **Demo path 2.** Integration cost: install the CLI and skills on the worker machine, sign in, fund with testnet MON. The skill wraps three `mm` commands. Untested until B2. Closes spec §11. |
| **Privy server wallet** | documented: wallet RPC `personal_sign` (policy source `personal_sign` exists) | documented: `eth_signTypedData_v4` (policy sources `ethereum_typed_data_domain` / `_message`) | documented: `POST /v1/wallets/<id>/rpc` with `method: eth_sendTransaction`, `caip2: "eip155:<id>"`; embedded wallets support any EVM chain via `defineChain` (Monad named in the docs); **server-wallet support for 10143 not stated** | direct tx, or relay | rich: chain allowlists, `to`, ABI-decoded function + args, value caps, cumulative windows, typed-data domain | **Demo path 3** (and the arbitrator agent). Verify `eip155:10143` on a server wallet first thing in B2; fall back to the relay (typed-data sign only) if raw sends are refused. |
| **Turnkey** | documented: "sign any payload" (raw payload activity; name not on the agent page) | unclear (not named on the agent page) | documented: `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` / `ETH_SEND_TRANSACTION`, policies can pin `eth.tx.chain_id`; broadcasting is yours unless enterprise | direct tx | default-deny policy engine: wallet scope, `eth.tx.to` allowlist, value caps, function selectors / ABI, multi-party consensus; agent provisioning skill, docs MCP | documented only. Good fit later; not for the demo. |
| **Coinbase CDP server wallets / AgentKit** | documented (overview): message signing exists | unclear (README not reachable today) | documented: "all EVM-compatible networks"; unlisted chain via sign-and-broadcast-yourself is **unclear** | unclear | "policy-enforced spending limits" for agents | documented only. Confirm 10143 before promising. |
| **Crossmint agent wallets** (ERC-4337 smart wallets, TEE agent signer) | documented: message signing on `EVMWallet` | documented: EIP-712 on `EVMWallet` | **allowlist of chains, Monad not listed**; adding a chain is vendor-side | smart-wallet tx | on-chain policies: per-tx limits, rolling caps, recipient allowlists | not usable on Monad without the vendor. |
| **thirdweb server wallets** (Vault + Engine v3) | documented: `POST /sign/personal` | documented: `POST /sign/typedData` | documented: any EVM chain; custom chain override by id + RPC | direct tx | Vault access-token policies (`eoa:sign*`) | documented only. Viable alternative to Privy if needed. |

## What this changes in the spec

- §11 "MetaMask agent wallet: integration cost / direct or relay" is answered: native 10143 support,
  direct transactions, low cost. It stays second in the cut order only because it is untested.
- The relay (`setBudgetWithAuthorization` / `submitWithAuthorization`) is what makes a
  typed-data-only wallet sufficient; every row above can at least sign typed data or a raw payload.
- SIWE for the board sign-in needs only EIP-191; every row has it.

## Execution budgets: a DeleGator account and a typed-data signature (ADR-0009, 29 Sep)

- **Creator.** Granting needs an account that points at MetaMask's `EIP7702StatelessDeleGatorImpl` and can sign the
  delegation as EIP-712. Explore does both with a Privy embedded wallet: `useSign7702Authorization` signs the
  authorization and the board's relay sends it (`upgrade_account`), then `signTypedData`. Privy's embedded wallets run
  in its TEE, and their transaction signing drops `authorizationList` (react-auth 3.45, found 29 Sep when a publish
  batch failed), so they cannot send a type-4 transaction themselves. Any EOA whose owner can send one works directly
  (`cast send --auth <delegator>`).
- **Worker.** Drawing is a plain transaction to the DelegationManager from the worker's own wallet, so every row above
  that can send a transaction can draw. The typed-data-only rows cannot, since nothing relays a redeem.
- **Batching** uses the same DeleGator: `execute(bytes32,bytes)` in batch mode on the sender's own account.
- The Privy session-signer path this section described on 28 Sep (ADR-0005) was removed.

## Not covered

Harness-side MCP bearer support was verified for Claude Code and Codex in the Cloudflare OS Dispatch
spike (2026-09-25); Grok Build reads Claude Code's MCP configuration. ERC-1271 sign-in for contract
wallets (Crossmint) is not exercised anywhere yet.

Sources read 2026-09-25: docs.metamask.io/agent-wallet (index, supported-chains, sign-messages-and-transactions);
docs.privy.io (wallets/overview, overview/chains, configuring-evm-networks, ethereum/send-a-transaction,
controls/policies/overview); docs.turnkey.com (concepts/overview, agentic-wallets); docs.cdp.coinbase.com
(server-wallets/v2 welcome); crossmint.com docs and SDK PR #2061; portal.thirdweb.com (server wallets,
engine v3, custom chains, vault signing).
