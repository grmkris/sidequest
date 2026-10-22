# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 97 files (95 passed, 2 skipped) / 857 passed (17 skipped) — recorded on 22 October 2026 from `bun run test` with Board Durable Object methods answering a BoardReply (`board-answer.test.ts`, and the Workerd operator-continuation refusal in `admission-do.test.ts`) (previous recorded floor 853, 20 October: PR #17 onto schema-checked tool arguments). This includes local Workerd, not a hosted or mainnet probe. Do not set an RPC variable for this unit suite.
- **Unit floor**: 90 files (88 passed, 2 skipped) / 832 passed (12 skipped) — recorded from `bun --no-env-file run --cwd apps/api test --project unit` on 22 October 2026 with `board-answer.test.ts`; prior floor 768 (15 October).
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
