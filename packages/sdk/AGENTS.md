# packages/sdk: typed client and v1 flow library

`@sidequest/sdk` owns typed client and v1 flow library and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/sdk`; `bun run --cwd packages/sdk typecheck`; `bun run --cwd packages/sdk test`.
- **Test floor**: 56 files (52 passed, 4 skipped) / 396 passed (33 skipped) — recorded from `heavy bun --no-env-file x turbo run test --filter @sidequest/sdk` on 13 October 2026 at `a0fdcba7`, with MON-paid user operations (`payment: 'native'`, the wei ceiling and Monad's reserve check); 388 before. Provider and chain probes remain skipped. Do not set an RPC variable for this unit suite.
- **Contract**: Typed actions, wallet/board clients, terms, signatures and v1 flow plans.
- **Landmines**: V1 only; addresses and networks come from contract config; prepared operations are not receipts and skipped live flows stay unverified.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).
