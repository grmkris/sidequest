---
paths: ['**']
---

# Claude Code only

- Repository development skills, when added, live in `.agents/skills/`; Claude loads their per-skill links from
  `.claude/skills/`. Read the matching `SKILL.md`.
- Path-scoped rules load from `.claude/rules/`. `.claude/settings.json` denies secret reads and destructive or broad git
  commands; it has no ask rules, so the prod, destroy and push hard rules in `AGENTS.md` are yours to follow.
- MCP servers come from `.mcp.json`, all OAuth (no keys in the repo): `mysi` (the MySI hub: plans, inbox, browser,
  terminals, Telegram), `cloudflare`, `goblin`, `sidequest-dev` (testnet board) and `sidequest-prod` (mainnet board).
  The consent rules for each are in [agent setup](../../docs/agents/agent-setup.md#mcp-servers-and-their-consents).
