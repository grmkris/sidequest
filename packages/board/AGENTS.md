# packages/board: board domain and persistence contracts

`@sidequest/board` owns board domain and persistence contracts and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/board`; `bun run --cwd packages/board typecheck`; `bun run --cwd packages/board test`.
- **Test floor**: 58 files (50 passed, 8 skipped) / 463 passed (52 skipped) — recorded from `heavy bun --no-env-file run --cwd packages/board test` on 12 October 2026 (a declined pick reopening its quote request added its tests; mining and backer share removed on 11 October, ADR-0022). Do not set an RPC variable for this unit suite.
- **Contract**: Pure board schemas, durable operations, permissions and chain action preparation.
- **Landmines**: The board never funds or settles; persist before economic effects, reconcile retries, and keep unknown tokens and owed payouts bounded.
- **Read**: [protocol](../../docs/protocol.md), [migrations rule](../../.claude/rules/databases-and-migrations.md).
