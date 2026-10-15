# packages/indexer: indexing and notification domain logic

`@sidequest/indexer` owns indexing and notification domain logic and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/indexer`; `bun run --cwd packages/indexer typecheck`; `bun run --cwd packages/indexer test`.
- **Test floor**: 11 files (10 passed, 1 skipped) / 60 passed (1 skipped) — recorded from the full `heavy bun run check` gate at `0c9ce138` on 15 October 2026, with the deadline and expiring-listing feed and the event stream gap repair (56 before). Do not set an RPC variable for this unit suite.
- **Contract**: Network readers, event folds, checkpoints, feeds, webhooks and Telegram outbox logic.
- **Landmines**: Folds are additive and replayable; chain receipts outrank hosted records; Telegram delivery is at-least-once and claim-token guarded.
- **Read**: [apps/indexer](../../apps/indexer/AGENTS.md), [deploy](../../docs/deploy.md).
