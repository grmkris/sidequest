# Operator approval context and feedback — 19 October 2026

Implemented and locally tested; this is not a production deployment receipt. No tasks were created, published,
cancelled, selected, accepted or settled during this fix. No mainnet transaction was sent.

Branch `fix/approval-context-1019` is based on dev `d0526956c1f770c2f71a2eeb2c0fc34385fd6a25`, which includes
Claude's PR #16 integration and session-storage fallback. This lane did not merge PR #16.

## Findings and changes

- The approval lists returned request amounts and call data without the frozen offer's title or brief. Cards were
  indistinguishable. `approval-details.ts` now reads the immutable preparation and verifies its manifest hash,
  policy hash, task ID, token and reward against the frozen publish call. Only display context is added;
  signatures and private preparation fields are not exposed.
- Waiting cards and history show the full brief, request key, task, board, request time, acceptance criteria and
  creator bond. An unverifiable brief disables signing rather than displaying unrelated or mutable task text.
- Direct links previously showed the public overview while ownership loaded or failed. They now show sign-in,
  loading, retry or wrong-wallet feedback and retain the linked request. A linked past request opens in history.
- Decisions ignored the response's execution status. They now distinguish confirmed, pending, reverted, dropped,
  rejected and unconfirmed results. The parent keeps results after cards move to history. Polling moves
  pending/approved cards within one stable parent, preserving their in-flight state.
- Read failures previously claimed no decision had been submitted, even after a lost response. Every completed
  attempt now reads the original request back, including response failures. Failed reads disable stale actions;
  GET requests time out after 15 seconds and offer retry. POSTs are neither automatically retried nor timed out.
  Signing, saving and reconciliation have explicit phases; a slow response explains how to check saved state.

The original client's network/console trace is unavailable. Source proves missing context and lost feedback,
not the precise cause of that client's latency. Management operations share a serialized queue, a possible
contributor rather than a measured diagnosis. Authenticated production signing was not replayed.

## Read-only live state

Fresh production MCP `get_task` reads during final validation still showed:

| Request | Task | Live task state |
| --- | --- | --- |
| Original `karl-eulogy-20261019`, approval `0x68cf…959` | `530e5508cd8d4857` | Job **17**, open, 40,000 SIDE escrowed, publish confirmed |
| Intended `karl-eulogy-20261019-v2`, approval `0x32e2…372` | `68f9fd2ac876ee9d` | No job ID, awaiting publish, not escrowed |

Published transaction: `0x31a1f49e4fbab3446620c3f732b6372d1880505709bf8f183f3b3f3386c142fe`.
Both offers have the same title, “A 4cm eulogy for Karl the goldfish”; v2 adds the reservation for `@Agent_Minimum`.
Their terms hashes differ. The earlier private approval read reported original **executed** and v2 **rejected**,
with distinct operations and allowance records; no cross-request rejection or nonce corruption was found.
The final public task read corroborates publication state, not private approval status.

At Monad block **114792688**, `get_stake` reported Grok's backing as 2,500,000 SIDE total, 2,000,000 reserved and
500,000 available. Another 1,000,000 SIDE bond needs additional or released backing.

At block **114793448** (2026-10-19 15:40:49 UTC), direct read-only RPC reported operator
`0x5884fcc45df1aeb31b25171fb9cb04ceecbcb3e0` holding **8,770,130.560984609735566207 SIDE** and
**47.993508082615528652 MON**. Operator-to-Holding and agent-to-Holding ERC20 allowances were both zero.
ERC20 allowances are distinct from the signed delegation grant: the hire flow transfers the exact reward through
delegation and spends the agent's approval in the atomic publish. Zero residual ERC20 allowance is not evidence
that the operator lacked funds for the 40,000 SIDE reward. Addresses and RPC came from the mainnet config.

## Validation

`heavy bun run check` and `heavy bun run build` both exited **0** on code commit
`c869b77670708db549b477652625a264454748a2` (API commit `4cacea84`). The later documentation commit only records
results and raises floors. The lint baseline shrank by one assertion; no rules were weakened.

| Suite | Files/suites | Passed | Skipped |
| --- | ---: | ---: | ---: |
| Explore | 132 | 672 | 0 |
| API, including local Workerd | 94 (92 passed) | 838 | 17 |
| Contracts | 43 | 436 | 22 |
| SDK | 58 (54 passed) | 430 | 33 |
| Board | 68 (60 passed) | 618 | 52 |
| React | 3 | 8 | 0 |
| Commons | 9 | 109 | 0 |
| Docs | 8 | 61 | 0 |
| Indexer | 11 (10 passed) | 60 | 1 |
| Indexer Worker | 1 | 9 | 0 |
| Arbiter | 8 | 69 | 0 |
| Tools | 5 | 53 | 0 |
| Node script tests | — | 32 | 0 |
| Bun CI/crew script tests | 3 | 31 | 0 |

Explore exceeds the integrated dev floor of 650 tests. API exceeds its recorded 818-test floor. Unchanged workspaces
used normal Turbo cache hits; Explore and API tests executed on this branch. Contracts are the regular local suite,
not a live mainnet fork. Build passed with the existing large-chunk warnings.

New coverage: six real SQLite/API cases, fourteen Chromium component scenarios, seven response-decoding cases and
one frozen-title case. Browser fixtures replace wallet/auth and network transport only; React, TanStack Query,
grant reconstruction/validation and approval components remain real. Cases cover same-title selection/rejection
at two viewport widths, history links, sign-in/access/read errors, missing context, the actual 15-second read
timeout, signing/slow-save phases, pending-to-approved polling, completion after unmount, reverted/dropped responses,
and lost responses without duplicate submissions.

Local logs and capture script remain under `report/approval-context-1019/` in the worktree (ignored by Git).
These screenshots use synthetic local requests, not an authenticated production session:

- [390 px approval cards](approvals-390.png)
- [1280 px approval cards](approvals-1280.png)
