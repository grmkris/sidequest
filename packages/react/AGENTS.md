# packages/react: React hooks for the client

`@sidequest/react` owns React hooks for the client and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts). Hook implementations under `src` run in the graph's `browser` zone.

- **Check**: `bun run check:files packages/react`; `bun run --cwd packages/react typecheck`; `bun run --cwd packages/react test`.
- **Test floor**: 3 files / 8 passed — recorded from `heavy bun --no-env-file run --cwd packages/react test` on 12 October 2026 (cache identity and session revision). Do not set an RPC variable for this unit suite.
- **Contract**: Headless React hooks over the typed v1 SDK.
- **Landmines**: Keep browser-safe imports and explicit query keys; hooks prepare wallet actions and never imply that a board response funded a hire.
- **Read**: [Explore](../../apps/explore/AGENTS.md), [SDK](../../packages/sdk/AGENTS.md).
