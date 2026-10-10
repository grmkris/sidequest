# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 76 files (74 passed, 2 skipped) / 665 passed (17 skipped) — recorded from `heavy bun run check` on 10 October 2026 (whoami agentId, orphan job.published rows). Do not set an RPC variable for this unit suite.
- **Unit floor**: 57 files (55 passed, 2 skipped) / 559 passed (13 skipped) — recorded from `heavy bun --no-env-file run --cwd apps/api test --project unit` on 10 October 2026 (hosted backer-share approval/resume, lane mv2-p). RPC and live-preview variables were unset. The eight workerd suites were excluded by the lane's no-Alchemy rule; the full-suite floor above is retained for the coordinator.
- **Lane U unit count floor**: 60 files / 602 cases (589 non-skipped, 13 skipped). Two runs of `heavy bun --no-env-file run --cwd apps/api test --project unit` on 10 October 2026 recorded 588 passed / 1 failed / 13 skipped (57 passed files, 1 failed, 2 skipped). The unchanged `hosted-backer-share.test.ts` approval/resume fixture failed with `Invalid permission identity or validity`; the prior green unit floor is retained above. RPC and live-preview variables were unset; workerd suites were excluded under the no-Alchemy rule.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
