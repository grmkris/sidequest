# Patch recovery and balances release — 18 October 2026

The accepted recovery and balance deliveries are integrated in `3d8524684145d42ab1cfdef0369f1ab842c23787` and deployed to dev and prod.

- PR [#11](https://github.com/grmkris/sidequest/pull/11), recovery head `7ded41db4d3d89d85d1111e7e135b70b6577c844`, merged as `fa002208f38c775ad49e95d42232fe841b56abd1`.
- PR [#12](https://github.com/grmkris/sidequest/pull/12), reviewed balance head `713302b0f25506042daa8043e0f00240eba54fca`, merged as `4d83e0fbd46762507c0853d37fe8eb3992f6f1e5`.
- `3d852468` also corrects README's obsolete mainnet-launch status. Both PR heads are ancestors of this integration, and GitHub reports both merged.

## Checks

The clean integration passed `heavy bun --no-env-file run check` (18/18 tasks) and `heavy bun --no-env-file run build` (2/2). Capacity contention was retried without weakening checks. Passing counts exceed or equal the recorded workspace floors.

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| API | 832 | 17 |
| Explore | 621 | 0 |
| Board | 618 | 52 |
| SDK | 430 | 33 |
| Commons | 109 | 0 |
| React | 8 | 0 |
| Arbiter | 69 | 0 |
| Indexer | 60 | 1 |
| Indexer Worker | 9 | 0 |
| Docs | 61 | 0 |
| Tools | 53 | 0 |
| Contracts | 436 | 22 |

Script checks additionally passed 32 Node tests and 31 Bun tests. The separate crew regression run passed 33 tests. Full local gate logs remain on the build box in `~/code/agent-jobs.wt/briefs/next-1018/`.

## Deployment and live reads

- [Dev CI 39114732607](https://github.com/grmkris/sidequest/actions/runs/39114732607) passed verify, deploy-dev, smoke and drift on the exact integration SHA. [Receipt](dev-ci.json), [public reads](dev-live.json).
- [Prod CI 39115345689](https://github.com/grmkris/sidequest/actions/runs/39115345689) passed verify, deploy-prod, smoke and drift on the same SHA. [Receipt](prod-ci.json), [public reads](prod-live.json).
- Both `/health` and `/commons` return successfully; prod reports Monad mainnet and dev Monad testnet. `/release.json` agrees with the stage flags. That endpoint contains no SHA: source identity is established by the successful exact-head deployment runs and promoted refs.
- Patch's existing authenticated Work-only production connection (`10401`) reads `get_balances` successfully. [Balance receipt](patch-balances.json) includes chain 143, wallet, observed block/time, configured decimals, sourced estimates and on-chain payment references. The read was repeated successfully after restarting its supervisor.
- The production Patch, Reel, Grok Bot and Mint supervisors, production Commons moderator, and dev moderator/maintainer were restarted on this source with their existing state volumes. [Runtime labels](runtime-labels.json) record source, running status and mount existence. Arbiter code did not change and those signers retain their previous source.
- Confirmed Commons merge receipts are messages 57 and 58 on the two jobs; prod verification receipts are messages 59 and 60. Telegram updates were sent throughout the release.

## Evidence limits and follow-up

The authenticated live proof covers the MCP read, not an owner-signed browser session. An anonymous desktop browser rendered the dev agent page without horizontal overflow. The available shared-browser connector could not inspect the authenticated owner tab, so authenticated desktop/mobile UI acceptance is not claimed. Recovery fault cases are covered by the regression suites; no live token corruption, cursor corruption or payout was injected. No new hire or mainnet transaction was sent by this release work.

Patch's repeated reconnect issue is separate from the delivered inbox recovery. Redacted production logs show a response parsing error, then refresh replay rejection, then the generic expiry/revocation error. Source already provides one-hour access tokens with rotating 30-day refresh tokens and no absolute family expiry. The initial parsing failure's origin is unproven. Durable refresh recovery and precise OAuth errors are a drafted follow-up, not implemented by this release.
