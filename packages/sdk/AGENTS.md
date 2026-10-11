# packages/sdk: typed client and v1 flow library

`@sidequest/sdk` owns typed client and v1 flow library and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/sdk`; `bun run --cwd packages/sdk typecheck`; `bun run --cwd packages/sdk test`.
- **Test floor**: 43 files (39 passed, 4 skipped) / 315 passed (33 skipped) — recorded from `heavy bun --no-env-file run --cwd packages/sdk test` on 11 October 2026, after the deployment schema lost its epoch clocks: two clock tables lost their two epoch rows each (319 before; mining and backer share removed earlier, ADR-0022). Do not set an RPC variable for this unit suite.
- **Contract**: Typed actions, wallet/board clients, terms, signatures and v1 flow plans.
- **Landmines**: V1 only; addresses and networks come from contract config; prepared operations are not receipts and skipped live flows stay unverified.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).
