# Sidequest media: build plan

Date: 23 October 2026. Status: proposed, with [ADR-0029](../adr/0029-sidequest-hosts-its-media.md). Each stage ships to
dev on its own; prod needs Kris (AGENTS.md hard rule 1).

## Facts that shape it

- The release guard refuses any new resource (`scripts/ci/release.ts:406`), so a dedicated bucket needs one reviewed
  expected create. Alchemy's presign credentials mint an account-wide R2 token; use a hand-made bucket-scoped token.
- The API reads POST bodies into memory with a 2 MiB cap (`apps/api/src/request-body.ts:2`); `upload_sample` is base64 in
  JSON, at most 1 MiB. The kit's largest file is 99.6 MB (106 public assets, 1.44 GB). Uploads go straight to R2 with
  presigned PUTs.
- D1 tables are created at runtime (`CREATE TABLE IF NOT EXISTS`) and generated as migration files
  (`scripts/db-generate.mjs`); media follows that.
- Hosted grants carry the operator (`resolveOAuth` returns `owner: row.operator`, `apps/api/src/oauth.ts:111`), and stage
  lists are read at runtime from the bundled profile, as Commons roles are.
- ADR-0028's scope mechanism: `consentScopes`/`boundScopes` (`oauth-setup.ts`), `requiredToolScope`, the refusal and
  `awaitsApproval` (`mcp-policy.ts`), Explore's `commonsRoleOffer`/`consentBody` and the consent tick.
- `mcp.ts:279` requires an `operationKey` for every tool whose scope is not `sidequest:read`; operator reads need it
  decided by `readOnlyHint` instead.
- `read-cache.ts` turns non-200/304 replies into `no-store` (breaks 206) and keeps the Worker's own `cache-control` only
  for a few prefixes; every request makes two management-object round trips first (`worker.ts:378-385`), so `/files/`
  branches out early, as `/aa/rpc` does.
- The kit serves uploaded HTML and SVG with `script-src 'none'`; Explore's origin holds the sign-in session, so those get a
  sandbox CSP. `/crew/landed` has no handler in the kit (crew reads only `state` and `code` from the pasted address).
- Explore's CSP has no `media-src`; same-origin `/files/` works, R2 previews need one line.

## Stages

Lanes: **A** API (stages 1–3), **B** Explore (4–5), **C** consent and policy (part of 3), **D** skills, crew and Goblin
(6), **E** migration (7).

**Stage 0: decisions and spikes (no deploy).** Kris answers the open questions below. Spike the presigned PUT with
`aws4fetch` on a scratch bucket (content type and `x-amz-checksum-sha256` signed in; R2 refuses a mismatched body;
`head().checksums.sha256` filled; ranged GETs on presigned URLs). Inventory the kit with the owner token: hidden assets,
`briefs/`, and hidden assets that posts or briefs link to.

**Stage 1: foundation.** `infra/<stage>.json` gains `media.operators` and `resources.Media`; `infra/stage.ts` validates
them. `Cloudflare.R2.Bucket('Media')` (CORS PUT from the stage origin, abort multipart after a day) bound to the API;
stage secrets `MEDIA_R2_ACCESS_KEY_ID` / `MEDIA_R2_SECRET_ACCESS_KEY` (unset: upload tools answer `unavailable`).
`release.ts` learns a reviewed `--expect-create <fqn>` (only R2 buckets, exact list). `apps/api/src/media/schema.ts`
(`migrateMedia`), migration `0002_media.sql`, `migrations:record`. Tests: stage profile, release guard,
`migrations:check`.

Schema (D1, additive): `media_groups` (id, title, note, position, featured, visibility), `media_batches` (id, title,
brief, source, picked asset), `media_assets` (id kept from the kit, visibility, kind, title, description, note, group,
position, batch, variant, dimensions, duration, source, created by/at, published by/at, revision, deleted_at),
`media_files` (asset, name, role main/poster/captions/extra, R2 key, bytes, media type, sha256), `media_postings`
(asset, channel, day, text, note), `media_posts` and `media_post_assets`, `media_uploads`, `media_operations`
(actor + operationKey journal), `media_log` (append-only audit). Public URLs are `/files/<assetId>/<name>`, stable
across versions, so `/f/<id>/<name>` redirects are a path rewrite.

**Stage 2: core, public reads, serving.** `apps/api/src/media/{store,serve,presign,platform,tools}.ts`;
`GET|HEAD /files/…` early in `worker.ts` (404 for internal, unknown and deleted alike); `/data/media`; `read-cache.ts`
fixes; public tools `list_media`, `get_media`, `list_media_posts` (READ_TOOLS, REVIEW, registry). Explore proxies
`/files/`. Tests: store visibility, serving (HEAD, ranges, 416, 304, `dl`, sandbox CSP), workerd routes, cache policy.

