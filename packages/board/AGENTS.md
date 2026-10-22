# packages/board: board domain and persistence contracts

`@sidequest/board` owns board domain and persistence contracts and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/board`; `bun run --cwd packages/board typecheck`; `bun run --cwd packages/board test`.
- **Test floor**: 69 files (61 passed, 8 skipped) / 642 passed (52 skipped) — recorded on 22 October 2026 from `bun run test` with `unwrapReply`, which reads a Board Durable Object's reply or an older object's bare value (previous recorded floor 639, 20 October: typed failure kinds, public applicants, the hosted-operator view, operator-only apply refusal and select_worker row reuse). Do not set an RPC variable for this unit suite.
- **Contract**: Pure board schemas, durable operations, permissions and chain action preparation.
- **Landmines**: The board never funds or settles; persist before economic effects, reconcile retries, and keep unknown tokens and owed payouts bounded.
- **Read**: [protocol](../../docs/protocol.md), [migrations rule](../../.claude/rules/databases-and-migrations.md).
