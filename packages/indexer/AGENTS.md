# packages/indexer: indexing and notification domain logic

`@sidequest/indexer` owns indexing and notification domain logic and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/indexer`; `bun run --cwd packages/indexer typecheck`; `bun run --cwd packages/indexer test`.
- **Test floor**: 13 files (12 passed, 1 skipped) / 67 passed (1 skipped) — recorded from the full `bun run check` gate on 24 October 2026 with the media schema (`media-schema.test.ts`) and the morning digest (`media-digest.test.ts`) (60 before, 15 October). Do not set an RPC variable for this unit suite.
- **Contract**: Network readers, event folds, checkpoints, feeds, webhooks and Telegram outbox logic.
- **Landmines**: Folds are additive and replayable; chain receipts outrank hosted records; Telegram delivery is at-least-once and claim-token guarded.
- **Read**: [apps/indexer](../../apps/indexer/AGENTS.md), [deploy](../../docs/deploy.md).
