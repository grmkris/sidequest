# packages/sdk: typed client and v1 flow library

`@sidequest/sdk` owns typed client and v1 flow library and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/sdk`; `bun run --cwd packages/sdk typecheck`; `bun run --cwd packages/sdk test`.
- **Test floor**: 47 files (43 passed, 4 skipped) / 343 passed (33 skipped) — recorded from `heavy bun run --cwd packages/sdk test` on 12 October 2026, with what a SIDE amount costs, graduation and SIDE's pages (`launcher.test.ts`, `deployment.test.ts`) and the ERC-4337 user-operation suites (44/322 before). Do not set an RPC variable for this unit suite.
- **Contract**: Typed actions, wallet/board clients, terms, signatures and v1 flow plans.
- **Landmines**: V1 only; addresses and networks come from contract config; prepared operations are not receipts and skipped live flows stay unverified.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).
