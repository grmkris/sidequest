# packages/sdk: typed client and v1 flow library

`@sidequest/sdk` owns typed client and v1 flow library and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/sdk`; `bun run --cwd packages/sdk typecheck`; `bun run --cwd packages/sdk test`.
- **Test floor**: 49 files (45 passed, 4 skipped) / 350 passed (33 skipped) — recorded from `heavy bun run --cwd packages/sdk test` on 12 October 2026, with the ERC-4337 user-operation suites, the user-op policy rules and Privy user-op signing (`privy-server.test.ts`, `userop-policy.test.ts`; 47/343 before). Do not set an RPC variable for this unit suite.
- **Contract**: Typed actions, wallet/board clients, terms, signatures and v1 flow plans.
- **Landmines**: V1 only; addresses and networks come from contract config; prepared operations are not receipts and skipped live flows stay unverified.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).
