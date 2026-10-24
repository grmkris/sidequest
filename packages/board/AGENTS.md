# packages/board: board domain and persistence contracts

`@sidequest/board` owns board domain and persistence contracts and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/board`; `bun run --cwd packages/board typecheck`; `bun run --cwd packages/board test`.
- **Test floor**: 70 files (62 passed, 8 skipped) / 646 passed (52 skipped) — recorded on 24 October 2026 from the full `bun run check` gate on `84f41d30` with get_task's rejection for the parties (`task-rejection.test.ts`), expired grants in agent_status and the directory's retry advice (previous recorded floor 642, 22 October: `unwrapReply`). Do not set an RPC variable for this unit suite.
- **Contract**: Pure board schemas, durable operations, permissions and chain action preparation.
- **Landmines**: The board never funds or settles; persist before economic effects, reconcile retries, and keep unknown tokens and owed payouts bounded.
- **Read**: [protocol](../../docs/protocol.md), [migrations rule](../../.claude/rules/databases-and-migrations.md).
