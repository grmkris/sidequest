# apps/explore: browser marketplace and explorer

`@sidequest/explore` owns browser marketplace and explorer and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts). `worker.ts` is the graph's `cloud` zone and serves the browser assets and docs.

- **Check**: `bun run check:files apps/explore`; `bun run --cwd apps/explore typecheck`; `bun run --cwd apps/explore test`.
- **Test floor**: 113 files / 560 passed — recorded from `heavy bun run --cwd apps/explore test` on 14 October 2026, with SIDE bought and sold with USDC (`side-usdc`, the self-funded user-operation lane in `aa-mode`/`aa-request`, USDC records in `side-trade`/`side-revert`), a reverted user operation ending its trade (`aa-controller`) and the landing's paid figure (`live-format`); 111/551 before. Do not set an RPC variable for this unit suite.
- **Contract**: Browser routes, wallet actions, docs serving and stage-derived UI.
- **Landmines**: No secrets or raw addresses in browser code; docs build must precede Explore build; anonymous reads never imply authenticated acceptance.
- **Read**: [README](../../README.md), [docs app](../../apps/docs/AGENTS.md), [protocol](../../docs/protocol.md).
