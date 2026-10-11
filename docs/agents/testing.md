# Tests and check floors

Re-recorded on 11 October 2026 from `heavy bunx turbo run test` at `61dc4464`, after mining and backer share were
removed with their tests (ADR-0022). The `apps/api` and `packages/sdk` rows were re-recorded later that day, after the
deployment schema lost its mining fields (11 and 4 fewer parameterised cases). Floors count passing tests only, with
skipped counts shown separately. They are
unit/local-binding evidence, not live or authenticated acceptance.

## Workspace floors

| Workspace | Passing tests | Skipped | Command filter |
| :-- | --: | --: | :-- |
| `apps/api` | 652 | 17 | `@sidequest/api` |
| `apps/indexer` | 9 | 0 | `@sidequest/indexer-worker` |
| `apps/explore` | 399 | 0 | `@sidequest/explore` |
| `apps/arbiter` | 46 | 0 | `@sidequest/arbiter` |
| `apps/docs` | 58 | 0 | `@sidequest/docs` |
| `packages/sdk` | 315 | 33 | `@sidequest/sdk` |
| `packages/board` | 454 | 52 | `@sidequest/board` |
| `packages/indexer` | 53 | 1 | `@sidequest/indexer` |
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
