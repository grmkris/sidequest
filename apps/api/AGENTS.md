# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 92 files (90 passed, 2 skipped) / 818 passed (17 skipped) — recorded on 17 October 2026 in the isolated production-readiness gate, including Commons presentations and bounded request bodies (previous recorded floor 795). This includes local Workerd, not a hosted or mainnet probe. Do not set an RPC variable for this unit suite.
- **Unit floor**: 82 files (80 passed, 2 skipped) / 768 passed (12 skipped) — recorded from `bun --no-env-file run --cwd apps/api test --project unit` on 15 October 2026 with sample upload and `/samples/` serving (`upload_sample`, prefix helpers and the route), including the UTC midnight quota regression; prior floor 767.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
