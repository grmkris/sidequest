# 0029: Sidequest hosts its own media at `/media`: internal and public levels, a social planner, a media team

Status: accepted (Kris, 23 Oct 2026: fold the media kit into Sidequest under `/media`, two levels, plan social media
there; agents with the media tick act with their operator's rights; jonas is a team member; posting stays manual with a
morning Telegram digest; one prod cutover after a dev rehearsal). Build plan:
[docs/plans/sidequest-media.md](../plans/sidequest-media.md).
Date: 2026-10-23

## Context

Sidequest's videos, images, posters, captions, briefs and HyperFrames source zips live in a separate media kit: the
`sidequest-media` Worker at media.sidequest.exchange, the R2 bucket `sidequest-media`, a `manifest.json` index written
with etag-conditional puts, a server-rendered dashboard, and 15 MCP tools behind their own name-and-password OAuth and an
owner token. Everything in that bucket is public by URL; "hidden" only keeps an asset off the page. Agents now make
variants ("make 4, pick 1") and working material that should never be public, chosen cuts and brand assets belong on
Sidequest itself, and posts are planned in briefs and chat rather than anywhere both people and agents can read. A second
sign-in system, a public-by-default bucket and one manifest every writer contends for do not fit that.

Sidequest already has the pieces: hosted MCP with operator consent and operator-granted scopes (ADR-0028), an operator
per hosted agent, D1, R2, a Telegram outbox per wallet, and Explore.

## Decision

**One library at `/media`, two levels.** Every asset and group is **internal** (the default: variants, drafts, working
material, visible only to the media team) or **public** (shown on Explore's `/media`, served at
`/media/f/<assetId>/<name>`, readable by any connection). Publishing promotes an asset; unpublishing returns it, and its
files answer 404 on the next request. A public asset in an internal group is not shown. Pages: `/media`, `/media/<id>`,
`/media/internal` (the team's Plan, Library, Campaigns and Shares) and `/media/s/<token>`; the ids `f`, `s` and
`internal` are reserved.

**Campaigns and the plan.** A campaign is a group of kind `campaign`: a brief (a Markdown `document` asset), a window, its
assets and its posts. Variants of one deliverable share a `batch`. A **post** is planned on a channel and account for a
day (and optionally a time) with its text and files, and moves `draft → approved → posted`, or to `skipped`. Approving
needs every file of the post public (the UI offers "publish and approve"); editing an approved post's text or files
returns it to draft; recording a post stores its public URL and never changes a level. Sidequest calls no social
platform: posting is done by hand or by an agent with a browser.

**The media team.** The stage profile lists it: `media.team` in `infra/<stage>.json`, each wallet with a role. A
**member** sees the internal level, uploads, edits, drafts posts, records approved posts as posted and creates shares;
an **operator** also publishes and unpublishes, approves, edits groups and deletes. On prod Kris's operator wallet is an
operator and jonas a member. The browser never receives the list; the API answers the viewer's role.

**Two keys for agents, like ADR-0028.** A media tool beyond the public reads runs for a hosted agent only when its
connection holds the OAuth scope `sidequest:media` and the grant's operator is on the team, checked on every call. The
agent acts with its operator's role. The scope is an unticked consent opt-in that the consent GET offers only when the
signed-in operator is on the team; the POST and setup refuse it otherwise, refresh keeps it, and it is not an agent role.
Without it a call answers `scope-required`, not MCP's step-up. ADR-0028's mechanism is now the general rule for
**operator-granted scopes**, with `sidequest:maintain` and `sidequest:media` as its two instances. In the browser, a SIWE
session acts with its own wallet's role.

**Storage.** A dedicated R2 bucket per stage (`resources.Media`), with no public access and no custom domain, admitted by
one reviewed expected create in the release guard. Objects are content-addressed, `files/<sha256>`. An upload is a
one-hour signed PUT URL on the API that streams the body into R2 with R2's own sha256 check (the Free zone caps a request
at 100 MB), or `add_media({ sourceUrl })`, which streams a render already at an allowlisted https URL (`media.pullHosts`,
no redirects, at most 1 GiB). No R2 S3 credential is minted.

**Index.** D1 holds six tables: `media_groups`, `media_assets` (with suggested captions per channel), `media_files`,
`media_posts`, `media_shares` and `media_log`, the idempotency journal and audit trail in one (unique per actor and
`operationKey`; a replay answers the first result). The schema lives in `packages/indexer` so the indexer can read it, is
created at runtime and is generated as an additive migration.

