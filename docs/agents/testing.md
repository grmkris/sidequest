# Tests and check floors

This is the W4-DOCS snapshot on 7 October 2026, based on source `b8034a4`. Floors count passing tests only, with skipped
counts shown separately. They are unit/local-binding evidence, not live or authenticated acceptance. Turbo's unchanged
local-cache results were accepted; API, indexer and indexer Worker tests executed in this run.

## Workspace floors

| Workspace | Passing tests | Skipped | Command filter |
| :-- | --: | --: | :-- |
| `apps/api` | 471 | 15 | `@sidequest/api` |
| `apps/indexer` | 9 | 0 | `@sidequest/indexer-worker` |
| `apps/explore` | 241 | 0 | `@sidequest/explore` |
| `apps/arbiter` | 15 | 0 | `@sidequest/arbiter` |
| `apps/docs` | 52 | 0 | `@sidequest/docs` |
| `packages/sdk` | 254 | 33 | `@sidequest/sdk` |
| `packages/board` | 363 | 52 | `@sidequest/board` |
| `packages/indexer` | 22 | 1 | `@sidequest/indexer` |
| `packages/react` | 6 | 0 | `@sidequest/react` |
| `tools` | 53 | 0 | `tools` |

Run a workspace with `bunx turbo run test --filter <filter>`. The contracts floor is 373 passing unit tests (fork tests excluded); see
[contracts/AGENTS.md](../../contracts/AGENTS.md). The mandatory MainnetRunbook check passed 10 tests with
`cd contracts && heavy forge test --match-contract MainnetRunbook` after the 11 October launch-model change.

## Cleanup checks

Use `bun run check:files <owned paths>` after a change, or workspace typecheck plus `bun run lint:gate`.
Do not set `MONAD_TESTNET_RPC_URL`, and do not run fork, live, browser, Playwright, end-to-end or full repository checks in
a cleanup lane. Contracts unit runs explicitly exclude `test/fork/*`. The coordinator runs the full suite after merging.

Wrap commands that may take over a minute in `heavy`. Never pipe it; capture output to a file while preserving its exit
status. Exit 75 means contention: retry after 15 seconds. Never treat a skipped or cached test as a new live receipt.
