# apps/explore: browser marketplace and explorer

`@sidequest/explore` owns browser marketplace and explorer and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts). `worker.ts` is the graph's `cloud` zone and serves the browser assets and docs.

- **Check**: `bun run check:files apps/explore`; `bun run --cwd apps/explore typecheck`; `bun run --cwd apps/explore test`.
- **Test floor**: 111 files / 551 passed — recorded from `heavy bun run --cwd apps/explore test` on 14 October 2026, with the SIDE trade that ends without effect (both copies of its journal) and its revert cause (`side-trade`, `side-revert`), its chosen slippage and stale-quote refusal (`side-sheet`), the one-tap auto-start (`txJournal`), and the step-lock wait notice and nonce bisection (`txOperation`); 110/537 before. Do not set an RPC variable for this unit suite.
- **Contract**: Browser routes, wallet actions, docs serving and stage-derived UI.
- **Landmines**: No secrets or raw addresses in browser code; docs build must precede Explore build; anonymous reads never imply authenticated acceptance.
- **Read**: [README](../../README.md), [docs app](../../apps/docs/AGENTS.md), [protocol](../../docs/protocol.md).
