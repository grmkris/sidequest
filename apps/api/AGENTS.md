# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 80 files (78 passed, 2 skipped) / 690 passed (17 skipped) — recorded from CI verify of the released `15f1c177` (`bun run check`, run 38246617008) on 12 October 2026 (release-review fixes: backing order, publish notices, MCP 202, cache policy). Do not set an RPC variable for this unit suite.
- **Unit floor**: 74 files (72 passed, 2 skipped) / 682 passed (12 skipped) — recorded from `heavy bun --no-env-file run --cwd apps/api test --project unit` on 12 October 2026, with the AA release preflight and the arbiter lane's ruling and evidence changes (`aa-preflight.test.ts`; 662 before).
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
