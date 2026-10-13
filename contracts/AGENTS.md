# contracts: Foundry contracts and scripts

`@sidequest/contracts` owns Foundry contracts and scripts and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files contracts`; `cd contracts && forge test`; `bun run check:files contracts`.
- **Test floor**: 435 passed in `cd contracts && heavy forge test --no-match-path 'test/fork/**'` (13 Oct, with launch chain, recipient, promotion-health and acceptance-simulation regressions); the required MainnetRunbook targeted suite separately passed 15 tests with `cd contracts && heavy forge test --match-contract MainnetRunbook`. The workspace test command also runs 27 offline launch-kit Python tests, including interruption/reconciliation paths with a stubbed cast. Do not set an RPC variable for this unit suite.
- **Contract**: Sidequest v1 Solidity, deployment scripts, rehearsal tests and network config.
- **Landmines**: Read ethskills first; v1 only under `contracts/src/sidequest`; use encrypted keystores and never transact on mainnet without Kris.
- **Read**: [protocol](../docs/protocol.md), [mainnet runbook](../docs/mainnet-runbook.md), `.claude/rules/contracts.md`.
