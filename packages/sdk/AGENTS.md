# packages/sdk: typed client and v1 flow library

`@sidequest/sdk` owns typed client and v1 flow library and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/sdk`; `bun run --cwd packages/sdk typecheck`; `bun run --cwd packages/sdk test`.
- **Test floor**: 49 files (44 passed, 5 skipped) / 375 passed (34 skipped) — recorded from the RPC-free `heavy bun --no-env-file x turbo run test --cache=local:rw --filter @sidequest/sdk --filter @sidequest/api --filter @sidequest/explore -- --exclude '**/stack.test.ts'` on 11 October 2026 (shared signed mining price lists, lane mp-b; SDK duration 7.96 s). Do not set an RPC variable for this unit suite.
- **Contract**: Typed actions, wallet/board clients, terms, signatures and v1 flow plans.
- **Landmines**: V1 only; addresses and networks come from contract config; prepared operations are not receipts and skipped live flows stay unverified.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).
