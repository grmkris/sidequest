# Production readiness review — 17 October 2026

Status: review and fixes complete; final candidate validation and dev deployment receipt pending below.

This is an internal source, static-analysis, local-runtime and read-only deployment review. It is not an independent
contract audit or blanket certification. No production deployment, production write, mainnet transaction, key rotation
or provider policy change was performed. Production promotion still requires Kris's explicit approval.

## Scope and source

- Production baseline: `8fdbcb06415d404d971bfe1b79ffe446c1136082`, with successful
  [production CI 38798616092](https://github.com/grmkris/sidequest/actions/runs/38798616092).
- Starting dev: `f99c6a968bb1abd0f2193cf7f8a96340f0fd792e`, with successful
  [baseline CI 39014874767](https://github.com/grmkris/sidequest/actions/runs/39014874767).
- Candidate code: `51ed83df` and its ancestor fixes listed below. Later evidence-only commits do not change runtime code.
- Reviewed the production-to-dev Commons delta, request ingress/authentication, hosted operation identity and recovery
  boundaries, dependency graph, contract value/signature paths, release guards, current stage documentation and deployed
  Worker settings. Full source inventory and limits for the three contract review areas are in the linked reports.
- The isolated checkout `/tmp/sidequest-prod-review-check` includes recursive pinned submodules and a frozen install.
  The shared checkout's unrelated ignored `.claude/settings.local.json` and untracked x402 handoff were preserved.

## Changes landed

| Commit | Finding and resulting behavior | Verification |
| :-- | :-- | :-- |
| `f60b0f89` | Ordinary API requests buffered unbounded bodies. Count actual streamed bytes before decoding; reject/cancel overflow with 413. REST/MCP/OAuth: 2 MiB; avatar: 1 MiB; Telegram: 64 KiB after secret validation. Missing/understated Content-Length does not bypass the cap. | Five unit cases and real Workerd chunked-body overflow; 13 stack tests passed, 3 skipped. |
| `d4416918` | Updated AJV and compatible Hono, Node adapter, lodash, sharp, source-map-js, valibot and ws resolutions. | Advisory scan fell from 53 entries across 11 packages to 3 entries, with no High entries remaining; full gate/build below. |
| `a1524f3e`, `44e2bdc0`, `7b2b42c6` | Backported the fixed UTF-8 decoder into the legacy wallet dependency while retaining CommonJS and plus-to-space behavior. Explicitly declared the tested dependency. | Compatibility cases and a 120 KB malformed percent run in a child process with a 5-second timeout; full lint ratchet passed. |
| `46eea5f2` | A host acknowledgement could clear choices appended while sending. Clear only the submitted draft snapshot and retain newly appended text. | Three unit cases and real Chromium/official AppBridge delayed-host checks at 1440px and 390px; [receipt](draft-browser.json). |
| `e67354b9` | Current docs incorrectly described production as testnet. Aligned stage, funding, clock and retained inert-binding guidance with mainnet; preserved dated historical records and regenerated MCP docs. | 61 docs tests and owned format/agents checks. |
| `4b689a74` | Corrected NatSpec's retired 15-day Holding delay and omitted fee rounding/cap. Runtime behavior and storage are unchanged. | 53 StakeVault/FeeSchedule tests passed. |
| `51ed83df` | Parallel Foundry suites raced on process-global `MAINNET_GO` / `NETWORK` fixtures. Serialize the full Forge suite without removing assertions or changing the production guard. | Parallel guard suites reproduced failures; serial full suite passed 436 tests, 22 skipped. |

## Dependencies

[Before](dependency-audit.json), [after compatible updates](dependency-audit-after.json) and
[final](dependency-audit-final.json) are raw version-based advisory reports. `bun audit` still exits 1; the review does
not suppress or relabel that result.

| Remaining alert | Disposition | Follow-up |
| :-- | :-- | :-- |
| `decode-uri-component` / GHSA-vcc3-ghjq-m6fr, Moderate | Fixed by the committed Bun patch, backported from 0.5.0. The audit sees version 0.2.2 and cannot account for the patch. Old `query-string` under WalletConnect needs the legacy CommonJS/plus contract. | Remove the patch once the upstream wallet tree supports a fixed compatible release. [Patch provenance](../../../patches/README.md). |
| `katex` / GHSA-238p-pmpm-9mq7, Low | Transitive Mermaid dependency. The advisory requires existing prototype pollution; Commons accepts only a restricted flowchart grammar that excludes `$`, HTML, configuration and actions, with strict Mermaid settings. No affected product math input path was established. | Upgrade Mermaid/KaTeX compatibly; revisit before expanding math or diagram syntax. |
| `uuid` / GHSA-w5hq-g745-h8pq, Moderate | Versions 8/9 remain under wallet SDKs. The issue concerns v3/v5/v6 with caller-supplied buffers. First-party code has no UUID imports; no affected caller was identified in this review. This is limited reachability evidence, not proof that every upstream branch is unreachable. | Move legacy wallet consumers to supported UUID versions and recheck compatibility; retain as an open dependency follow-up. |

The full lint ratchet retains its existing 2,802 findings in 364 files; passing it means no regression, not a clean
zero-debt codebase. Knip produced no findings on the repaired candidate.

## Contract review

No new unprivileged Critical, High or Medium exploit was established. The following reports preserve the exact
scope, evidence and limitations:

- [General and precision math](findings-general-math.md): full-precision fee/share math, donation resistance, bounded
  accounting, callback state ordering, payout returndata budgets, compiler applicability and Slither triage.
- [Tokens and staking](findings-tokens-staking.md): exact inflows, queued-share exposure, reservation isolation,
  generation reset after complete slashes, fee caps and permissionless-token boundaries. Its stale NatSpec observation
  was corrected in `4b689a74`; old descriptive test names remain.
- [Signatures, authority and DoS](findings-auth-dos.md): EIP-712 domains/nonces, ERC-1271, role boundaries, payout
  deferral and six additional isolated probes.

Fresh Slither 0.11.6 analyzed 79 contracts with 102 detectors and emitted 264 results: 5 High, 37 Medium, 58 Low and
164 Informational. All High/Medium results were triaged; none established a new unprivileged exploit. This is a
successful scan **with findings**, not a clean scanner pass. [Summary and raw-output hash](slither-summary.json).
The 9.8 MB raw JSON is retained at the local path in that receipt; the committed general report contains dispositions.

Fresh staking/token validation passed 226 tests in 12 suites, including 512-run fuzz cases and 64 invariant runs with
2,048 calls per run; [log](tokens-staking-forge.log). The additional auth/DoS probes passed 6/6; [log](auth-dos-probe.log),
[source](AuthDosProbe.t.sol). To reproduce those probes, copy the source into `contracts/test/sidequest/` in an isolated
checkout of the reviewed source and run `heavy forge test --match-contract AuthDosProbe` from `contracts/`.

### Existing production constraints

1. **Pause history is operationally critical (Medium).** Both pause and unpause must atomically include evaluator
   `notePause`. Omitting the start can incorrectly slash a worker; omitting the end can incorrectly excuse a later
   deadline. `/admin` builds the pair, but the contracts do not enforce Safe callers using that UI. Keep the
   [incident procedure](../../mainnet-runbook.md#5-if-something-goes-wrong) and check paired events. Alert delivery was
   not live-tested by this review.
2. **Pauses consume unfilled cancellation grace (existing R2, Medium).** A pause can prevent a timely cancellation;
   after unpause the creator can incur the snapshotted 25% forfeiture. The current immutable Holding needs a future
   version to change this behavior. It is not repaired by the hosted release.
3. **Treasury misconfiguration (existing R7, Low).** The Safe can schedule Holding itself as treasury, blocking the
   unfilled-forfeit settlement until a timelocked repair. Current mainnet config uses the Safe; retain the live
   treasury check before any schedule change.
4. **Concentrated authority.** The Safe can pause/upgrade the core and withdraw escrow while paused. On 17 October,
   the artifact's 1-of-1 policy is consistent with the published launch policy. The published 2-of-3 transition is due
   by 20 October, with all three keys still founder-held; it needs separately authorized transactions and refreshed
   artifact/live readback. This is not independent multi-party governance.
5. **Arbitrary reward tokens.** Rebases, blacklisting or dishonest token behavior can strand that token's jobs or
   impair token-local liabilities. This remains the explicit ADR-0010 boundary.

## Live production readback

- Public production smoke and structural artifact check passed: [smoke](prod-smoke.log),
  [structural preflight](preflight-structural.log), [release probe](preflight-probe.log). The release is Monad mainnet
  with `mainnetLive: true` and admissions open. These checks are anonymous and do not prove signed execution.
- The live launch gate's only returned failure was `launch:AA PIMLICO_API_KEY missing` in the local operator
  environment; [receipt](preflight-live.log). The configured RPC was explicitly mapped from `MONAD_RPC_URL_MAINNET`
  to the gate's `MONAD_MAINNET_RPC_URL`; no secret values were recorded. Safe policy, contract roles/wiring, clocks,
  code presence and arbitrator reserve checks returned no failures. **The complete live gate did not pass.**
- Deployed `/aa/rpc` returned chain 143, the configured EntryPoint and a USDC quote from the configured paymaster;
  [receipt](prod-aa-public.json). The deployed API has the Pimlico secret binding. This is read-path evidence, not a
  signed UserOperation, Privy policy acceptance or recovery rehearsal.
- [Worker settings and active deployments](prod-workers.json) confirm production versions, persisted logs/traces and
  100% sampling. Query-string redaction is currently disabled. Review OAuth/query privacy and sampling cost before
  broader traffic; this review did not modify production logging.

## Acceptance boundaries and promotion procedure

The reviewed source is a release candidate once the validation/deployment receipts below pass. The following remain
explicit boundaries rather than implied green checks:

- Run the complete live launch gate in the authorized release environment with its Pimlico credential before
  promotion. Do not copy or print production secrets to satisfy a local check.
- Retain acceptance of the documented pause/admin/token risks. Contract policy fixes require their own reviewed
  deployment and approval; this release does not silently change economic behavior.
- Perform signed mainnet, provider-policy, third-party MCP App host and remote D1/DO recovery acceptance only under
  their authorized workflows. Local Workerd recovery and fixture hosts do not establish those facts. The fresh [disposable SQLite drill](p0-drills.log) restored/rebuilt 24 synthetic events and retained hosted rows; it did not touch remote D1 or production state.
- Owner alerts remain a prepared adapter, not demonstrated production monitoring: no running collector/scheduler,
  durable incident lifecycle or confirmed owner phone receipt is established. Complete the
  [owner-alert workflow](../../p0-owner-alerts.md) before relying on unattended incident response. Sending the controlled
  owner notification requires its explicit authorization; no message was sent in this review.
- For the hosted promotion, review the full `origin/prod..candidate` diff, green exact-source CI and release plan.
  Commons adds nullable `presentation_json`; keep migrations additive. Old application versions may ignore retained
  attachments; never delete the data to roll back code.
- After explicit approval, use the existing guarded `prod` promotion workflow, its live launch gate, smoke and drift.
  Record the accepted SHA and active Worker versions. No mainnet transaction is required for this hosted UI/API change.
- If rollback is needed, follow the runbook's reviewed same-Worker version rollback after checking current bindings
  and schema compatibility. An old whole-stack deploy must not delete storage, DO namespaces or bindings. A Worker
  rollback does not reverse schema/state changes.

## Final validation and dev release

The following workspace floors were recorded by the clean candidate gate (passing tests only; live/optional suites
remain skipped). The final aggregate gate, contracts, build and docs HTTP result all passed; full receipts are retained below.

| Workspace | Passed | Skipped |
| :-- | --: | --: |
| API (90 passed files, 2 skipped files) | 818 | 17 |
| Explore (123 files) | 605 | 0 |
| Docs (8 files) | 61 | 0 |
| SDK | 425 | 33 |
| Board | 618 | 52 |
| Commons | 109 | 0 |
| React | 8 | 0 |
| Arbiter | 56 | 0 |
| Indexer library | 60 | 1 |
| Indexer Worker | 9 | 0 |
| Tools | 53 | 0 |
| Contracts (43 suites) | 436 | 22 |

The contract command also passed 27 offline launch-kit Python tests. The guard test's initial failure was isolated:
parallel Recipe/Safe tests can overwrite each other's global approval/network fixtures; [parallel reproduction](guard-parallel.log)
and [serial full-suite result](guard-serial-full.log). The workspace now uses one Forge thread; no assertion, test or
mainnet approval check was removed.

These are unit/local-runtime results, not authenticated production acceptance. The final clean gate completed 18/18 tasks in 1m04s; the final build completed 2/2 tasks in 14s; the docs Worker smoke passed 174 HTTP checks across 32 parsed responses. Full receipts: [check](final-check.log), [build](final-build.log), [docs smoke](final-docs-smoke.log). Earlier failed setup attempts (missing isolated submodules, then the new regression test's declared
dependency/promises and manifest ordering) were corrected without weakening gates.
