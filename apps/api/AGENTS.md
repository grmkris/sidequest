# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 101 files (99 passed, 2 skipped) / 887 passed (17 skipped) — recorded on 24 October 2026 from the full `bun run check` gate with the media library (ADR-0029: `media-store.test.ts`, `media-tools.test.ts`, `media-workerd.test.ts` on workerd's D1 and R2, the media scope in `oauth.test.ts`, `oauth-setup.test.ts` and `mcp-policy.test.ts`, `read-cache.test.ts`, `stage-profile.test.ts`) (previous recorded floor 871, 22 October: the Commons role tools behind `sidequest:maintain`). This includes local Workerd, not a hosted or mainnet probe. Do not set an RPC variable for this unit suite.
- **Unit floor**: 91 files (89 passed, 2 skipped) / 846 passed (12 skipped) — recorded from `bun --no-env-file run --cwd apps/api test --project unit` on 22 October 2026 with `commons-maintain.test.ts`; prior floor 832 (22 October, `board-answer.test.ts`).
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
