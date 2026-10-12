# contracts: Foundry contracts and scripts

`@sidequest/contracts` owns Foundry contracts and scripts and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files contracts`; `cd contracts && forge test`; `bun run check:files contracts`.
- **Test floor**: 425 passed in `cd contracts && heavy forge test --no-match-path 'test/fork/**'` (13 Oct, with configurable slash recipients and recipient-routing tests); the required MainnetRunbook targeted suite separately passed 11 tests with `cd contracts && heavy forge test --match-contract MainnetRunbook` (13 Oct, with the slash-recipient config row). Do not set an RPC variable for this unit suite.
- **Contract**: Sidequest v1 Solidity, deployment scripts, rehearsal tests and network config.
- **Landmines**: Read ethskills first; v1 only under `contracts/src/sidequest`; use encrypted keystores and never transact on mainnet without Kris.
- **Read**: [protocol](../docs/protocol.md), [mainnet runbook](../docs/mainnet-runbook.md), `.claude/rules/contracts.md`.