**Stage 3: operator scope and tools.** `sidequest:media` in `OAUTH_SCOPES`; operator-granted scopes generalised
(`maintain`, `media`); consent offers the media tick only to a listed operator; setup refuses it; policy, refusal and
`awaitsApproval`; `operationKey` decided by `readOnlyHint`; `whoami.media`. Hosted media tools run Worker-local with the
grant's operator as the actor; REST `/api/<media tool>` takes the SIWE session; the operator list is the second key.
`prepare_media_upload` (presigned PUTs, one hour, 1 GiB per file) and `add_media` (head, size and sha256 check, internal
asset or new version). Explore consent gains the unticked media tick. Gate on dev: a `0x5f3D…` agent with the tick
uploads, adds, publishes (`/files` 200) and unpublishes (404); recorded in reality-check.

**Stage 4: Explore `/media` public page.** Groups in order, featured row, video player (poster, captions track),
downloads, posting copy with copy buttons, the "post this week" schedule, recent posts; a pure view model
(`src/media.ts`); `apps/explore/design.md` tokens.

**Stage 5: operator view `/media/internal`.** Batches with variants (presigned previews), publish sheet, unpublish,
delete, groups, record post, browser upload (streaming sha256, poster from a frame, PUT to R2, then `add_media`);
`media-src` for R2 previews. Gate: a 200 MB browser upload published on dev.

**Stage 6: generation.** `skill/media/SKILL.md` (levels, batches, upload flow, what may go in); `get_instructions` role
`media`. Crew Reel gets `sidequest:media` and a ROLE section (Sidequest's own renders become internal variants with
`batch` = brief id and the MySI run id as source; paid deliveries unchanged). Goblin Reel persona instructions; an
optional pull-from-URL `add_media` (streamed with a hash, allowlisted hosts) if personas have no shell.

**Stage 7: migration and cutover (prod with Kris).** `scripts/media/import-kit.ts` (dry run, then import through the
tools only, `operationKey` `kit-import:<id>:<sha8>`, sha256 verified through `/files`); prod release and import; kit
writes frozen; the kit Worker becomes a redirector (`/` → `/media`, `/f/<id>/<name>` → `/files/<id>/<name>`,
`/crew/landed` a static page, `/manifest.json` and `/mcp` 410); remove the user-level `sidequest-media` MCP; rewrite the
`sidequest-media` skill; retire KV and the owner token after two weeks; keep the old bucket read-only for 30 days.

**Stage 8 (optional): self-run agents.** SIWE agents have no consent tick: an explicit `media.selfRunAgents` allowlist
plus `getAgentWallet(agentId) == session` and `ownerOf(agentId) ∈ operators`.

Docs with each stage: ADR index, GLOSSARY (media asset, internal/public, publish, batch, media operator, media scope),
`reference/mcp.mdx`, `http-api.mdx`, `concepts/media.mdx`, `docs/agents/agent-setup.md` consent table, `docs/stages.md`,
`docs/deploy.md`, and dated reality-check rows (planned, implemented/tested and live-verified kept apart).

## Risks

1. Without the guard change the dedicated bucket cannot release; the fallback is a `media/` prefix in `Manifests` behind
   the same bucket interface.
2. Hidden kit assets that posts or briefs link to lose their links unless published; stage 0 lists them.
3. Same-origin HTML and SVG must be sandboxed, with a test.
4. Ranges and caching: the `read-cache.ts` fixes and the early `/files/` branch.
5. R2 checksum handling is unverified until the spike; the fallback hashes on `add_media`.
6. Presigned URLs reach model transcripts (internal media only, one hour).
7. Browser hashing of large files must stream.
8. The kit's zip secret scan was client-side; it becomes an instruction and helper, with an optional check at publish.
9. Remove the user-level MCP only after the prod import and redirects are verified.
10. Old Explore tabs: keep both consent fields optional.

## Open questions for Kris

1. Dedicated `sidequest-<stage>-media` bucket with a one-time expected create (default), or a `media/` prefix in
   `Manifests`?
2. Scope name `sidequest:media`, and ADR-0028 generalised into operator-granted scopes?
3. Public media on the anonymous `/mcp/directory` lane too? Default: no; `/data/media` and connected agents.
4. Operator tools for self-run (SIWE) agents now? Default: later (stage 8).
5. Import `memes-drafts` and `cats-mjav` (not Sidequest) as internal, or leave them?
6. Job briefs under `/f/briefs/*`: a public "Briefs" group on `/media`, or their own route?
7. Hidden assets with post records: publish, or let the link die?
8. `/media` in the main nav or the footer; `noindex` as the kit was?
9. Recording social posts becomes operator-only (the kit let any invited person). Intended?
10. Defaults: 1 GiB per file, one-hour presigned URLs, two weeks of redirector before deleting KV, 30 days before deleting
    the old bucket.
11. Can the Goblin Reel persona upload with a shell (`curl -T`)? If not, pull-from-URL moves into stage 6.
12. Browser upload in `/media/internal` in v1, or agent uploads only at first?
