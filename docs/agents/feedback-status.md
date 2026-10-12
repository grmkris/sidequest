# Commons feedback implementation

Append-only coordination and evidence for the 12 October 2026 feedback work. Implementation stays on `dev` in the
shared checkout. Claude (tern 2.0) is the release orchestrator and owns all dev/prod pushes. Codex commits green
Commons feedback slices for review; other agents retain ownership of their edits.

## 12 October: start

- Baseline: `d0f3df63`, clean checkout, four commits ahead of `origin/dev`. The summary fix is already committed;
  the three preceding RPC/doc commits must pass the release gates with the candidate.
- Owned work: Commons UI/types/queries/routes and their tests; targeted API/Board/SDK read, notification and error
  fixes and their tests; Commons validation/roadmap documentation; this log and the final reality-check entry.
- Shared files needing sequential handoff: Explore `main.tsx`, API `tools.ts`/`mcp-policy.ts`/`board.ts`, Board
  `service.ts`, SDK board types, generated docs/skills, workspace test floors, and `docs/reality-check.md`.
  Check Git state before editing and committing; preserve foreign hunks. A conflicting ownership claim pauses only
  that file. No broad staging, stash, reset, restore, clean or branch changes.
- Public states remain `open`, `fixed`, `wontfix`. Audit outcomes below are evidence categories, not database states.
- Deferred by Kris: hosted MCP faucet (document operator top-up), generic HTTPS Git verification (clarify advisory
  limits). Keep these capabilities open. No production changes or new economic dev transactions.
- Live role acceptance uses existing authorized sessions and isolated labeled feedback fixtures if available;
  otherwise record the missing authenticated evidence. Never read credential files or generate role keys.
- Release: validate an exact committed candidate separately from shared live edits; normal dev push, guarded CI
  verify/deploy/smoke/drift, deployed UI/readback, then an evidence commit. Closure trailers follow live acceptance.

Initial audit set (refresh status and reproduce before claiming a resolution):

| Gaps | Initial source finding | Outcome |
| :-- | :-- | :-- |
| 13–14 | Missing direct quote-request read; quotes-closed state labeled expired | To reproduce/fix |
| 15 | Faucet is REST-only for hosted zero-balance agents | Deferred; document limitation |
| 16 | Arbitrary Git hosts accepted, advisory verifier supports four hosts | Deferred; clarify limits |
| 17 | Dispute bundle exists, hosted MCP read discovery lacks it | To verify/fix |
| 18 | Full task scan enriches every row | Add compact read; measure |
| 19 | Current schema accepts numeric/string gap IDs; error is generic | Transport regression and safe field errors |
| 20 | `mine` means supported; shipped/declined items release support slots | Clarify unchanged semantics |
| 21 | GitHub token access/rate failures are inconclusive checks | Reproduce and bound fallback |
| 22 | Generic read failure tells callers to reuse a nonexistent operation key | Fix read retry guidance |
| 23 | Recent code moves picked notices onto publication confirmation | Audit remaining selection guidance |
| 24 | Job route accepts numeric IDs only; some event links carry task IDs | Resolve aliases and canonical links |

## 12 October: browsing and role controls

- Browsing committed in `147834b4`: `/commons/gaps/<id>` reads every report body, attempted workaround and suggestion,
  preserves multiline text and original gap IDs after merges, follows canonical merged IDs, and links roadmap items.
  Gaps have shareable status/type/tool filters and cursor pagination. Captured public dev gap #6 supplies the renderer
  contract fixture (three reports; no private goal). Scoped format/lint/typecheck passed; Explore 93 files / 435 passed.
- Public Commons reads use a separate session-free client whenever the viewer is not signed in. Sign-out or wallet
  change cancels/removes the previous viewer's Commons cache, including unfinished reads. Regression checks prove no
  bearer header on anonymous reads and no restoration of privileged text by a late request.
- Role-control slice: status/link/merge forms for maintainers and hide/restore forms for moderators and maintainers.
  Controls require the server's matching current viewer, public reasons use 3–500 Unicode code points, merge review
  names source/target IDs and counts, and all mutations display pending/success/failure. Role log paginates and links
  gap/roadmap targets. Scoped format/lint/typecheck passed; Explore 94 files / 439 passed.
- Live acceptance is still pending. These are local UI/domain regression claims, not deployed or authenticated-host
  proof. Foreign observability, query-key and Board edits were preserved and excluded from staging.

## 12 October: implementation closeout before dev release

- Gaps 13–14 are fixed in `f9dd48f7`: `get_quote_request` reads durable open, closed and picked requests, and the
  UI distinguishes a closed request from a delivery-expired hire. Board coverage includes old request URLs and the
  MCP read contract.
- Gap 17 is fixed in `2b57f327`: `get_dispute_bundle` is discoverable and callable under hosted MCP read scope, with
  a policy regression proving the scope boundary.
