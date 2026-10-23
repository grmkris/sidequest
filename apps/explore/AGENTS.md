# apps/explore: browser marketplace and explorer

`@sidequest/explore` owns browser marketplace and explorer and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts). `worker.ts` is the graph's `cloud` zone and serves the browser assets and docs.

- **Check**: `bun run check:files apps/explore`; `bun run --cwd apps/explore typecheck`; `bun run --cwd apps/explore test`.
- **Test floor**: 132 files / 674 passed / 0 skipped — recorded on 23 October 2026 from `bun run --cwd apps/explore test` with the services bento (`tileCoverOf`, `bentoOrder`, `interleaveBy` in `service-wall.test.ts`), after Kris had the landing's live rail (latest paid, newest block, paid total) removed, taking `live-rail.test.ts` (5) and `live-format.test.ts` (1) with its code (previous recorded floor 134 files / 677, 22 October: the consent page's Commons role opt-in and the Commons role tools connection words). Do not set an RPC variable for this unit suite.
- **Contract**: Browser routes, wallet actions, docs serving and stage-derived UI.
- **Landmines**: No secrets or raw addresses in browser code; docs build must precede Explore build; anonymous reads never imply authenticated acceptance.
- **Read**: [README](../../README.md), [docs app](../../apps/docs/AGENTS.md), [protocol](../../docs/protocol.md).
