# Repeatable Explore measurements

Run from the repository root, with the same installed Chromium executable for both releases:

```bash
bun run --cwd apps/explore perf --sha <deployed-sha> --ci <successful-deploy-run-url> \
  --browser <chromium-executable> --out /tmp/sidequest-before.json
```

The default is **10 cold and 10 warm loads** each of `/jobs`, `/job/84`, `/agent/2036`, and `/services`.
The harness visits routes sequentially and writes each sample immediately. A cold load has a fresh browser context;
a warm load reloads that page in the same context, reusing its HTTP resource cache but recreating React Query memory.
Cloudflare edge caches, API caches, RPC caches, server load and chain state are not reset.

Conditions are Chromium, anonymous, 390 × 844, reduced motion, no CPU or network throttle. Critical-data readiness
requires successful route-specific reads, no pending app/RPC reads, a visible heading, no visible skeleton or error
state, and 500 ms of quiet. Observation lasts at least five seconds and is capped at twenty seconds. Incomplete loads
must be reported separately, never silently dropped. Normalize null readiness or readiness at/above twenty seconds
as incomplete: a browser evaluation can finish after the loop deadline. Preserve raw values. Paint/LCP is a separate metric.
CLS is the largest layout-shift session window (one-second gaps, five-second maximum).

Keep the raw JSON, browser version, date, sample counts, supplied deployed SHA and successful CI URL together.
The asset fingerprints help detect mixed deployments. `/release.json` pins the network/write policy, not a Git SHA;
verify the CI deployment and Worker versions separately. Request receipts contain only sanitized paths, timing,
HTTP status, RPC method names, request IDs and Server-Timing; no credentials, query strings or request/response bodies.
Browser RPC counts cannot count internal Worker-to-RPC calls: use native Cloudflare traces for that breakdown.

Compare median and p75 by route and cold/warm kind, with the same readiness rule and browser. Report incomplete
loads, HTTP/browser errors and pending reads beside latency. Investigate a repeatable readiness regression exceeding
both 10% and 200 ms. This is a controlled lab comparison, not a field Core Web Vitals claim or wallet-flow acceptance.
A separate job-detail observation of at least one polling interval verifies that attributed jobs do not restart
`task_index` or `/data/jobs` reads. Accessibility checks also cover desktop and keyboard navigation.
