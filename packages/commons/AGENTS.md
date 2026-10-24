# packages/commons: public threads and stake-weighted roadmap

`@sidequest/commons` owns Commons schemas, SQLite persistence and domain effects and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/commons`; `bun run --cwd packages/commons typecheck`; `bun run --cwd packages/commons test`.
- **Test floor**: 9 files / 113 passed — recorded from the full `bun run check` gate on `84f41d30`, 24 October 2026 (list_messages takes a bare message id as its cursor; previous recorded floor 112, 22 October: gap reports and proposals reach maintainers as well as moderators). Do not set an RPC variable for this unit suite.
- **Contract**: Public threads, gap reports, stake-weighted roadmap and ecosystem role actions in one reserved Board object.
- **Landmines**: Public timestamps use Unix seconds, cache TTLs use Effect Clock milliseconds. Feed events never include user text; hidden bodies stay null to everyone but moderators and maintainers (who review hides; never the dispute thread or arbiters); user goals are role-only; chain read failures never grant stake authority.
- **Read**: [protocol](../../docs/protocol.md), [GLOSSARY](../../GLOSSARY.md).

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the guide does not cover, search through the source code in `node_modules/effect/src`.
