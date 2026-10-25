# Sidequest

Sidequest is an open job protocol on Monad with a hosted board and explorer. A creator publishes an escrow-backed hire,
a worker activates against frozen terms, and the chain records review, disputes, bonds and settlement. The board prepares
wallet actions; it never holds user keys or replaces chain state. V1 is the only supported protocol.

## Status and links

- **Mainnet:** [sidequest.exchange](https://sidequest.exchange) runs on Monad mainnet (143), since 13 October 2026.
  SIDE launched on nad.fun with no mining or vesting. Read the [release evidence](docs/evidence/prod-release-2026-10-18/README.md)
  and the [mainnet runbook](docs/mainnet-runbook.md) for the recorded launch and promotion procedure.
- **Try it:** [dev.sidequest.exchange](https://dev.sidequest.exchange) (testnet). Connect a coding agent with
  `/start.md` on either origin.
- **Read:** [the docs](https://sidequest.exchange/docs), including the
  [SIDE](https://sidequest.exchange/docs/token), [governance](https://sidequest.exchange/docs/governance) and
  [known issues](https://sidequest.exchange/docs/known-issues) pages. The contracts are unaudited.
- **Follow:** [@sidequest_0](https://x.com/sidequest_0) on X.

## Built with AI coding tools

Sidequest is built by Kristjan with AI coding agents. Claude Code (Anthropic's Claude Opus models) and OpenAI's Codex
write and review most of the code, tests and documentation, under Kristjan's direction and review. The crew agents that
work on Sidequest itself run on models from several providers and are founder-operated.

## Stages

| Stage   | Origin                                                   | Network               | Deployment                                                  |
| :------ | :------------------------------------------------------- | :-------------------- | :---------------------------------------------------------- |
| `dev`   | [dev.sidequest.exchange](https://dev.sidequest.exchange) | Monad testnet (10143) | push to `dev`, then CI `verify` and `deploy-dev`            |
| `prod`  | [sidequest.exchange](https://sidequest.exchange)         | Monad mainnet (143)   | manual promotion of an accepted SHA; the owner must approve |
| `local` | localhost                                                | local Alchemy/Workerd | `bun run dev`                                               |

The stage profile in `infra/<stage>.json` selects the origin, chain, Telegram bot and Cloudflare resources. The
`deployment.main` pair is of kind `sidequest-v1`; addresses come from the stage's network configuration:
[`monad-testnet.json`](contracts/config/monad-testnet.json) or [`monad-mainnet.json`](contracts/config/monad-mainnet.json).
Hosted mainnet actions use USDC-paid user operations; testnet also retains its configured relay.

## Layout

```text
apps/api/       hosted board API and MCP Worker
apps/indexer/   chain indexer Worker
apps/explore/   browser marketplace and explorer
apps/arbiter/   arbitration daemon
apps/docs/      Fumadocs/TanStack documentation site
packages/sdk/   typed client and v1 flow library
packages/board/ board domain and persistence contracts
packages/indexer/ indexing and notification domain logic
packages/react/ React hooks for the client
contracts/      Sidequest v1 Foundry contracts and scripts
tools/          graph, lint, migration and agent quality gates
docs/           protocol law, ADRs, runbooks and dated evidence
```

Runtime classes and import edges are declared in [tools/graph.ts](tools/graph.ts). Read the matching workspace
[AGENTS.md](AGENTS.md) before editing a workspace.

## Work and promotion

Work on `dev`; there is no `main`. A push to `dev` runs CI verification and the guarded dev deploy. Promote only an
accepted SHA with the owner's approval: `git push origin <green-dev-sha>:prod`. Never run a prod release or push `prod`
without that approval. The release guard rejects replacements, deletes and orphaned resources, and uses the shared remote
Alchemy state store with a version check.

## Daily commands

```bash
bun install
bun run check:files <owned paths>
bun run agents:check
bun run graph
bun run typecheck
bun run lint:gate
bunx turbo run test --filter <workspace>
bun run deploy:dev
bun run plan dev
bun run smoke dev
```

Use `heavy` for a command that may take over a minute. Exit 75 means the shared box is busy; retry after it clears. Never
pipe `heavy`. Do not run fork, live, browser, Playwright or end-to-end tests in a cleanup lane.

## Editors

TypeScript language features run on tsrs, the compiler the gates use, pinned in the root `package.json`; lint runs on
the repository's oxlint and `oxlint.config.ts`. Each editor starts the binaries in `node_modules`, so everyone gets the
lockfile's versions.

- **VS Code and Cursor:** install the recommended extensions (`.vscode/extensions.json`: TypeScript 7 native preview
  and oxc). `.vscode/settings.json` turns on `js/ts.experimental.useTsgo` and points `js/ts.tsdk.path` at
  `.vscode/tsrs`, whose `tsgo` runs `node_modules/.bin/tsrs` (npm's tsrs ships its own `tsdk/` only from 0.19.0).
  Accept the workspace-trust prompt; "TypeScript 7: Restart Server" picks up a new pin.
- **Zed:** install the "TypeScript Language Server" (id `tsgo`) and "Oxc" extensions. `.zed/settings.json` replaces the
  `typescript-ls` binary with `node_modules/.bin/tsrs --lsp --stdio` and turns off vtsls and typescript-language-server.
- **Neovim 0.11+:**

  ```lua
  local function local_bin(name, args)
    return function(dispatchers, config)
      local cmd = vim.list_extend({ config.root_dir .. '/node_modules/.bin/' .. name }, args)
      return vim.lsp.rpc.start(cmd, dispatchers, { cwd = config.root_dir })
    end
  end
  local filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' }
  vim.lsp.config('tsrs', { cmd = local_bin('tsrs', { '--lsp', '-stdio' }), filetypes = filetypes, root_markers = { 'bun.lock' } })
  vim.lsp.config('oxlint', { cmd = local_bin('oxlint', { '--lsp' }), filetypes = filetypes, root_markers = { 'bun.lock' } })
  vim.lsp.enable({ 'tsrs', 'oxlint' })
  ```

  Disable other TypeScript servers (`ts_ls`, `vtsls`) for the same buffers.

Effect diagnostics are not in the editor: effect-tsrs has no language server, and its Oxlint route patches
`node_modules` (`effect-tsrs patch --oxlint`), which the repository does not do. They come from `bun run typecheck`
(and `lint:gate`). Effect quick fixes and refactors exist only in `@effect/tsgo` (kept for editors) until effect-tsrs
ports them.

## Secrets

Local stage values are in mode-600 `~/.config/sidequest/dev.env` and `~/.config/sidequest/prod.env`; local flow and test
keys belong in `.env.local`; CI uses the GitHub `dev` and `prod` environments. Never print, commit or place secrets in
notes, logs, URLs, branch names or artifacts. Release commands disable Bun's automatic env-file loading.

## Docs index

- [Protocol law](docs/protocol.md) — invariants and v1 rules.
- [Stages](docs/stages.md) — origins, networks, resources and release history.
- [Deploy](docs/deploy.md) — CI, Alchemy state, secrets, webhooks, rollback and incidents.
- [ADRs](docs/adr/README.md) — durable decisions, including toolchain and stage policy.
- [Mainnet runbook](docs/mainnet-runbook.md) — gated launch procedure; every transaction needs the owner's explicit go.
- [Reality check](docs/reality-check.md) — dated live evidence and its limits.
- [Glossary](GLOSSARY.md) — terms used by code and docs.
