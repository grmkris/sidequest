# 0029: Sidequest hosts its own media: internal and public assets, operator tools behind `sidequest:media`

Status: proposed (Kris, 21–23 Oct 2026: fold the media kit into Sidequest; two levels, internal and public; operators
are agents Kris operates and Kris in the browser; media.sidequest.exchange links keep working). Build plan:
[docs/plans/sidequest-media.md](../plans/sidequest-media.md).
Date: 2026-10-23

## Context

Sidequest's videos, images, posters, captions and HyperFrames source zips live in a separate media kit: the
`sidequest-media` Worker at media.sidequest.exchange, the R2 bucket `sidequest-media`, a `manifest.json` index written
with etag-conditional puts and snapshotted to `history/`, a server-rendered dashboard, and 15 MCP tools behind their own
name-and-password OAuth and an owner token. Everything in that bucket is public by URL; "hidden" only keeps an asset off
the page. Agents now generate variants ("make 4, pick 1") that should never be public, while chosen cuts and brand
assets should be on Sidequest itself and readable by any connected agent. A second sign-in system, a public-by-default
bucket and a manifest that one writer at a time can change do not fit that.

Sidequest already has the pieces: hosted MCP with operator consent and operator-granted scopes (ADR-0028), an operator
per hosted agent, D1, R2, and Explore.

## Decision

**One library, two levels.** Every media asset is **internal** (the default: experiments and variants, visible only to
media operators) or **public** (shown on Explore's `/media` page, served at `/files/…`, and readable by any connected
agent). **Publish** promotes one internal asset to public with its title, group, position and posting copy; unpublish
returns it to internal. Variants of one brief share a **batch**, so picking 1 of 4 is publishing one asset of a batch;
the rest stay internal. A public asset in an internal group is not shown.

**Media operators.** A media operator is a wallet in the stage profile's `media.operators` (`infra/<stage>.json`,
validated in `infra/stage.ts`): on prod Kris's operator wallet, on dev that and the dev crew operator. An agent acts as a
media operator when its operator wallet is listed; Kris acts as one when signed in to Explore with a listed wallet.

**Two keys, like ADR-0028.** An operator media tool runs only when both hold: the connection holds the OAuth scope
`sidequest:media`, and the agent's operator is in `media.operators`, checked on every call. The scope is granted only at
a consent for an existing agent, as an unticked opt-in the consent page offers when the signed-in operator is listed;
the server refuses the tick otherwise and when the client did not ask for it. Setup never grants it, refresh keeps it,
and it is not an agent role. Without it the operator tools are not listed and a call answers the tool error
`scope-required`, not MCP's step-up. `whoami` reports `media`. ADR-0028's mechanism becomes the general rule for
**operator-granted scopes**: `sidequest:maintain` and `sidequest:media` are its two instances, each with its own second
key.

**Storage.** A dedicated R2 bucket per stage, `sidequest-<stage>-media`, declared beside `Manifests`, with no public
access and no custom domain. Its first release names it as the one expected create. Agents and the browser upload
directly to R2 with presigned PUT URLs (one hour, content type and sha256 signed in), so no file passes through the
Worker (whose request bodies are capped well below video sizes); the URLs are signed with a bucket-scoped R2 token held
as stage secrets, not a token minted for the whole account. `add_media` registers an upload only after R2 reports the
declared size and sha256.

**Index.** D1 holds groups, batches, assets, files, posting copy, posts, uploads, an operation journal and an
append-only log. The tables are created by the Worker and generated as an additive migration (`bun run db:generate`,
`bun run migrations:record`). Writes take a stable `operationKey`; a replay answers the first result. The log replaces
the kit's `history/` snapshots.

**Serving.** The API serves `GET|HEAD /files/<assetId>/<name>` only for an effectively public asset, with range
requests, conditional requests and year-long immutable caching when `?v=` matches the file's sha256. Uploaded HTML and
SVG are served in a CSP sandbox, because the origin holds Explore's sign-in session. Internal files are never served by
that route; operators preview them through presigned GET URLs that last an hour. `/data/media` is the anonymous public
index.

**Tools.** Public reads, on every hosted connection (`sidequest:read`): `list_media`, `get_media`, `list_media_posts`.
Operator tools (`sidequest:media`): `prepare_media_upload`, `add_media`, `list_internal_media`, `get_internal_media`,
`update_media`, `publish_media`, `unpublish_media`, `update_media_group`, `delete_media_group`, `record_media_post`,
`update_media_post`, `delete_media_post`, `delete_media`. The kit's people tools are dropped: OAuth consent and the
operator list replace them.

**Explore.** `/media` is the public page (groups in order with a featured row, video playback with captions, downloads,
posting copy with copy buttons, the "post this week" schedule, recent posts). `/media/internal` is the operator view
(batches of variants, publish, unpublish, groups, posts, browser upload).

**Generation.** MySI and MyCut renders made for Sidequest's own media (crew Reel, the Goblin Reel persona, MySI workflow
templates) land as internal variants in a batch through the operator upload tools. Paid job deliveries are unchanged.

**Cutover.** The kit's assets, groups and posts are imported through the operator tools: shown assets become public,
hidden ones internal. media.sidequest.exchange becomes a redirector: `/` to `/media`, `/f/<id>/<name>` to
`/files/<id>/<name>`, `/crew/landed` still a page, and `/mcp` and `/manifest.json` gone. The kit's MCP, OAuth and KV
retire, and the user-level `sidequest-media` MCP is removed.

**Kill switches.** Disconnect the connection, stop the agent, remove the operator from `media.operators`, or unpublish an
asset (its `/files/` URLs answer 404 on the next request).

## Consequences

- One sign-in: agents reach media through the Sidequest connection they already have. Coding agents get it by
  reconnecting and ticking the media opt-in.
- Internal media is never public by URL, unlike the kit's hidden assets. Kit links to hidden assets stop working at
  cutover unless the asset is published first.
- What is published is a public claim. The kit's rules (lead with the work, no invented live numbers, keep the
  "illustrative" and "integration preview" labels) move into the media skill and the `publish_media` description.
- Presigned GET URLs in operator tool results are short-lived capabilities that reach the agent's model provider. MCP
  logs never record results.
- Video bytes are read from R2 on every request; responses are not cached at Cloudflare's edge, so an unpublish takes
  effect at once.
- The release guard learns a reviewed expected create for the media bucket; it still refuses every other create.
- Proposed until Kris accepts it. Nothing here is live-verified until `docs/reality-check.md` records it.

## Alternatives considered

- **Keep the kit and add a private flag.** Two sign-ins and a public-by-default bucket remain; the manifest serializes
  every writer.
- **Keep `manifest.json` in R2 as the index.** One object for every write, no query for "internal variants of batch X"
  or "posts on day Y", and history as whole-file snapshots. D1 is already there.
- **A `media/` prefix in the `Manifests` bucket.** No release-guard change, but the presign token would also write job
  manifests, avatars and samples. Kept as the fallback.
- **Multipart upload through the Worker.** No new credential, but agents must split files and every byte crosses the
  Worker.
- **Reuse `sidequest:maintain`.** A Commons Maintainer could then publish media and a video agent could merge items.
- **Copy-on-publish between public and internal prefixes.** Publishing a 500 MB video becomes a copy that can fail
  halfway; the D1-gated route plus tests give the same guarantee.
- **Keep media.sidequest.exchange as the file host.** A cookie-less origin is safer for HTML, but the kit's sign-in and a
  second Worker stay. The sandbox CSP covers the risk.
