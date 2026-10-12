# apps/docs: documentation site

`@sidequest/docs` owns documentation site and runs as the `browser` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/docs`; `bun run --cwd apps/docs typecheck`; `bun run --cwd apps/docs test`; `bun run --cwd apps/docs build`.
- **Before a deploy**: `heavy node apps/explore/scripts/docs-smoke.mjs` builds Explore with the docs and checks the real Worker over HTTP. After a deploy, `bun run smoke <stage>` checks the live docs (CI runs it).
- **Test floor**: 8 files / 59 passed — recorded from `bun run --cwd apps/docs test` on 12 October 2026 (the get-sponsored guide added; 58 on 11 October after the mining docs were removed and the token, governance, known-issues and FAQ pages added). Do not set an RPC variable for this unit suite.
- **Contract**: Fumadocs/TanStack content, Markdown export, search and `/docs` assets consumed by Explore.
- **Landmines**: Keep content data-only and links valid; no legacy pages; build once before Explore to avoid the parallel race fixed in `ae7a19f`.
- **Read**: [docs/stages](../../docs/stages.md), `apps/docs/content/docs`.

## Content contract

Pages live under `content/docs`. Frontmatter `title` and `description` are required; `mcp` defaults to `true`, and `mcp: false` hides a page from MCP. List every page explicitly in a `meta.json` (a folder may list its own pages). Use ordinary GFM tables, lists and links, fenced code with optional `title="…"`, and images under `content/docs/images/`.

| Component                                            | Markdown form                              |
| ---------------------------------------------------- | ------------------------------------------ |
| `<Callout type="info\|warn\|error\|success" title?>` | `> **Title:** body`                        |
| `<Cards>` / `<Card title href description?>`         | `- [title](absolute .md URL): description` |
| `<Steps>` / `<Step title>`                           | numbered bold title, then indented body    |
| `<Tabs>` / `<Tab title>`                             | bold title and body for every tab          |
| `<Origin path="/mcp" link? />`                       | absolute URL (compile time)                |
| `<ContractAddresses />`                              | current deployment table (compile time)    |

Components use static string attributes and direct children. Raw `a`, `img`, `table`, `pre` elements are allowed within the tested attribute contract. Keep prose data-only: no imports/exports, JSX expressions, braces, arbitrary components, inline handlers, unsafe URLs, raw contract addresses, hand-typed Sidequest origins, code-fence `tab=` or `npm` language, `(group)` folders, or frontmatter `slug`. `{{SIDEQUEST_ORIGIN}}` is allowed only inside code. Sidequest packages are private; do not document package-manager installation commands for them. This docs track allows no `legacy: true` pages. `test/content.test.ts` enforces the contract on every page.

## Build and serving

The docs source honours `SIDEQUEST_DOCS_ORIGIN`; `source.config.ts` keeps compiler plugins outside the browser bundle and disables code highlighting for `SIDEQUEST_DOCS_EXPORT=1`. `src/lib/markdown.ts` exports `pageMarkdown(page)`, shared by the `.md` route and MCP export.

The app prerenders into `dist/client`. Explore copies only docs assets, server-function cache, and LLM files into its client build; its Worker serves `/docs`, `.md` twins, search, and LLM text with content negotiation and per-response script nonces. No new infrastructure resource is created. Explore dev serves a built docs site; use the docs dev server when authoring. `SIDEQUEST_DOCS_PREBUILT=1` reuses a verified build for local Explore builds; release builds rebuild by default.

Design fallback 1 is active: TanStack Start's `prerenderWithVite`, without Nitro (its Vite 8 bundle fails on Shiki's WASM `env` import), with `autoSubfolderIndex: false`. Pages are explicit and crawling is filtered. `scripts/verify-output.mjs` validates every output and checks MCP Markdown parity when that lane's generated module exists.
