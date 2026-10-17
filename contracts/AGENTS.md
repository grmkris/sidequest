# contracts: Foundry contracts and scripts

`@sidequest/contracts` owns Foundry contracts and scripts and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files contracts`; `bun run --cwd contracts test`; `bun run check:files contracts`.
- **Isolation**: The workspace runs Forge with `--threads 1`: recipe and Safe acceptance tests mutate process-global `MAINNET_GO` / `NETWORK` variables. Parallel suites can overwrite another test's approval fixture. Keep all assertions and tests enabled; use the same serialization for direct full-suite runs.
- **Test floor**: 436 passed / 22 skipped in `heavy forge test --threads 1` on 17 October 2026, including the 16-test MainnetRunbook suite (previous floor 435). The workspace also passed 27 offline launch-kit Python tests, including interruption/reconciliation paths with a stubbed cast. Fork/live tests remain skipped without RPC variables. Do not set an RPC variable for this unit suite.
- **Contract**: Sidequest v1 Solidity, deployment scripts, rehearsal tests and network config.
- **Landmines**: Read ethskills first; v1 only under `contracts/src/sidequest`; use encrypted keystores and never transact on mainnet without Kris.
- **Read**: [protocol](../docs/protocol.md), [mainnet runbook](../docs/mainnet-runbook.md), `.claude/rules/contracts.md`.