- Gap 18 is fixed in `fa592349`: `list_tasks {compact:true}` returns lightweight task fields without chain
  enrichment; `task_index {compact:true}` remains the cursor scan. Transport and output fixtures cover both shapes.
- Gap 19 is fixed in `af3fec4d`: numeric and string gap IDs remain accepted, while invalid fields and constraints are
  named without echoing submitted report text.
- Gap 22 is fixed in `871377a2`: failed reads say to retry the same arguments; write failures retain same-key
  reconciliation guidance. MCP transport and agent-failure regressions cover the distinction.
- Gap 24 is fixed in `d9325a99`: old `/job/<taskId>` notices resolve through `get_task`, draft
  tasks go to the board-scoped account resume flow, and published tasks redirect to canonical numeric job URLs.
  Feed regressions cover public and tenant boards, including unpublished and published notices.
- Gap 20 is clarified in the Commons docs: `mine` means the current viewer supports an item; shipped and declined
  items release active support slots. Gap 15 remains deferred because hosted MCP has no faucet tool; the app now
  directs operators to fund the managed wallet. Gap 16 remains deferred because arbitrary Git hosts are accepted but
  advisory commit verification supports only GitHub, GitLab, Codeberg and Gitea; unsupported hosts stay unverified.
  GitHub token acquisition is time-bounded in `1cec7ae1`; token failure falls back to the public commit API.
- Gap 21 remains an advisory boundary: GitHub 404/422 report missing-or-private commits; rate/access failures yield
  an inconclusive check. Existing regressions prove anonymous fallback on token failure and `ok:null` on rate limits;
  approvers still inspect the submitted descriptor and criteria.
- Gaps 23 and 24 are now aligned: picked notices are emitted after publication confirmation, and every notice carries
  a canonical route or a resumable draft link. Local evidence is complete; deployed and authenticated acceptance is
  recorded only after the dev release and live readback.

The adjacent lane also committed the selection wording fix in `39cfbe50` and the closed-request hiring dashboard
continuation in `32b2c5f4`. Their committed changes join the exact candidate; their unrelated live edits are preserved.

Local receipts before release: Explore 96 files / 444 tests passed; API feed-board 10 tests passed; Board deliverable
21 tests passed; Docs 8 files / 58 tests passed; Explore and API owning typechecks passed. The repository lint ratchet
was reduced by three stale entries in `f58f6a7b`; raw scoped lint still reports pre-existing findings in large files.

## 12 October: accepted dev release and live browsing

- Frozen candidate `7d3529d7` passed the full check and build in an isolated worktree; CI
  [38241771092](https://github.com/grmkris/sidequest/actions/runs/38241771092) passed verify, dev deploy, smoke and drift.
  Later shared edits were preserved. Production was skipped.
- Live browser acceptance at 11:26 UTC proved gap #6's three complete report bodies at desktop/mobile widths,
  gap-list navigation, canonical merged-gap navigation, published/draft legacy task links, and the historical
  gap #14 request's durable picked read. Public MCP metadata/docs and anonymous authentication refusal passed.
- Final accepted floors: API 78 files passed / 2 skipped, 687 tests passed / 17 skipped; Explore 97 files /
  447 tests passed; Board 50 files passed / 8 skipped, 470 tests passed / 52 skipped; Docs 8 files / 58 tests passed.
  Lint ratchet: 2,906 baseline findings, no increase. Local docs smoke: 159 HTTP checks / 29 parsed HTML responses.
- Status: deployed and anonymous browsing acceptance complete. Authenticated role mutations/private visibility and
  hosted MCP discovery/access remain pending because no authorized session was available. No live closure/status
  changes were applied to agent-reported gaps. Gaps 15 and 16 remain deferred, and the advisory GitHub check retains
  its documented access/missing/private boundaries.
- Dated live evidence and exact scope: [reality check](../reality-check.md#12-october-2026--commons-feedback-contents-and-durable-links-on-dev)
  and [sanitized receipt](../evidence/commons-feedback/2026-10-12-dev.json).

## 12 October, 11:56 UTC: release ownership and file handoff

- Kris's new assignment supersedes the original release ownership: Claude (tern 2.0) runs the full check on the exact
  committed release tree and owns all pushes. Codex will not push `dev` or `prod` or initiate deployments.
- Inspected shared `dev` at `0436875c`: the checkout and index were clean, including `apps/api/src/feed-board.ts`.
  Codex's canonical feed-link slice is already committed in `d9325a99`; Claude's publish-only notice guard is already
  committed in `21dc9f0c`. No uncommitted feed slice remains to hand off, and `871377a2` is present in this history.
- Handed off `apps/api/src/feed-board.ts`, `apps/api/src/mcp-hiring.ts`, `apps/explore/src/routes/Request.tsx`, Commons
  gap-list polling, `V1Panels.tsx` and `Collect.tsx` to the orchestrator. Codex will not edit these without a new handoff.
- Commons implementation and committed evidence are ready for review. This entry changes coordination only; it makes
  no new release or authenticated acceptance claim. Validation: instruction checks and the documentation diff check.
