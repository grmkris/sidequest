# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 89 files (87 passed, 2 skipped) / 795 passed (17 skipped) — recorded from the full `heavy bun run check` gate at `0c9ce138` on 15 October 2026, with signed directory writes, the public `/mcp/directory` endpoint, `events/stream` and the workerd stream proof (748 before). This includes local Workerd, not a hosted or mainnet probe. Do not set an RPC variable for this unit suite.
- **Unit floor**: 78 files (76 passed, 2 skipped) / 735 passed (12 skipped) — recorded from `heavy bun --no-env-file run --cwd apps/api test --project unit` on 15 October 2026 for durable service cards and one-query-per-page delivery verification; prior recorded floor 729.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
