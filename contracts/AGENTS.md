# contracts: Foundry contracts and scripts

`@sidequest/contracts` owns Foundry contracts and scripts and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files contracts`; `cd contracts && forge test`; `bun run check:files contracts`.
- **Test floor**: 373 passed in `cd contracts && heavy forge test --no-match-path 'test/fork/**'` (11 Oct, after mining, vesting and the Factory token were deleted and the recipe moved to an existing SIDE); the required MainnetRunbook targeted suite separately passed 10 tests with `cd contracts && heavy forge test --match-contract MainnetRunbook`. Do not set an RPC variable for this unit suite.
- **Contract**: Sidequest v1 Solidity, deployment scripts, rehearsal tests and network config.
- **Landmines**: Read ethskills first; v1 only under `contracts/src/sidequest`; use encrypted keystores and never transact on mainnet without Kris.
- **Read**: [protocol](../docs/protocol.md), [mainnet runbook](../docs/mainnet-runbook.md), `.claude/rules/contracts.md`.
