# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 85 files (83 passed, 2 skipped) / 748 passed (17 skipped) — recorded from `heavy bun --no-env-file x turbo run test --filter @sidequest/api` on 13 October 2026 at `a0fdcba7`, with `/aa/rpc` forwarding MON-paid (paymaster-less) user operations; 746 before. This includes local Workerd, not a hosted or mainnet probe. Do not set an RPC variable for this unit suite.
- **Unit floor**: 78 files (76 passed, 2 skipped) / 728 passed (12 skipped) — recorded from `bun --no-env-file run --cwd apps/api test --project unit` on 13 October 2026 at `a0fdcba7`; 726 before.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
