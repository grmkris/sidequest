# Sidequest: agent instructions

Master file. `CLAUDE.md` is a symlink to it — edit `AGENTS.md`. MCP servers: `.mcp.json`; run `bunx repoagents` after changing agent config.

Start with [README.md](README.md), the [glossary](GLOSSARY.md), [protocol law](docs/protocol.md) and the relevant [ADR](docs/adr/README.md).

## Start here

- Work on `dev`; there is no `main`. Push `dev` when your commits are green.
- This is a shared checkout. Preserve edits you did not make: never stash, reset, restore, clean, checkout over, or broadly stage them. Stage explicit paths and commit each coherent change as `<area>: <what changed>` with the author trailer required by the assigned lane.
- Read the workspace instructions linked in the repository map before editing its files.

## Repository map

Runtime classes come from [tools/graph.ts](tools/graph.ts). Each workspace has its own instructions:

- [apps/api](apps/api/AGENTS.md) (cloud), [apps/indexer](apps/indexer/AGENTS.md) (cloud), [apps/explore](apps/explore/AGENTS.md) (browser), [apps/arbiter](apps/arbiter/AGENTS.md) (daemon), [apps/docs](apps/docs/AGENTS.md) (browser).
- [packages/sdk](packages/sdk/AGENTS.md), [packages/board](packages/board/AGENTS.md), [packages/indexer](packages/indexer/AGENTS.md), [packages/react](packages/react/AGENTS.md), [packages/commons](packages/commons/AGENTS.md) (shared).
- [contracts](contracts/AGENTS.md) and [tools](tools/AGENTS.md) (tooling).

## Commands

```bash
bun install
bun run check:files <paths...>
bun run agents:check
bun run graph
bun run check
bun run build
bun run deploy:dev
```

Run package tests with `bunx turbo run test --filter <workspace>`.

## `heavy`

Use `heavy` for commands that may take over a minute;
exit 75 means the shared box is busy and should be retried. Never pipe `heavy`.

## Hard rules

1. Never push to `prod` or run `deploy:prod`, `--stage prod`, or a prod release without Kris's explicit approval.
2. Any mainnet transaction needs Kris's explicit approval; use encrypted keystores for transaction signing.
3. Secrets live only in `~/.config/sidequest/*.env`, `.env.local`, or GitHub environments. Never print or commit them.
4. D1 and SQLite migrations are additive. Never drop, rename, or retype live tables or columns.
5. Never weaken lint. A disable needs `-- <reason>` beside it.
6. Test counts must not drop; record workspace floors when changing test-sensitive code.
7. No mocks in product paths. Test doubles belong only in unit tests and every integration has a real test.
8. Addresses and networks come from `contracts/config/<network>.json`, never from code literals.
9. Persist an operation before a money-moving call and reconcile the original operation before retrying.
10. Planned, implemented/tested, and live-verified are distinct claims; cite live evidence in `docs/reality-check.md`.
11. No speculative complexity without the user's buy-in: build what was asked, not robustness or abstraction nobody requested.

## Task map

- Protocol or contract behavior: [docs/protocol.md](docs/protocol.md), [contracts/AGENTS.md](contracts/AGENTS.md), and `ethskills`.
- SDK, board, indexer, API, Explore or React: the linked workspace file and [GLOSSARY.md](GLOSSARY.md).
- Stage or release work: [docs/stages.md](docs/stages.md), [docs/deploy.md](docs/deploy.md), and `.claude/rules/stack-and-stages.md`.
- Database changes: `.claude/rules/databases-and-migrations.md` and `bun run db:generate`.
- Mainnet preparation: [docs/mainnet-runbook.md](docs/mainnet-runbook.md) and `ethskills`, with Kris present for every transaction.
- Product role workflows: [protocol](docs/protocol.md) and the [connector](skill/connector/SKILL.md), [publisher](skill/publisher/SKILL.md), [worker](skill/worker/SKILL.md), [arbitrator](skill/arbitrator/SKILL.md) skills.
- Agent harness setup and checks: [setup](docs/agents/agent-setup.md), [test floors](docs/agents/testing.md); development skill locations are in the setup guide.

## Definition of done

The requested files are complete, links resolve, the owning checks and tests pass, no unrelated edits are staged, and the
commit records the reason and evidence. Leave a status line in the lane status file when the assigned work is complete.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
