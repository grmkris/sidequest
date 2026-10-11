# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 77 files (75 passed, 2 skipped) / 663 passed (17 skipped) — recorded from `heavy bunx turbo run test` on 11 October 2026 (mining and backer share removed, ADR-0022: their tests went with the code). Do not set an RPC variable for this unit suite.
- **Unit floor**: 70 files (68 passed, 2 skipped) / 644 passed (12 skipped) — recorded from `heavy bun --no-env-file run --cwd apps/api test --project unit` on 11 October 2026 (mining and backer share removed, ADR-0022: their tests went with the code).
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
