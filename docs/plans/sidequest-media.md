# Sidequest media: build plan

Date: 23 October 2026. Status: accepted with [ADR-0029](../adr/0029-sidequest-hosts-its-media.md). M1 to M4 ship to dev
one coherent change at a time; M5 is the one prod cutover, with Kris present (AGENTS.md hard rule 1).

## Facts that shape it

- **Zone:** sidequest.exchange is on Cloudflare's Free plan, so a request body is capped at 100 MB (checked 23 Oct). The
  kit's largest file is 99.6 MB; the import uses `sourceUrl`, never an upload.
- **Prod admission:** `packages/board/src/admission.ts:184` refuses any tool missing from `hostedToolNames` on
  mainnet, and `apps/api/src/worker.ts:592` runs it before Worker-local tools. Media tools dispatch before
  `hostedCallFailure`, as `find_services` and the directory tools do.
- **MCP:** `worker.ts:793-806` sends a fixed list to `call()` and everything else to the management object; `call()`
  acts as `grant.address`, the agent's wallet. Media gets its own branch in the `mcpRoute` callback with the grant's
  operator as the actor.
- **Streaming:** `avatars.ts:85` reads whole objects into memory, and `HttpServerResponse.fromWeb` re-streams a body
  without its length. File replies use `HttpServerResponse.raw(new Response(object.body, …))`, and serving ports the
  kit's `serve()` and `parseRange` (`~/code/sidequest-media/src/worker.ts:90-141`).
- **Cache policy:** `read-cache.ts:29-47` no-stores any reply with a cookie or a status other than 200/304, and keeps the
  Worker's `cache-control` only for a few prefixes; `withReadCachePolicy` wraps all of fetch (`worker.ts:1029`).
- **Routing:** the Explore Worker owns the domain and proxies `PROXIED` (`apps/explore/routing.ts:8-23`) to the API
  through a service binding; file paths otherwise reach static assets. The early branch for `/media/f/` sits after `sql`
  (`worker.ts:284`) and before the migrations (369) and the two management round trips (377-385).
- **Release guard:** `scripts/ci/release.ts:406` refuses creates; `deferredCreates` (460-470) is the pattern for a
  reviewed `--expect-create`. Resource names are also hard-coded at `release.ts:106-107`, the first-deploy census
  (388-394) and `infra/stage.ts:19,42`.
- **Secrets:** `runtimeSecret` accepts only `prodSecretSources` (`packages/board/src/runtime.ts`), and the prod
  artifact checks that list for equality, so `MEDIA_SIGNING_KEY` goes in a separate optional list.
- **Consent:** the server does not check roles before accepting the maintain tick today
  (`apps/api/src/oauth-setup.ts:126-130`); the media offer is computed and enforced server-side. Clients that name their
  scopes (the crew) must ask for `sidequest:media`. `mcp-policy.ts:354` refuses without a step-up, and `mcp.ts:279`
  decides `operationKey` by scope, so reads move to `readOnlyHint`.
- **Indexer:** it binds the same D1 (`apps/indexer/src/worker.ts:88`) but cannot import `apps/api`, so the schema and
  the digest query live in `packages/indexer`. It knows its stage only at deploy time; a `DEPLOY_STAGE` binding gives it
  `stageProfile(...).media` at runtime.
- **Telegram:** `POST /telegram/webhook` answers 405 on dev and prod (23 Oct): the path is not in Explore's `PROXIED`
  list, so `/start <code>` from the bot likely never links a wallet. The digest depends on linked wallets.
- **The kit (23 Oct):** 163 assets (106 public), 1.44 GB. Hidden: `memes-drafts` 38, `cats-mjav` 12 (not Sidequest),
  `film-material` 4, and 3 MyCut demos in `updates`. Only the four film-material assets are linked from elsewhere (the
  since-launch brief). The 5 posts use public assets only. Briefs linked from films, jobs and docs: `launch-week.md`,
  `sidequest-style.md`, `since-launch.md`, `promo-we-didnt-make-this.md`. The crew's OAuth redirect is
  `https://media.sidequest.exchange/crew/landed` (`crew/README.md:67`).

