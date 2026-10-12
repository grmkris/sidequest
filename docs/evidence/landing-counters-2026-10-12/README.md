# Landing counters: 12 October 2026

Runtime fix: `018a873753f3965fe6e3bf3a449e05f47ab4daf4`.

- [Dev CI 38268794464](https://github.com/grmkris/sidequest/actions/runs/38268794464): verify/build, deploy-dev, smoke and drift passed.
- [Prod CI 38269896440](https://github.com/grmkris/sidequest/actions/runs/38269896440): verify/build, deploy-prod, smoke and drift passed. Kris explicitly authorized both deployments.
- Local scoped format/lint/typecheck passed; Explore 100 files / 458 tests passed. The shared checkout full check stopped on the unrelated untracked `.claude/settings.local.json`; both clean CI checkouts passed the full gate. No unit tests were removed or added.

## Cause and change

The stats-backed section returns null before its async query resolves. The visibility effect ran while its ref was null, then did not rerun when the section mounted. Its `seen` flag kept every number at zero. The effect now depends on the same readiness condition that mounts the section.

## Browser evidence

Fresh anonymous Chromium contexts, 1440x900 with normal motion and 390x900 with reduced motion. Hold the real `/data/stats` response until after the landing mounts, assert the section is absent, release after 750 ms, scroll into view and compare the NumberFlow values with the response. Also navigate to Jobs and use browser Back to check the cached-query remount. Assertions inspect the rendered number component values; the receipts also preserve the visible accessibility snapshots after animation settles.

- `before.json`: both delayed-response cases fail on prod before the release; all four figures remain zero.
- `dev.json`: 4/4 pass at 15:22:46 UTC, no page errors.
- `prod.json`: 4/4 pass at 15:28:23 UTC, no page errors.
- Both deployed checks render 315.00 mUSD, 63 completed jobs and 12 agents. These are the API field values at the recorded times, not an independent payout-accounting audit.

The production "Posted by agents" value still reads 0% after 30 seconds. This comes from separate attribution data: production `/data/directory` returned zero listed agents, and its public `task_index` returned one task with no creatorAgentId. Dev had 15 directory agents and a nonzero percentage. The visibility bug is fixed; network-wide poster attribution and metric definitions were not changed.

The release touched no contracts, backend, wallet state or chain transactions. Later concurrent launch commits advanced dev beyond this receipt; they contain the fix but are outside this verification.
