# Dev performance cleanup: 12 October 2026

Before: `13fb5658`, [CI](https://github.com/grmkris/sidequest/actions/runs/38251508452).
After: `2b62722f`, [CI](https://github.com/grmkris/sidequest/actions/runs/38258765793).
Runtime changes end at `3e4c9df8`; the after SHA adds reviewed launch documentation.

Both datasets use Chromium 153.0.8010.12, ten cold/warm pairs per route, anonymous, 390x844, reduced motion, no throttle. See [method](../../performance-measurements.md) and [HTML report](../../performance-cleanup.html).

| Route | Load | Before median / p75 (s) | After median / p75 (s) | Completed before / after |
| --- | --- | ---: | ---: | --- |
| `/jobs` | cold | 4.33 / 4.98 | 3.63 / 5.24 | 9/10 → 9/10 |
| `/jobs` | warm | 3.23 / 3.54 | 2.71 / 2.96 | 9/10 → 9/10 |
| `/job/84` | cold | 2.41 / 2.75 | 2.32 / 2.45 | 8/10 → 9/10 |
| `/job/84` | warm | 2.06 / 2.80 | 1.99 / 2.37 | 10/10 → 10/10 |
| `/agent/2036` | cold | 3.13 / 5.46 | 2.64 / 2.66 | 9/10 → 8/10 |
| `/agent/2036` | warm | 3.59 / 5.32 | 2.62 / 2.69 | 10/10 → 9/10 |
| `/services` | cold | 2.60 / 3.03 | 1.88 / 1.97 | 10/10 → 10/10 |
| `/services` | warm | 2.07 / 2.34 | 1.77 / 1.85 | 10/10 → 10/10 |

Median and p75 readiness use completed loads. Readiness >=20 seconds is incomplete on both sides; the raw baseline preserves one 20.392-second value from the harness evaluation deadline edge. Summary includes capped readiness (incomplete=20 seconds) for sensitivity analysis. Median averages the middle pair; p75 uses nearest rank.

## Conclusions

- Job-detail requests: median 10 → 8; full-list reads 42 → 0 across its 20 loads. Polling readback also has zero list reads.
- Job-detail CLS: median 0.507 → 0.00012 cold, 0.530 → 0.00007 warm. Readiness only 3.8% / 3.1% faster.
- Job-detail LCP regressed: 1.158 → 1.500 seconds cold; 0.860 → 1.082 seconds warm. The new initial skeleton waits for board metadata before rendering the final content; page readiness and LCP are distinct.
- Overall completed loads: 75/80 → 74/80. No recorded HTTP or page errors, but pending reads and timeout limits remain.
- Agent cold CLS worsened 0.462 → 0.561; warm improved 0.393 → 0.290. Services CLS remains around 0.44. These are still follow-ups.
- Activity and Services had faster medians without a comparable request-count change. Live service/cache/load variation prevents attributing those gains to this patch.
- No per-route completed-load readiness median regressed. The planned >10% and >200 ms readiness-regression threshold therefore did not trigger a rerun. LCP/CLS regressions are explicitly retained above.

## Validation and trace evidence

- Full check/build/clean-tree gate passed on exact candidate `968a49a5` in a detached clean checkout; final review nits `3e4c9df8` passed format, owning types, lint ratchet, Explore tests and build.
- Explore 100 files/458 passed; Board 51 passed files +8 skipped, 473 passed tests +52 skipped; API 78 passed files +2 skipped, 691 passed tests +17 skipped.
- Live browser audit: 8 routes x2 widths, zero axe violations, overflow and page errors; skip/pathname/search keyboard checks passed. One Home desktop sample still had six placeholders at 8 seconds. Audit ran across the docs-only deployment and is functional evidence, not the latency dataset.
- Induced local read failures confirm missing attribution fallback, indexed display during board failure, and stale backing retention. No backend writes or authenticated acceptance.
- `cloudflare-before.json` and `cloudflare-after.json` record Worker versions and 100% logs/traces settings. `trace-example.json` connects an actual get_task request ID to Explore/API/board queue/storage spans. Dedicated RPC attempt coverage remains unverified by that example.
- The interrupted first after run was excluded before analysis because a docs deployment began mid-run. Its temporary receipt remains `/tmp/sidequest-cleanup-after-interrupted.json`; it is not in either dataset.
- One stable asset fingerprint in each final dataset. The baseline already had tracing, Multicall and query scoping; this measures only the later follow-up.

Files contain sanitized public paths/timings and trace IDs, never query strings, auth headers or request/response bodies. No production, wallet, transaction or field Core Web Vitals claim.
