# Production releases, 19–20 October 2026

Prod moved three times since the [18 October release](../prod-release-2026-10-18/README.md):
`3d852468` → `d0526956` → `1bc017c8` → `62df68c0`. Kris approved each promotion. None of them made a mainnet
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

## Not established

- **Signed-in flows on prod:** none were exercised, including Post a job with a real Privy login.
- **The Safe:** it is still 1-of-1 (threshold 1, one owner), read on chain on 20 Oct.
