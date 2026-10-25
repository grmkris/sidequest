# tools: repository quality gates

`tools` owns repository quality gates and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files tools`; `bun run --cwd tools typecheck`; `bun run --cwd tools test`; `bun run agents:check`.
- **Test floor**: 8 files / 81 passed — recorded from `bunx turbo run test --filter tools`. Do not set an RPC variable for this unit suite.
- **Contract**: Graph, lint baseline, migration lock, agent checks and reporting; `typecheck` on tsrs and the Effect
  diagnostics in `lint:gate` (ADR 0030; the tsgo fallback is gone, nothing in the gates runs tsc or effect-tsgo).
- **Landmines**: Keep checks explicit and shared-checkout safe; do not weaken a rule or sweep another agent’s files into a command.
- **Read**: [AGENTS](../AGENTS.md), [deploy](../docs/deploy.md).
