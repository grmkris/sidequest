# Spike: preserve Chromium's HTTP cache in Explore's approval tests

24 October 2026. Local fixture evidence only. Base: `091403c70f52cae8dda935487c4ccf3875013c3c`
(the initial `origin/dev` and spike branch HEAD, measured before editing tracked files).

The approval browser harness now serves assets over loopback HTTP and mocks API fetches with an init script.
Warm navigations reuse both script/style resources instead of transferring them again. Existing network-level fault
injection and safety routes stay in place. This changes test infrastructure only.

## Problem and source evidence

Playwright documents that [enabling routing disables HTTP cache](https://playwright.dev/docs/api/class-page#page-route).
[Issue 22865](https://github.com/microsoft/playwright/issues/22865) describes the Chromium consequence. The installed
`playwright-core@1.63.0` implementation in `lib/coreBundle.js` sends `Network.setCacheDisabled` and enables Fetch
interception with `urlPattern: "*"` when routing is enabled, even for an API-only pattern. Narrowing a route glob cannot
restore asset caching.

The initial route inventory was collected with:

```sh
rg -n '\.(route|routeFromHAR)\(' apps packages --glob '*.{ts,tsx,mjs}'
rg -n 'goto\(|reload\(' apps/explore/test packages/sdk/scripts/live/deployed apps/explore/scripts
```

The following table describes base behavior. Navigation counts are source observations, not live-stage measurements.
"None" means the fixture server sets no cache-control, validator or expiry header. Deployed headers were not fetched.

| File / purpose                                                                                           | Routes                                                                    | Navigations per context                                                          | Server cache headers                                      | Benefit and decision                                                                                                                                                              |
| :------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/explore/test/approval-browser.ts`: serve the built approval UI and block external requests         | `**/*`, fulfill HTML/JS/CSS; abort other hosts                            | Usually one; the rejected/missing-link case has two                              | No HTTP server; fulfilled responses have no cache headers | Convert to ephemeral loopback HTTP; hashed assets cacheable, HTML no-store; CSP restricts subresources to self.                                                                   |
| `apps/explore/test/approval-fixture.ts`: mutable approvals API, delayed reads/decisions and lost replies | `**/api/**`, fulfill JSON or abort a lost reply                           | Same approval contexts                                                           | No cache headers on fulfilled JSON                        | Convert to shared typed in-page fetch mock; leaving this route would still disable the asset cache.                                                                               |
| `apps/explore/test/commons-authoring.test.ts`: missing lazy plan-editor chunk                            | `**/AttachmentEditor-*.js`, fulfill 404                                   | One top-level navigation in that test                                            | Local HTTP, none                                          | Keep: dynamic module import needs a network-level failure; no warm navigation to benefit. Inline reason added.                                                                    |
| `apps/explore/test/hiring-handoff.test.ts`: real UI with bundled auth/transport fixtures                 | None                                                                      | Usually one; draft persistence visits four URLs, storage-recovery cases two      | Local HTTP, none                                          | Already avoids routing; leave unchanged.                                                                                                                                          |
| `packages/sdk/scripts/live/deployed/browser.ts`: read-only browser guard                                 | `**/*` only in `start(true)`; permit reads and abort writes/unknown POSTs | The read-only `smoke.ts` caller navigates once; other callers use `start(false)` | Deployed headers unmeasured                               | Keep: write blocking must cover native network requests; the singleton smoke has no warm-navigation cache opportunity. Inline reason documents why native network blocking stays. |
| `packages/sdk/scripts/live/deployed/outage.ts`: revoke fault injection                                   | `**/api/**`, abort revoke, continue reads                                 | Shared acceptance context; this case navigates then reloads after unroute        | Deployed headers unmeasured                               | Keep: deliberately abort the real revoke request, with no replacement response; inline reason and function comment explain the boundary.                                          |
| `apps/explore/scripts/tokens.ts`: rasterize untrusted logos                                              | Context `**/*`, abort all                                                 | Fresh page per image, `setContent`; no HTTP navigation                           | In-page data URLs                                         | Keep: every page must make no network request; inline reason states that requirement. No cache reuse to gain. Script not run.                                                     |

No deployed probe was run or refactored: the routed read-only caller has no repeated navigation, and replacing its
network guard with an in-page mock would weaken what it covers. Its origin guard accepts only dev/prod; this spike does
not add a bypass. No token generator, cloud API, deployment, fork or paid provider was invoked.

## What changed

- The approval UI is built as before, served on `127.0.0.1` with an OS-assigned port, and closed with Chromium. Hashed
  assets get `Cache-Control: public, max-age=3600, immutable`; HTML gets `no-store`. The local CSP blocks other-origin
  connections without registering any route. Unknown paths return 404.
- [The shared test helper](apps/explore/test/init-script-mock.ts) installs before application scripts and survives
  navigation. It intercepts only same-origin `/api/` fetches. Requests carry method, headers and body to the existing
  mutable Node fixture; replies become native `Response` objects. AbortSignal and rejected fetch behavior are preserved
  for the tested API use cases. API fixture calls still cross the Playwright binding; asset requests no longer do.
- Existing approval UI tests continue exercising reads, signing phases, polling, delayed decisions, errors and lost
  replies. New regressions verify warm cache reuse with fresh API state, the CSP boundary, first-script installation,
  Request overrides, Response APIs, real asset pass-through, aborts, HTTP/network failures and page isolation.
- `test:cache` exposes a local-only benchmark. Its `--routed` control registers an unused API route against the same
  HTTP server to distinguish the route effect from the server/cache-header change.

This is a reversible test-fixture change; no product architecture or protocol decision is adopted by this spike.

## Measurements and reproduction

The original browser subset was run three times on the unmodified base in this worktree; no stash or second checkout
was needed. Python `time.perf_counter()` measured each subprocess's complete wall time, including `heavy`, Vite builds,
Chromium startup and tests. Contention exits (75) were retried unchanged and excluded from successful run times.

```sh
heavy bun --no-env-file run --cwd apps/explore test test/approval-context.test.ts test/hiring-handoff.test.ts test/commons-authoring.test.ts
```

| Browser subset  |    Run 1 |    Run 2 |    Run 3 | Median wall time | Test results per run           |
| :-------------- | -------: | -------: | -------: | ---------------: | :----------------------------- |
| Unmodified base | 43.444 s | 45.041 s | 42.530 s |         43.444 s | 42 passed, 0 failed, 0 skipped |
| Changed harness | 38.161 s | 36.508 s | 37.556 s |         37.556 s | 44 passed, 0 failed, 0 skipped |

The suite ran on a shared host, and two regressions were added, so these timings are a sample rather than an isolated
causal estimate or CI speed guarantee. The repeat-navigation asset counts provide the stronger evidence.

Cache probes use three fresh contexts, three navigations each, the same approval UI, and readiness at visible
`karl-v1`. Chromium CDP counts only Script/Stylesheet resources; cache hits come from `requestServedFromCache` or
`response.fromDiskCache`, and encoded bytes from `loadingFinished.encodedDataLength`. Warm means navigation two or
three, giving six warm samples per arm. No `Network.setCacheDisabled(false)` override is used. Browser:
Chromium `153.0.8010.12`; Playwright `1.63.0`.

| Probe                           | Command actually run                                                  | Cold median | Warm median | Warm cache hits | Encoded asset bytes per warm navigation |
| :------------------------------ | :-------------------------------------------------------------------- | ----------: | ----------: | --------------: | --------------------------------------: |
| Base route fulfill              | `heavy bun --no-env-file report/cache-spike/measure.ts`               |    548.8 ms |   259.70 ms |            0/12 |                               2,205,859 |
| First converted sample          | `heavy bun --no-env-file apps/explore/test/cache-measure.ts`          |    386.8 ms |   137.45 ms |           12/12 |                                       0 |
| Same-server route control       | `heavy bun --no-env-file apps/explore/test/cache-measure.ts --routed` |    420.2 ms |   225.75 ms |            0/12 |                               2,206,377 |
| Final helper via package script | `heavy bun --no-env-file run --cwd apps/explore test:cache`           |    420.8 ms |   129.60 ms |           12/12 |                                       0 |
| Final same-server route control | `heavy bun --no-env-file run --cwd apps/explore test:cache --routed`  |    341.7 ms |   182.20 ms |            0/12 |                               2,207,943 |

Small cold-byte differences across builds include HTTP headers and fixture build output; warm transfer elimination is
the supported claim. Only the multi-navigation approval flow benefits from cache reuse; isolated single-navigation
tests cannot reuse assets from another context.

Run the two local arms with:

```sh
heavy bun --no-env-file run --cwd apps/explore test:cache
heavy bun --no-env-file run --cwd apps/explore test:cache --routed
```

For base reproduction, copy the current `test/cache-measure.ts` into the base's Explore `test/` directory: it accepts
both the old `{ browser, serve }` and new `{ browser, origin, close }` fixture APIs. The exact original temporary
probe source is preserved as [baseline-measure.ts.txt](docs/evidence/cache-spike-2026-10-24/baseline-measure.ts.txt);
its imports are relative to its original `report/cache-spike/measure.ts` location.

Raw probe rows and subprocess timing receipts are in [the evidence directory](docs/evidence/cache-spike-2026-10-24/).

## Gates

All commands below are local. `--no-env-file` prevents automatic env-file loading; the checkout has only the tracked
example env file. RPC/live-preview variables were removed and Turbo remote caching disabled for repository gates:

```sh
env -u MONAD_TESTNET_RPC_URL -u MONAD_MAINNET_RPC_URL -u HYPERSYNC_API_TOKEN -u SIDEQUEST_LIVE_PREVIEW TURBO_CACHE=local:rw <command>
```

| Command (with the prefix above where relevant)                                                                                                                                                                                                                                                                                                                              | Result                                                                                                      |
| :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| `bun --no-env-file run check:files apps/explore/AGENTS.md apps/explore/package.json apps/explore/test/approval-browser.ts apps/explore/test/approval-context.test.ts apps/explore/test/approval-fixture.ts apps/explore/test/cache-measure.ts apps/explore/test/commons-authoring.test.ts apps/explore/test/init-script-mock.ts apps/explore/test/init-script-mock.test.ts` | PASS: format, lint, Explore typecheck, graph and agents                                                     |
| `heavy bun --no-env-file run --cwd apps/explore test`                                                                                                                                                                                                                                                                                                                       | PASS: 134 files, 689 tests; 0 failed, 0 skipped                                                             |
| Browser subset command above, repeated three times before and after                                                                                                                                                                                                                                                                                                         | PASS: all runs; base 42 tests, changed 44 tests                                                             |
| `heavy bun --no-env-file run check`                                                                                                                                                                                                                                                                                                                                         | PASS: exit 0; all standard stages completed, 18 Turbo test/dependency tasks successful (8 local cache hits) |

The recorded Explore floor moves from 133 files / 684 passing to 134 files / 689 passing. An early implementation
typecheck caught an optional-header type error, and scoped lint caught fixture scoping/complexity issues; those were
fixed. Lint rules and baselines were not weakened. Shared capacity waits are recorded separately from failed tests.

The first standard check stopped before tests because the fresh worktree's contract submodules were uninitialized:
Knip reported `contracts/lib/** ... Remove from ignore`. `git submodule status` showed the pinned submodules with `-`
prefixes. `heavy git submodule update --init --recursive` initialized those existing pins inside this worktree; it did
not change any tracked dependency reference or lint configuration. The standard check was then retried unchanged. A later attempt exhausted the lint collector's capacity retries (`oxlint exited 75`), and the unchanged command was retried until it completed with exit 0. An intermediate draft-report formatting failure was fixed with oxfmt before the successful run.

The successful full gate ran against source HEAD `b7c4983e` (implementation `7c388657`, retained-route reasons
`821e80da`). Explore ran fresh: 134 files / 689 passed / 0 skipped. SDK ran fresh: 54 files passed, 4 files skipped /
430 tests passed, 33 skipped. The standard test graph succeeded on 18 tasks; 8 were local cache hits, including unchanged
contract/tool tests and dependency typechecks. These cached results are not fresh executions. Script checks executed
36 Node tests and 77 Bun tests, with 0 failures. [The gate receipt](docs/evidence/cache-spike-2026-10-24/check.json) and
[selected original gate output](docs/evidence/cache-spike-2026-10-24/gates.log) record the command, exit status and counts.

## Risks, open questions and rollout needs

- This helper models the fetch calls used by Explore's approval API. It does not intercept XHR, workers, WebSocket,
  navigation, resource loads or the native module loader. Mock Responses do not simulate every network property,
  streaming, cookies or CORS. Keep real transport coverage for those behaviors.
- Aborting the browser fetch does not cancel a Node fixture operation already started; late fixture completion is
  contained and the existing operation/receipt tests still pass. This is deliberate, matching uncertain outcomes.
- CSP restricts the local document's subresources. It is not a replacement for the deployed probe's comprehensive
  network write guard, nor a general defense against a test deliberately navigating away from the fixture origin.
- Warm memory-cache evidence on local loopback is not a deployed CDN, persistent disk-cache or production acceptance
  result. Most existing tests open fresh contexts, limiting overall savings.
- Before adopting beyond this spike: review the fixture semantics, repeat in CI's Chromium/shared-runner conditions,
  retain cache/header regressions, and measure any proposed additional multi-navigation harness independently.
  Production code and cache headers are unchanged; any future production rollout would need separate authorization
  and stage-specific evidence. No deployment is needed for this test-only change.

The separate comment-only route inventory (`apps/explore/scripts/tokens.ts` and two SDK scripts) was checked with `bun run check:files --lint-only`; formatting passed, while oxlint reported pre-existing baseline findings in those files (type assertions, runtime checks, and complexity). No new disable or baseline entry was added. The findings match the recorded per-file baseline exactly, as recorded in [comment-lint-baseline.json](docs/evidence/cache-spike-2026-10-24/comment-lint-baseline.json). The repository-wide `lint:gate` passed with no changes to its baseline (2,782 findings in 364 files, Knip 0).
