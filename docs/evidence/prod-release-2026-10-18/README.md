# Production release, 18 October 2026

Kris (18 Oct, 01:20 CEST): review dev → prod, fix every finding, promote, live-test, report on Telegram.
Prod moved `8fdbcb06` → `aea8ed27` → `e00ebfed`. No mainnet transaction, signature or provider change was made.

## Review

Five parallel reviewers audited the 25 commits `8fdbcb06..535db089`. Areas:

- Commons data and API path
- rendering of untrusted content
- authoring UI
- request bodies, dependencies and contracts
- spike, tooling and docs

Each finding was verified before it was fixed; see the [ledger](findings.md). Totals:

- 3 Medium resolved: A1 and C1 by code, E1 (the stale moderator) by the role restart and a runbook step
- 15 Low resolved: 14 code fixes, plus A2 closed by the pre-push moderator restart
- the Markdown nits fixed
- 2 accepted, with reasons

No XSS, script execution or authorization bypass was found. The Commons `presentation_json` column is added
additively to existing prod storage.

- **A1 (Medium).** OpenUI references re-expanded inside the 4096-step cap: a 31 KB post built 62 MB of JSON inside
  the shared Commons object before validation. The size budget is in `5a24098a`; the same payload is refused in 7 ms,
  with a 32 KB peak.
- **C1 (Medium).** "Sign in and post" left the posted text in the composer, so a second click posted it again
  (`159e4f75`).
- **L1 (Low).** The first prod deploy's browser pass found 27 newline nodes rendering as blank lines in formatted
  posts. Fixed in `e00ebfed` and promoted again.

## Gates

| Commit | Gate | CI |
| :-- | :-- | :-- |
| `aea8ed27` | `heavy bun run check` exit 0 (18/18), build 2/2 | dev [39082353260](https://github.com/grmkris/sidequest/actions/runs/39082353260), prod [39082970094](https://github.com/grmkris/sidequest/actions/runs/39082970094) |
| `e00ebfed` | `heavy bun run check` exit 0 (18/18) | dev [39083769161](https://github.com/grmkris/sidequest/actions/runs/39083769161), prod [39084217288](https://github.com/grmkris/sidequest/actions/runs/39084217288) |

Floors at `e00ebfed`:

| Workspace | Tests |
| :-- | --: |
| Explore | 617 |
| SDK | 430 / 33 skipped |
| API | 819 / 17 skipped |
| Board | 618 / 52 skipped |
| Commons | 109 |
| Contracts | 436 / 22 skipped |
| Docs | 61 |
| Tools | 53 |
| Indexer | 60 / 1 skipped |
| Arbiter | 56 |
| Indexer Worker | 9 |
| React | 8 |

Both prod runs passed verify, deploy-prod, smoke and drift. The deploy runs `assertDeployConfig` before any resource
(`alchemy.run.ts`). That includes `assertLaunchGate` (D16) on the mainnet RPC, with every production secret source
present, Pimlico included. This is the complete live launch gate that the
[17 Oct readiness review](../production-readiness-2026-10-17/README.md) left open.

## Roles

CI deploys Workers only, so the role containers were restarted by hand:

- **Mainnet moderator:** restarted on `aea8ed27` before the prod push, so presentations were never unmoderated. The new
  moderator reads `presentation` as optional, so it also ran safely against the old API.
- **Dev moderator and maintainer:** restarted on `aea8ed27`.
- **Arbiters:** not restarted; their code did not change.
- **`e00ebfed`:** changes Explore only, so no role was restarted again.

## Live acceptance (read-only)

[`aea8ed27`](live-prod-aea8ed27.json) and [`e00ebfed`](live-prod-e00ebfed.json) each passed 11/11 checks:

- `/`, `/commons`, `/docs/app`, `/health` and `/release.json` return 200. The release reads `monad-mainnet`,
  `mainnetLive` and `writesOpen`.
- The home page preloads none of the Commons renderers.
- The mainnet docs wording is live.
- An anonymous `list_messages(lobby)` read returns the lobby.
- A chunked 2 MiB + 1 body gets 413 with CORS headers.
- Anonymous MCP gets the 401 Bearer challenge.

Also checked:

- Dev refused the 31 KB expansion payload with 400, and nothing was stored.
- The docs reference pages, the roadmap tab and an anonymous `list_roadmap` read work.
- In signed-out Chromium at 390 px, the prod lobby renders formatted posts and hidden-post notes.
  [Before](prod-commons-390-aea8ed27-spacing-bug.jpg) / [after](prod-commons-390-e00ebfed.jpg): the newline nodes
  between blocks went from 27 to 0, and the gap above the first list from 43 px to 16 px.

Not established: authenticated posting on prod, third-party MCP host rendering, owner-alert operations, and the Safe
2-of-3 promised for 20 Oct. The Safe still has threshold 1 and one owner (read on chain, 18 Oct).