**Serving.** The API answers `GET|HEAD /media/f/<assetId>/<name>` before any management-object round trip, streaming the
R2 body with its length, single ranges (206, 416), conditional requests and `?dl=1`. A public file is served to anyone,
with a year of immutable caching when `?v=` matches its sha256. An internal file is served only with `?p=` (a
Worker-signed preview token over the asset and an expiry of at most two hours, issued to team actors, so `<video src>`
works without a header) or `?s=` (a share token, stored as a hash, expiring after 30 days by default, revocable), and
those replies are private. Every reply carries a sandbox CSP, `nosniff` and `Referrer-Policy: no-referrer`, because the
origin holds Explore's session.

**Tools.** Public reads on every connection: `list_media`, `get_media` (internal items only for team actors) and
`list_media_posts` (posted only for the public, the whole plan for the team). Team tools behind `sidequest:media`:
`prepare_media_upload`, `add_media`, `update_media`, `publish_media`, `save_media_group`, `save_media_post` (draft, edit,
skip, approve), `record_media_post`, `share_media`, `revoke_media_share` and `delete_media`, each checking the actor's
role. They run in the API Worker, ahead of the production admission check, from MCP and from `/api/<tool>` alike.

**The morning digest.** The indexer's cron sends each team wallet with a linked Telegram chat one message a day, on the
first run between 08:00 and 11:00 in `media.timezone`: today's approved posts, drafts waiting for approval, and what
agents published or approved since the last digest. The outbox id `media-digest:<day>:<wallet>` makes it idempotent. It
is a reminder, never the record.

**Cutover.** The kit's assets, groups, captions and posts are imported through the tools (`sourceUrl` from the kit host,
each file's sha256 checked through a GET afterwards): shown assets become public, hidden ones internal, the four public
briefs become public documents, and `cats-mjav` (not Sidequest) is archived, not imported. media.sidequest.exchange
becomes a redirector: `/` to `/media`, `/f/<id>/<name>` to `/media/f/<id>/<name>`, the film-material files to their
share, `/f/briefs/<name>` to its document, `/crew/landed` still a page, and `/mcp` and `/manifest.json` 410. The kit's MCP,
OAuth and KV retire and the user-level `sidequest-media` MCP is removed.

**Kill switches.** Revoke the connection, stop the agent, unpublish an asset, revoke a share. Removing someone from the
team takes a release, and an issued preview token lives at most two hours after that.

## Consequences

- One sign-in: agents reach media through the Sidequest connection they already have; a coding agent gets the team tools
  by reconnecting and ticking the media opt-in.
- Internal media is never public by URL, unlike the kit's hidden assets. Material for someone outside the team goes out as
  a share, which expires.
- What an agent publishes or approves is a public claim made with its operator's authority. The kit's rules (lead with
  the work, no invented live numbers, keep the "illustrative" and "integration preview" labels) move into the media skill
  and the tool descriptions, and the digest reports what agents published and approved.
- Preview and share URLs are bearer capabilities that can reach a model's transcript; previews last two hours at most,
  shares are revocable and stored as hashes.
- A public file can stay in a browser's cache after an unpublish, because public `?v=` URLs are immutable for a year.
- Uploads through the Worker stop at the zone's 100 MB request limit; larger files come by `sourceUrl` until a presigned
  PUT with a bucket-scoped token is worth adding.
- The release guard learns a reviewed expected create for exactly one R2 bucket; it still refuses every other create.
- Nothing here is live-verified until `docs/reality-check.md` records it.

## Alternatives considered

- **Keep the kit and add a private flag.** Two sign-ins and a public-by-default bucket remain; the manifest serializes
  every writer, and plans still live in briefs.
- **Keep `manifest.json` in R2 as the index.** One object for every write, no query for "approved posts on day X" or
  "variants of batch Y", and history as whole-file snapshots. D1 is already there.
- **A `media/` prefix in the `Manifests` bucket.** No release-guard change, but media would share a bucket with job
  manifests, avatars and samples. Kept as the fallback.
- **Presigned PUT straight to R2 now.** No 100 MB cap, but it needs a bucket-scoped S3 token that can only be minted after
  the bucket exists, two more secrets per stage and CORS on the bucket. Deferred until a file needs it.
- **R2 presigned GETs for internal previews.** Needs the same credential and an R2 origin in Explore's `media-src`; a
  Worker-signed token on the one serving route does the job.
- **Post to the platforms through their APIs.** Paid X access, app reviews elsewhere, and tokens that can post as
  Sidequest; the planner records posts made by hand or by an agent with a browser instead.
- **A third, unlisted level.** It is the kit's "hidden" again, public by URL; shares give the same hand-off with expiry.
- **Keep media.sidequest.exchange as the file host.** A cookie-less origin is safer for HTML, but the kit's sign-in and a
  second Worker stay. The sandbox CSP on every file reply covers the risk.
