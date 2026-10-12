# Performance cleanup status

## 12 October 2026 — implementation complete locally

Owned scope: native Cloudflare/Effect tracing, request/queue/RPC timing,
query/cache identities, preview recovery, targeted invalidation, read-only
Multicall3, public HTTP cache policy, local browser diagnostics and the
architecture explainer. No browser collection endpoint or new CDN layer.

Sequential commits:

- `818d811c` — native Worker trace configuration, 100% initial sampling.
- `8fe15496` — request setup and FIFO queue spans; request ID/Server-Timing.
- `08864cd4` — scoped query identities, targeted invalidation and preview recovery.
- `754e2972` — optional SDK RPC queue/attempt/backoff timing hooks.
- `6dcd4c76` — invocation-local RPC tracing, read-only batching and cache policy.
- `3d4e08ca` — opt-in local browser diagnostics and unused query-export cleanup.

Validation receipts (local; skips are not passes):

| Check | Receipt |
| --- | --- |
| API full workspace, including local Worker bindings | 78 files passed, 2 skipped; 681 tests passed, 17 skipped; `/tmp/sidequest-server-final-tests.log` |
| API unit subset | 71 files passed, 2 skipped; 662 tests passed, 12 skipped; `/tmp/sidequest-api-unit-final.log` |
| Explore | 96 files / 444 passed; `/tmp/sidequest-explore-final-tests.log` |
| SDK | 39 files passed, 4 skipped; 317 tests passed, 33 skipped; `/tmp/sidequest-sdk-tests.log` |
| React | 3 files / 8 passed in the query slice |
| Indexer Worker | 9 passed in the tracing slice |
| Owning types | API, Explore, SDK and dependencies: 7 tasks successful, 1 cached; `/tmp/sidequest-slice-check.log`; React/indexer/root types passed in earlier slices |
| Lint | New source/helpers/tests have no new findings. Full collection found two unused exports, removed in `3d4e08ca`; then no counts above baseline. Board max-lines-per-function baseline reduced by one. `/tmp/sidequest-lint-ratchet-final.log` |
| Documentation | 28 unique HTML IDs, 12 ARIA references and 132 Markdown links checked; inline script parsed; two-file documentation check exited 0 with format/lint/types skipped by existing config |

The lint update briefly included two reductions caused by the concurrently
committed Request-page change; those were removed from this lane's baseline
edit. Raw scoped whole-file lint still reports pre-existing baseline debt. Other
lanes' commits and edits were preserved.

No app browser, live/fork/end-to-end, production deployment or chain acceptance
was performed. An attempted preview of the standalone HTML did not launch
Chromium in the sandbox (`setsockopt: Operation not permitted`); artifact checks
above are the new explainer validation. Earlier explainer/browser receipts in
the review remain historical.

Boundaries and next measurements:

- Verify native trace export, request/DO/subrequest parentage and sampling cost
  after a dev rollout. Installed Alchemy does not expose `redactQueryString`;
  native URL metadata redaction is unproven. Custom attributes omit raw inputs.
- Verify dynamic JSON cache hits and credential separation before adding an
  explicit edge-cache layer. Query invalidation does not purge HTTP caches.
- Capture repeatable cold/warm panel-ready timings before claiming speed gains.
  Resource/Query diagnostics are opt-in, local, bounded to 200 entries and omit
  raw identifiers/URLs/payloads. Request IDs remain available in Network tools.
- Pagination, snapshot redesign, API bootstrap restructuring, duplicate pool
  reads, detail-list simplification and provider changes remain follow-ups.

Read the [implementation guide](../architecture-review.md#implemented-performance-cleanup)
or [HTML explainer](../architecture.html#cleanup-title). The existing preview
server binds only to Tailscale: `http://100.105.51.45:8765/architecture.html#cleanup-title`.

Status: implementation and local owning checks recorded; no claim of deployed
performance improvement. Temporary logs are local receipts, not durable CI artifacts.

### Final shared-checkout gate receipt

`bun --no-env-file run lint:gate` exited 1 after 29 s with **no increases**
and three stale baseline entries: two in `apps/explore/src/routes/Request.tsx`
and one in `packages/board/src/service.ts`. Those reductions come from the
concurrent lanes, whose code and baseline ownership were preserved.
Receipt: `/tmp/sidequest-lint-final-check.log`.

Documentation commit: `e9a7f52a`. The served HTML was fetched over Tailscale and
compared byte-for-byte with the committed file. The runtime implementation
commits are present in the locally observed `origin/dev` history through
`644eea75`; that is Git evidence only, not a CI or deployment receipt.
