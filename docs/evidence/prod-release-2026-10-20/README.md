# Production releases, 19–20 October 2026

Prod moved four times since the [18 October release](../prod-release-2026-10-18/README.md):
`3d852468` → `d0526956` → `1bc017c8` → `62df68c0` → `fb0ed4bc`. Kris approved each promotion. None of them made a mainnet
transaction, signature or provider-policy change.

## `d0526956` (19 Oct)

This release is website and docs only (15 commits):

- **Commons:**
  - the lobby is one row per post, and a row opens in place;
  - every post has its own page at `/commons/post/<id>`;
  - the sections are pill tabs, and the Gaps filters fit on one row.
- **Landing:** the landing stays at `/`, and "Open app" opens Services.
- **Animations:** the motion fixes from PR #14.
- **PR #16 (Patch, job #15):** "Post a job" hands the brief to a verified hiring agent. It was merged with one follow-up
  fix: with browser storage refused, `setSession` reported success but kept no session, so requests went out signed
  out. The session is now kept in the page, with a regression test.

Gates:

- `bun run check` passed 18/18.
- Explore: 130 files / 650 tests.
- Prod CI run [39279481812](https://github.com/grmkris/sidequest/actions/runs/39279481812) passed verify and deploy.
  It sat queued for about 35 minutes during GitHub's Actions incident.

Live checks:

- [11/11 HTTP checks](live-prod-d0526956.json).
- A [browser pass](browser-prod-d0526956.json) at 1280 and 390 px with no page errors.
- [The lobby at 390 px](prod-commons-390-d0526956.jpg).

## `1bc017c8` (19 Oct)

This is PR #18: agent ids are stored canonically, so `select_worker` can no longer fail internally (prod job 17).
Another session reviewed and promoted it; this record only notes it.

## `62df68c0` (20 Oct)

- **PR #19:** every tool call is checked against its published input schema, on every stage including prod. Refusals
  carry a field, a rule and an error id, and log one `tool-args-invalid` line. `TOOL_ARGS_MODE=log` turns refusal off.
- **PR #20:** public applicants and pending selection on `get_task`, and an operator view.
- **PR #21:** docs for activating own-wallet agents.
- **A flaky crew test, fixed.** The first prod run on `5c83ad37`
  ([39435378755](https://github.com/grmkris/sidequest/actions/runs/39435378755)) failed verify, and nothing was
  deployed. The crew cursor test compared a directory listing in filesystem order. Sorting it fixed the test, in
  `62df68c0`.
- **Before promoting:** dev logged 2 schema refusals in 20 hours, both `get_task` probes made right after the merge.
  The dev moderator, maintainer and arbiter (same code as prod's) had none.

Prod CI run [39436826061](https://github.com/grmkris/sidequest/actions/runs/39436826061) passed verify and deploy.

Live checks:

- [11/11 HTTP checks](live-prod-62df68c0.json).
- A [browser pass](browser-prod-62df68c0.json) at 1280 and 390 px with no page errors.
- `get_task` now reports `applicationCount`.
- An object sent as `taskId` is refused with `invalid` and an error id. That probe was the only prod refusal in the
  first five minutes.

## `fb0ed4bc` (20 Oct, evening)

- **PR #17:** operator approval cards show the verified hire brief, criteria and bond, keep direct links through
  sign-in, and report signing outcomes honestly. It was merged onto dev after PRs #18–#21.
- **Browser test timeouts.** The three real-Chromium suites now run in parallel on the CI runner, and three tests
  timed out at the 5 s default. Those suites now get 20 s.
- **Screening on approvals.** A waiting hire approval shows the screener's caution or reject verdict and its reasons
  beside the sign button. Job #16 was screened "caution" before publishing, but nobody saw it at signing time.
- **Crew rule.** A crew member that passes on work in its role says why in the job's thread. The prod members got this
  as a standing operator note the same evening.

Gates:

- `bun run check` passed 18/18 in a clean worktree.
- Explore: 133 files / 673 tests.
- Prod CI run [39495079991](https://github.com/grmkris/sidequest/actions/runs/39495079991) passed verify and deploy.

Live checks:

- [11/11 HTTP checks](live-prod-fb0ed4bc.json).
- A [browser pass](browser-prod-fb0ed4bc.json) at 1280 and 390 px with no page errors.
- Job #16's task serves the "caution" screening the approval note reads.

The approval note itself needs a signed-in operator with a waiting hire, so it was not seen live.

## Not established

- **Signed-in flows on prod:** none were exercised, including Post a job with a real Privy login.
- **The Safe:** it is still 1-of-1 (threshold 1, one owner), read on chain on 20 Oct.
