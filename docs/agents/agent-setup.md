# Agent setup

[`AGENTS.md`](../../AGENTS.md) is the shared instruction source. Codex reads ancestor files down to its working
directory; a session at the root must explicitly read the linked workspace instructions before editing a workspace.
Every `CLAUDE.md` is a symlink to its sibling `AGENTS.md` (Grok reads only `CLAUDE.md` and ignores `@AGENTS.md` imports); Claude-only notes live in `.claude/rules/claude-code.md`. MCP servers live in `.mcp.json`; `bunx repoagents` regenerates `.codex/config.toml` and `.cursor/mcp.json` (standard: grmkris/personal `infra/agents.md`).
Cursor always loads the pointer in `.cursor/rules/sidequest.mdc`.

## Development and product skills

Development skills, when installed, belong in `.agents/skills/<name>/SKILL.md`; Claude sees per-skill relative links in
`.claude/skills/`. No development skill bundle is installed in this lane's starting tree. Do not invent a skill or treat a
permission to read it as approval to deploy, sign or send. Manual-only skills run only when invoked by name.

`skill/**` is different: Sidequest serves those product role guides to its users. The
[connector](../../skill/connector/SKILL.md), [publisher](../../skill/publisher/SKILL.md),
[worker](../../skill/worker/SKILL.md) and [arbitrator](../../skill/arbitrator/SKILL.md) guides describe product usage.
They are not repository development rules and are owned by the product-skills lane.

## Permissions and rules

`.claude/settings.json` asks before prod release/deploy, destroy and push commands. It denies secret reads and broad or
destructive git commands. Local settings are user-owned; do not edit `.claude/settings.local.json`.
Path rules cover [stacks and stages](../../.claude/rules/stack-and-stages.md),
[databases](../../.claude/rules/databases-and-migrations.md) and [contracts](../../.claude/rules/contracts.md).
Other harnesses should read the relevant rule file explicitly.

Launch Claude from an interactive shell so environment-substituted MCP servers authenticate. Never inspect or print
credential stores to diagnose a tool. `bun run agents:check` verifies instruction files, shims and agent-facing links.
[Testing](testing.md) records the current floor evidence and cleanup check boundary.

## Skills and MCP (2026-10-10)

Skills are vendored into `.agents/skills` and pinned in `.agents/skills/sources.json` (v2: upstream commit, SPDX
license, tree hashes, recorded adaptations); `.claude/skills` holds per-skill links. The set: the shared design,
review and grilling skills (from grmkris/personal), Cloudflare (cloudflare/skills), effect-ts (Effect-TS/skills),
domain-modeling, and contracts: ethskills (adapted: local links) plus Trail of Bits building-secure-contracts
(CC-BY-SA-4.0, unmodified). Change them with `bunx repoagents skills add|rehash|update`; `bun run agents:check` runs
`repoagents check` first.

## MCP servers and their consents

`.mcp.json` is the one source; `bunx repoagents` writes `.codex/config.toml` and `.cursor/mcp.json` from it. Every
server signs in with OAuth, so no key lives in the repository. Each harness keeps its own tokens, and what a connection
may do is decided at its consent, so give each one the least it needs:

| Server | Address | At its consent |
| --- | --- | --- |
| `mysi` | `https://mysi.lol/mcp` | The MySI hub (myplan, myinbox, mytab, mytmux, mygram): tick only the apps the work needs. |
| `cloudflare` | `https://mcp.cloudflare.com/mcp` | Cloudflare's own OAuth: the account and the narrowest permissions. |
| `goblin` | `https://goblin.surf/mcp` | One connection for several workspaces (Goblin ADR 0097): choose **Sidequest dev** and **Sidequest prod**, never "all my workspaces". |
| `sidequest-dev` | `https://dev.sidequest.exchange/mcp` | Testnet board: connect a testnet agent. |
| `sidequest-prod` | `https://sidequest.exchange/mcp` | Mainnet board, real money: connect a dedicated agent, not one that holds funds you would not let a coding agent spend. |

On either Sidequest board, never tick "Commons role tools" (`sidequest:maintain`, ADR-0028) for a coding agent, and do
not connect one as Sidequest Maintainer (testnet 2376, mainnet 10417): that role belongs to the Goblin Maintainer
persona. Tick "Media" (`sidequest:media`, ADR-0029) only for an agent that makes Sidequest's own media: it then
publishes and approves with its operator's media team role. Mainnet transactions still need Kris's approval
(AGENTS.md hard rule 2); a consent never replaces it.

