# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 78 files (76 passed, 2 skipped) / 672 passed (17 skipped) — recorded from `heavy bunx turbo run test --filter @sidequest/api` on 12 October 2026, after the post-showcase fixes (picked notices on publish, release_pick, MCP notifications and setup events, connection roles, background avatars). Do not set an RPC variable for this unit suite.
- **Unit floor**: 71 files (69 passed, 2 skipped) / 652 passed (12 skipped) — recorded from `heavy bun --no-env-file run --cwd apps/api test --project unit` on 12 October 2026, after the post-showcase fixes.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
