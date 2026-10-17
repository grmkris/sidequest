# Handoff: paid-calls board on Sidequest production

Checked 17 October 2026 against `dev` at `3b52946e`, after the Commons presentations and the production-readiness
commits. The design conversation was 15 October. For the next session, the one signed in to Sidequest production
(`https://sidequest.exchange`, Monad mainnet, chain 143). Prod has been on chain 143 since 13 October. Do not
use a testnet MCP session for this. On 15 October a testnet session (agent 2016 on
`https://dev.sidequest.exchange`) had no SIDE and was given a backing link; that link was not used, and that
session is not this one.

The design this board exists to hire is [E5 Paid calls](https://myplan.lol/n/doc_5fbt5s4sw1vezze6dy7hb7v6j6)
(note `doc_5fbt5s4sw1vezze6dy7hb7v6j6`, revision 1 on 17 October). Read that note before posting work. Do not
re-decide it.

## What to set up

A tenant board whose first job is the testnet slice of E5: a fixed-price service can be paid with x402.
The board is the place the crew quotes and builds. It is not a roadmap item, and it is not an Arc deployment.

`create_board` is self-serve for a signed-in wallet and moves no money (ADR-0008). The signed-in wallet becomes
the owner. Tools then live at `/b/<slug>/mcp` and `/b/<slug>/api`.

Proposed board, change it only if Kris names something else:

- slug: `paid-calls`
- name: `Paid calls`
- stacks: `["main"]`
- defaultStack: `main`
- rewardTokens: mainnet USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. Checked 17 October against
  `contracts/config/monad-mainnet.json`: this address is `x402.usdc`, `accountAbstraction.gasToken`, and the
  first `knownTokens` entry. Leave the other known token off this board.
- deliverableDefault: `{ "accepts": ["git"] }`
- drip: false (mainnet has no drip)
- sponsor: `none`
- allowedOrigins: omit until a host page exists

Before creating it, call `list_boards` and `get_board`. If `paid-calls` already exists, use it. Do not create
a second slug to get around that.

## Confirm the session first

1. `protocol_info` must say `monad-mainnet`, chain 143, origin `https://sidequest.exchange`. If it says
   `monad-testnet` or `dev.sidequest.exchange`, stop. That is the wrong session.
2. `whoami` must return an agent id with the hire role. Record the address and agent id in the job thread.
3. `get_stake` on that agent wallet. Publishing reserves a creator bond of **1,000,000 SIDE** on mainnet
   from available backing. Backing is real SIDE. If `available` is short, call `request_backing` and give Kris
   the `approveUrl`. Do not publish until `request_backing` says backed.
4. Production hosted writes require an authenticated wallet. If admission is in drain mode, stop and say so.

## The one job to post

Post with `request_quotes` on the new board, after the board exists and the bond is backed. Do not
`create_task`. Nothing is escrowed until Kris picks a quote.

Do not set `budget.max` unless Kris has named the most he will pay in USDC. An open quote request lets
workers name a price. Picking one later escrows real USDC and needs his explicit go-ahead.

Title: `Pay a fixed-price service with x402`

Tags: `coding`, `on-chain`

Tokens: the board's USDC only.

Deadlines: quotes close in 3 days, delivery due in 7 days. Production unstaking is a fourteen-day cooldown, and
the creator bond requires the listing to expire inside that cooldown from reservation, including delivery, every
window and the core margin (`docs/protocol.md`). Omit review windows and let the board fit them. If 7 days plus
the fitted windows does not fit, shorten delivery. Do not use the old three-day testnet clock.

Brief, in substance:

Build the seller side of x402 for fixed-price Sidequest service ads, on Monad testnet first. The route reads
the signed service ad and returns HTTP 402. Scheme `exact`. Amount from the ad. Asset is the deployment's
x402 USDC (`contracts/config/<network>.json`). Testnet, checked 17 October in
`contracts/config/monad-testnet.json`: `0x534b2f3A21130d7a60830c2Df862319e593943A3`, facilitator
`https://x402-facilitator.molandak.org` (the same facilitator URL as mainnet). `payTo` is the advertising agent's own wallet.
Sidequest never holds the USDC. After the facilitator settles, write a paid-call receipt and an inbox event
so the worker can do the work. The HTTP response is that receipt.

A paid-call receipt is not a job. It must not count as publish, fund, or activate. Directory signatures still
grant no payment authority. No contract change. No Arc. No mainnet buyer signing. `x402_pay` stays unavailable
on mainnet until ADR-0013's policy is bound. Quote-priced ads stay on the hire path.

Spec: https://myplan.lol/n/doc_5fbt5s4sw1vezze6dy7hb7v6j6

Acceptance criteria:

- A fixed-price ad on testnet returns 402 with that ad's amount, the configured USDC, and `payTo` equal to
  the agent wallet.
- A settled payment writes a receipt that names the transaction hash, payer, payee, amount, chain, and
  service id, and wakes the worker with an inbox event.
- The same receipt cannot be used to mark a hire funded. A test demonstrates that refusal.
- A quote-priced ad does not get this route.
- Tests cover the route. No test count drops. `bun run check:files` passes on the owned paths.

Deliverable: a git branch or PR against `github.com/grmkris/sidequest` on `dev`. The board hosts nothing.

## Do not do these in that session

- Do not deploy Holding, the bond vault, or SIDE onto Arc.
- Do not add an Arc deposit to onboarding.
- Do not turn on mainnet `x402_pay`.
- Do not pick a quote or escrow USDC unless Kris has named the amount in this conversation.
- Do not post the same job on the testnet public board. Agent 2016 there has no SIDE. A backing link was
  issued and not used: `https://dev.sidequest.exchange/agent/2016?back=10`. Leave it.

## Why this shape

x402 here is a second rail on the service card: fixed price, USDC straight to the agent, no bond and no
dispute. Hires stay on Monad for work that needs recourse. Arc, if it comes later, is another accepted
network on that card, or a small conditional escrow built apart from v1. That split is the decision in E5.
The production board is only so the crew can be hired to build the first slice.
