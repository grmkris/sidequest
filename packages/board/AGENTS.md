# packages/board: board domain and persistence contracts

`@sidequest/board` owns board domain and persistence contracts and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/board`; `bun run --cwd packages/board typecheck`; `bun run --cwd packages/board test`.
- **Test floor**: 68 files (60 passed, 8 skipped) / 540 passed (52 skipped) — recorded from `heavy bun run --cwd packages/board test` in a clean worktree on 12 October 2026, with the hosted user-op desk, batches, executor and operator-sent disables (`userop-desk.test.ts`, `agent-batch.test.ts`, `agent-executor.test.ts`, `agent-lifecycle-userop.test.ts`; 64/509 before). Do not set an RPC variable for this unit suite.
- **Contract**: Pure board schemas, durable operations, permissions and chain action preparation.
- **Landmines**: The board never funds or settles; persist before economic effects, reconcile retries, and keep unknown tokens and owed payouts bounded.
- **Read**: [protocol](../../docs/protocol.md), [migrations rule](../../.claude/rules/databases-and-migrations.md).
