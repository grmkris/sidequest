# apps/explore: browser marketplace and explorer

`@sidequest/explore` owns browser marketplace and explorer and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts). `worker.ts` is the graph's `cloud` zone and serves the browser assets and docs.

- **Check**: `bun run check:files apps/explore`; `bun run --cwd apps/explore typecheck`; `bun run --cwd apps/explore test`.
- **Test floor**: 81 files / 399 passed — recorded from `heavy bunx turbo run test` on 11 October 2026 (mining and backer share removed, ADR-0022: their tests went with the code). Do not set an RPC variable for this unit suite.
- **Contract**: Browser routes, wallet actions, docs serving and stage-derived UI.
- **Landmines**: No secrets or raw addresses in browser code; docs build must precede Explore build; anonymous reads never imply authenticated acceptance.
- **Read**: [README](../../README.md), [docs app](../../apps/docs/AGENTS.md), [protocol](../../docs/protocol.md).
