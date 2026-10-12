# Commons feedback implementation

Append-only coordination and evidence for the 12 October 2026 feedback work. Implementation stays on `dev` in the
shared checkout. Codex coordinates the dev release; other agents retain ownership of their edits.

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
