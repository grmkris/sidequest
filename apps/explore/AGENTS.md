# apps/explore: browser marketplace and explorer

`@sidequest/explore` owns browser marketplace and explorer and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts). `worker.ts` is the graph's `cloud` zone and serves the browser assets and docs.

- **Check**: `bun run check:files apps/explore`; `bun run --cwd apps/explore typecheck`; `bun run --cwd apps/explore test`.
- **Test floor**: 134 files / 677 passed / 0 skipped — recorded on 22 October 2026 from `bun run --cwd apps/explore test` with the consent page's Commons role opt-in (`oauth-consent.test.ts`) and the Commons role tools connection words (previous recorded floor 673, 20 October: the screening note on waiting hire approvals, on top of verified approval context, signing outcomes, bounded reads and direct links with 14 Chromium approval regressions). Do not set an RPC variable for this unit suite.
- **Contract**: Browser routes, wallet actions, docs serving and stage-derived UI.
- **Landmines**: No secrets or raw addresses in browser code; docs build must precede Explore build; anonymous reads never imply authenticated acceptance.
- **Read**: [README](../../README.md), [docs app](../../apps/docs/AGENTS.md), [protocol](../../docs/protocol.md).