## Milestones

**M0: spikes, inventory, docs (no deploy).** The facts above; ADR-0029 accepted and amended; this plan. Kris reads
`getWebhookInfo` back (sanitized). The prod team is Kris alone (24 Oct).

**M1: API library core.**
- `infra/{dev,prod}.json`: `resources.Media` and `media { team, timezone, pullHosts }`; `infra/stage.ts` validates them.
- `apps/api/src/media-bucket.ts` (modelled on `manifests.ts`), bound beside `Manifests`, yielded in `alchemy.run.ts`;
  `release.ts --expect-create` for exactly one R2 bucket.
- `packages/indexer/src/media-schema.ts` (six tables, `migrateMedia`); `scripts/db-generate.mjs` generates its
  migration; `bun run migrations:record`.
- `apps/api/src/media/`: `access` (team, roles, actors), `store` (D1 reads and writes, revisions, the log), `tokens`
  (preview HMAC, share hashes, upload URLs), `serve`, `upload`, `pull`, `tools`.
- `worker.ts`: the early `/media/f/` and `/media/upload/` branch, migration, REST dispatch before admission, the MCP
  branch. `read-cache.ts`: `/media/f/` keeps its own cache-control on 200/206/304.
- Scope: `oauth-validation.ts`, `oauth-setup.ts`, `oauth.ts` (offer), `mcp-policy.ts`, `mcp.ts`, `agent-runtime.ts:139`,
  `mcp-registry.ts`, `mcp-tool-metadata.ts`.
- Tests: the store's role matrix, approval and recording rules, revisions and key replay; workerd serving on real R2 and
  D1 (200, 206, 304, 416, HEAD and lengths; internal 404; `?p` and `?s`; a wrong sha refused); prod admission; the
  cache policy; consent; policy; registry; stage profile; release guard.
- Dev gate: an agent with the tick uploads by `curl -T`, adds, shares, publishes (200 with ranges) and unpublishes (404).

**M2: Explore.** `routing.ts` (`/media/f/`, `/media/upload/`, the exact `/telegram/webhook`); routes `/media`,
`/media/$assetId`, `/media/internal`, `/media/s/$token`; `src/media.ts` (pure view model); `MediaPlayer` (native video,
poster, captions track); the Library tab; nav and footer; consent's media tick from the server's offer.

**M3: planner and digest.** Plan, Campaigns and Shares tabs; `byDay` moved out of `routes/Activity.tsx`; channel checks
(length, 9:16, captions, public files); `packages/indexer/src/media-digest.ts` through `enqueueWalletNotification`; the
indexer's `DEPLOY_STAGE` binding.

**M4: agents, crew, docs.** `skill/media/SKILL.md`; a `media` role in `mcp-instructions.ts`; the crew Reel scope; Goblin
Reel persona instructions; `reference/mcp.mdx`, `http-api.mdx`, `concepts/media.mdx`, the consent table in
`docs/agents/agent-setup.md`, GLOSSARY, `docs/stages.md`, `docs/deploy.md`.

**M5: cutover (prod, with Kris).** `scripts/media/import-kit.ts` (a pure, tested mapping; keys
`kit-import:<id>:<sha8>`; postings split by `--today`; the since-launch brief rewritten to the share) rehearsed in full
on dev; then freeze kit writes, the prod release, the import with sha256 checks, the redirector from the kit repo,
removing the user-level MCP, rewriting the `sidequest-media` skill and the sidequest-films tools that write to the kit.
Rollback is reverting the redirector. Dated reality-check rows keep planned, tested and live-verified apart.

## Risks

1. The 100 MB request cap on uploads; larger files come by `sourceUrl` until presigned PUT is added.
2. The release-guard exception must stay one named R2 bucket; tests prove every other create is still refused.
3. Same-origin HTML and SVG: a sandbox CSP on every file reply, with a test.
4. Preview and share URLs are bearer capabilities: two-hour previews, hashed and revocable shares.
5. Team changes need a release; the quick switches are revoking a grant and unpublishing.
6. The digest depends on Telegram links, which depend on the webhook fix; it is a reminder, not the record.
