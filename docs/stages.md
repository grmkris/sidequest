# Stages

Stage profiles live in [`infra/dev.json`](../infra/dev.json) and [`infra/prod.json`](../infra/prod.json), loaded by
[`infra/stage.ts`](../infra/stage.ts). Stage and network are separate: prod is currently on testnet.

## Stage reference

| Stage | Origin | Network | State | Trigger |
| :-- | :-- | :-- | :-- | :-- |
| `dev` | https://dev.sidequest.exchange | Monad testnet, 10143 | remote | push to `dev`, or approved `bun run deploy:dev` |
| `prod` | https://sidequest.exchange | Monad testnet, 10143 | remote | accepted dev SHA promoted to `prod`, with Kris's approval |
| `local` | local Workerd | local development | local | `bun run dev` |

There is no `main` branch. Agents work on `dev`; the cleanup coordinator owns integration and pushing. A push to `dev`
runs `verify` then `deploy-dev`. Promotion is `git push origin <green dev sha>:prod`; `deploy-prod` additionally requires
the repository variable `SIDEQUEST_ALLOW_PROD=1`. See [deploy](deploy.md) for command guards and CI.

## Resources and state

| Resource | Dev | Prod |
| :-- | :-- | :-- |
| API Worker | `sidequest-api-dev` | `sidequest-api-prod` |
| Indexer Worker | `sidequest-indexer-dev` | `sidequest-indexer-prod` |
| Explore Worker | `sidequest-explore-dev` | `sidequest-explore-prod` |
| D1 | `sidequest-dev-db` | `sidequest-prod-db` |
| R2 manifests | `sidequest-dev-manifests` | `sidequest-prod-manifests` |
| Telegram | `@sidequest_excange_dev_bot` | `@sidequest_exchange_bot` |

Dev and prod share the Cloudflare account and `alchemy-state-store` Worker with myapps, but keep distinct stage state,
Workers, D1, R2 and Durable Objects. The release runner checks the installed Alchemy state-store version before planning.
Never use `alchemy state read` or `syncState`; use the guarded plan/drift commands.
The docs site is built by [`apps/docs`](../apps/docs/AGENTS.md) and served by Explore at `/docs`, without a separate Worker.

## Credentials and authority

Dev and prod-testnet retain their own relay, declared by `relay` in their profiles. A mainnet profile omits that field:
hosted agents use USDC-paid user operations and the stage-derived arbitrator pays MON for rulings. The attester and
arbitrator are shared while both testnet stages use the single testnet pair `main` (`sidequest-v1`) in
[`monad-testnet.json`](../contracts/config/monad-testnet.json). One Privy app serves both testnet origins. Its
routine-signer policy allows both testnet relays;
[`sidequest-cutover.ts`](../packages/sdk/scripts/privy/sidequest-cutover.ts) `update-policy` is the reviewed update path.
Provider reads, signing or policy writes require their own authorized task and receipts.

Stage secrets live in mode-600 `~/.config/sidequest/<stage>.env`, mirroring the GitHub `dev`/`prod` environments.
Plain `GITHUB_*` local names use `SQ_GITHUB_*` in GitHub; the release runner maps them back. `.env.local` is for local and
test keys only, including flow wallets, deployer and admin. Never print those files or place their contents in evidence.

## Mainnet transition

Prod stays on testnet until [A01–A08](acceptance/a01-a08.md) and the [mainnet launch gate](mainnet-runbook.md) are accepted.
Kris must explicitly authorize every mainnet transaction. The transition changes `infra/prod.json` plus the promoted
mainnet contract configuration and redeploys prod. Dev remains on testnet. A public health check or a fork rehearsal is
not authenticated host acceptance or a live mainnet proof.

## Release history

These dated paragraphs preserve what their receipts established at the time. Historical recovery boundaries do not
reintroduce retired code or staging commands into the current release procedure.

### G1f: testnet SIDE from nad.fun's testnet launcher, on dev and prod-testnet — 12 October 2026

Kris chose to replicate the mainnet launch on testnet before acceptance. G1f's SIDE (`0xF4c211303e00716819E08E735Be2136329557777`)
was created through nad.fun's testnet API and V2 router by the launch kit, with its dev buy in a new kit-made 1-of-1
Safe (`0x78d5A4DB279C6850a07278A5A8EE76296740E438`). The v1 contracts were deployed against it, promoted and accepted
through the kit (config `f7255641`, Sidequest block 70431058). A new faucet gives 200 SIDE per claim. The routine Privy
policy serving both stages was updated and verified for G1f's Holding and core. G1e is archived, without refunds.
Dev released `4070fe2a` (CI verify, deploy and smoke green; indexer fresh). On Kris's go, prod moved to
`afdc6f00` ([CI 38272136997](https://github.com/grmkris/sidequest/actions/runs/38272136997)): smoke and drift clean,
health OK on testnet, writes open, `mainnetLive:false`, anonymous MCP 401, the indexer past the G1f block (87 s behind),
and the docs' address table naming the G1f Holding, Safe and SIDE. The role containers run `afdc6f00`, and the arbiter
signed in to both boards. Hosted agents re-back and operators re-sign their sponsorship on G1f; gas grants renew
themselves. A01–A08 run on `afdc6f00`. Evidence: [G1f](evidence/testnet-g1f/README.md),
[Privy](evidence/testnet-g1f/2026-10-12-privy.json).

### Performance and launch-path fixes promoted to prod-testnet — 12 October 2026

On Kris's go, prod moved from `15f1c177` to `52f1d6ae24a69f266feb2760bad9987e3a12285e`
([CI 38265359410](https://github.com/grmkris/sidequest/actions/runs/38265359410)): Explore's job detail without
full-list discovery, route accessibility and loading stability, the launch-path release fixes (launch inputs, smoke
pinned to `MAINNET_LIVE`, RPC origin preflight) and the launch kit's bond command. Deploy updated three resources, the
re-plan was a no-op, smoke passed under the new release expectations and drift was clean. Prod read Monad testnet,
writes open, `mainnetLive:false`, anonymous MCP 401 and an indexer 5 s behind; `/job/84`, `/agent/2218` and `/jobs`
rendered with their titles and no page errors. This is the commit A01–A08 test.

### Release review fixes on dev and prod-testnet — 12 October 2026

The orchestrator released `15f1c17795f351274a6e71573a4b90b89b803749` to dev
([CI 38246617008](https://github.com/grmkris/sidequest/actions/runs/38246617008)) and, on Kris's go, to prod
([CI 38248203257](https://github.com/grmkris/sidequest/actions/runs/38248203257)). The prod deploy updated three
resources and its re-plan was a no-op; the first drift step failed inside the programmatic inspection after the CLI
drift passed, and the job's re-run (attempt 2) deployed nothing new, smoked green and read drift clean. Both stages
read Monad testnet 10143, writes open and `mainnetLive:false`; prod's anonymous MCP answered 401 and its indexer was
current. The arbiter, moderator and maintainer now run as `sq-*` containers pinned to the released SHA
(`crew/bin/roles.ts`), replacing the tmux arbiter. Evidence: [reality check](reality-check.md).

### G1e testnet source and receipt evidence — 8 October 2026

The G1e contract cutover is recorded as **source and receipt evidence**, not a hosted release. Candidate source
`8dcf19cdf0faf4bc4e38b6551d9089340def3eaf` was promoted with config commit `488a941`; the orchestrator still owns
the push to `dev`, CI verification and hosted dev/prod deployment.

On Monad testnet (10143), deployment receipt evidence records 26 successful receipts at Sidequest block 69362265 and
core block 69362272. Safe acceptance then reconciled six owner calls at nonces 13–18: all six contracts are owned by
the Safe, with a 10 SIDE creator-bond floor, 1,000 SIDE cap, 2,500 bps unfilled forfeit, 5,000 bps maximum, 600-second
cancel grace, Holding-authorized vault and Safe treasury. The new faucet deployed at nonce 93 and received 10,000,000
SIDE from ecosystem nonce 31; its exact drip is 1,000 SIDE. The deployer minted 1,100 mUSD at nonce 94 and seeded the
pool with nonces 95–98; `SeedPool.verify()` read back Safe position 94, liquidity `99990000000000000` and pool ID
`0x4eb903f29419f209c25c85a75aafad8f5f3dd0a79f4a6f5cba11f4d854e09a4d`.

The refund receipt fixes the G1d-vault snapshot at block 69362264: 14 positions totaling 92,290 SIDE, zero dust and
20,000 SIDE explicitly allocated to Kris. Sixteen ecosystem operations (nonces 32–47) reconciled successfully. The
existing Privy routine policy was then updated and verified with 11 rules, the fresh G1e Holding/core pins and both
dev/prod relays, while preserving the existing authority. These are chain/provider receipts only; they do not establish
hosted application health, authenticated managed signing or genuine-user acceptance.

Receipts: [contracts](evidence/testnet-g1e/2026-10-08-contracts.json),
[Safe acceptance](evidence/testnet-g1e/2026-10-08-ownership.json), [faucet](evidence/testnet-g1e/2026-10-08-faucet.json),
[pool](evidence/testnet-g1e/2026-10-08-pool.json), [refunds](evidence/testnet-g1e/2026-10-08-refunds.json),
[manifest](evidence/testnet-g1e/refund-manifest.json), and [Privy](evidence/testnet-g1e/2026-10-08-privy.json).

### G1e released public and FLOW checks — 9 October 2026

The orchestrator released `62a6c582e1199a6bdbb908bd8630f10f0a8c1eb3` to dev and prod (CI runs
[37858656947](https://github.com/grmkris/sidequest/actions/runs/37858656947) and
[37860512444](https://github.com/grmkris/sidequest/actions/runs/37860512444)). Both public stages read healthy
Monad testnet 10143, writes open, `mainnetLive:false`, the fresh G1e pair and progressing indexers. One faucet claim
delivered 1,000 SIDE plus 1,000 mUSD and 1,000 mEUR; pool quote checks passed. One arbiter runs in
`sidequest-g1e-arbiter`, signed into both boards with no disputes; this is startup/heartbeat evidence only.

The existing FLOW wallets completed bonded job 2 (1 mUSD gross, 0.7 mUSD worker payout, 0.3 mUSD treasury fee and
both bonds returned) and an eight-second early cancel of job 3 (full bond returned). They then cancelled never-activated
job 1 after the 600-second grace: 2.5 SIDE was forfeited to the Safe treasury and 7.5 SIDE released. The Holding
`BondForfeited` and vault `Forfeited` logs share one receipt/block; the Holding event and bond outcomes are indexed on
both stages, while the vault event is verified from the live RPC log. This is bounded FLOW operator evidence, not
genuine-user or hosted managed-signer acceptance, and all stages remain testnet.

Receipts: [public/faucet](evidence/testnet-g1e/2026-10-08-public-faucet.json),
[arbiter](evidence/testnet-g1e/2026-10-08-arbiter.json), [GO 13](evidence/testnet-g1e/2026-10-08-go13-index.json),
[GO 14](evidence/testnet-g1e/2026-10-09-go14-index.json), and
[late-cancel chain evidence](evidence/testnet-g1e/2026-10-09-late-cancel.json).

The latest hosted MCP metadata release is `a234a7f`, deployed to dev and promoted to prod on 8 October 2026. It serves
public and tenant Server Cards, the domain AI Catalog and the HTTPS registry proof. The exact CI, schema, live endpoint
and registry receipts are in [MCP metadata evidence](evidence/mcp-metadata/2026-10-08-a234a7f-release.json). The public
registry entry is active at `exchange.sidequest/sidequest` version `2.0.0`; prod remains Monad testnet.

The preceding guarded application release on both dev and prod was
`fb5d2696021cccd86fd5cd9b207fb6e20ae21c79`, released on 8 October 2026. Dev CI
[`37792203350`](https://github.com/grmkris/sidequest/actions/runs/37792203350) passed before that exact SHA was
promoted to prod; prod CI
[`37793608897`](https://github.com/grmkris/sidequest/actions/runs/37793608897) completed at 14:38:14 UTC.
Both runs passed verification, build, guarded deploy, smoke and drift. Both stages remain on Monad testnet (10143).
The indexers use G1d core `0xAa658Ff5C8A82e780A0647561E51064846bDcb54` from deployment block 69264369,
with fresh progressing cron checkpoints. The
[hosted receipt](evidence/testnet-g1d/2026-10-08-hosted-release.json) distinguishes CI source identity from public
network readback. The [fixture receipt](evidence/testnet-g1d/2026-10-08-live-hire.json) verifies the first paid
G1d prod quote-to-hire, both wallets' stake, both public indexes and live pool quotes. Genuine-user acceptance
remains open.

The previous guarded dev application release was `d40d4f0`, deployed on 7 October 2026
at 13:13:46 UTC. It ships the public docs at `/docs`: 20 prerendered pages served by
Explore, Markdown for the same URL on `Accept: text/markdown`, `/llms.txt`,
`/llms-full.txt` and search, plus MCP docs resources and `search_docs`. It also ships
cleanup wave 1 (legacy deletion). Two earlier attempts on `e1e173a` and `37baad6` are
recorded in the receipt: the first updated Api and Indexer before Explore's build failed;
the second was refused by the guard until it learned to resume Alchemy's interrupted update.
The [dated live receipt](evidence/sidequest-dev/2026-10-07-d40d4f0-live.json) records the
gates, the guarded update, the anonymous readback, 23 docs checks and a browser check.

The previous guarded dev application release was `fb3e981`, deployed on 7 October 2026
at 08:44:22 UTC at Kris's request. It fixes two things the `3cebe7d` readback found: a
request under a minute old reads "Posted just now" (not "Posted in 31 s"), and the row's
"Up to" carries a real space. The
[dated live receipt](evidence/sidequest-dev/2026-10-07-fb3e981-live.json) records the
gates, the guarded update, the anonymous readback and the quotes-first live proof on the
testnet board: Scout's request with a 15 mUSD budget (budget covered, poster shown), Grok
Bot's 20 mUSD quote refused as over budget and its 12 mUSD quote accepted (public count 1),
the old `/quotes` links redirecting and `/workers` gone. A pick was not exercised.

The previous guarded dev application release was `3cebe7d`, deployed on 7 October 2026
at 08:34:25 UTC at Kris's request. The
[dated live receipt](evidence/sidequest-dev/2026-10-07-3cebe7d-live.json) records the
source/tree, the green `heavy bun run check`, the runner tests, the migration drift check (no new
migration), a redacted secret scan of the pushed range, the guarded update, the anonymous
readback (health, release and OAuth metadata 200; every anonymous MCP method 401) and an
anonymous browser smoke (light/dark, 1440/390, no page or console errors). It carries
quotes-first (one Jobs list with quote requests, a public budget maximum, rolling
countdowns, the request page at `/request/$id`, the Workers page removed) and the testnet
marker (a TESTNET tag and amber top edge instead of the network switch; mainnet's
pre-launch testnet link now comes from `links.testnet` in the network config) with the
sidebar wallet card (balances, staked SIDE, dollar estimates from `usdPegged` and the SIDE
pool). Host acceptance and authenticated MCP calls remain unverified.

An earlier guarded dev application release was `c7da8ba`, deployed on 6 October 2026
at 20:12:35 UTC at V11's READY-FOR-DEV-CUT request. The
[dated live receipt](evidence/sidequest-dev/2026-10-06-c7da8ba-live.json) records the
source/tree, V11's green `heavy bun run check`, the runner tests and migration drift check,
the successful guarded update and the anonymous readback (health, release and OAuth
metadata 200; every anonymous MCP method 401). It fixes the root cause of the
approved-hire retry failure: Cloudflare's SQLite refuses `LIKE` patterns over 50 bytes,
which the step-prefix lookups hit once an allowance hash was in the prefix; they now
match by `substr`, with a regression test. Host acceptance and authenticated MCP calls
remain unverified.

An earlier guarded dev application release was `d167a0d`, deployed on 6 October 2026
at 20:01:33 UTC at V11's READY-FOR-DEV-CUT request. The
[dated live receipt](evidence/sidequest-dev/2026-10-06-d167a0d-live.json) records the
source/tree, V11's green `heavy bun run check`, the runner tests and migration drift check,
the successful guarded update and the anonymous readback (health, release and OAuth
metadata 200; every anonymous MCP method 401). It adds function-name-only stack frames
to the agent-failure log so a masked internal failure names where it was thrown, and
gives each crew run a token that outlives it. Host acceptance and authenticated MCP
calls remain unverified.

The previous guarded dev application release was `760b0a7`, deployed on 6 October 2026
at 19:38:24 UTC at V11's READY-FOR-DEV-CUT request for `3109c14` (`760b0a7` adds only a
crew scenario document, so the deployed application source is `3109c14`). The
[dated live receipt](evidence/sidequest-dev/2026-10-06-760b0a7-live.json) records the
source/tree, V11's green `heavy bun run check` on `3109c14`, the runner tests and migration
drift check, the successful guarded update and the anonymous readback: health, release and
OAuth metadata 200; every anonymous MCP method 401. It carries the V11 Explore fixes
(first-login signature, error pages, `/agents/<id>` redirect, role-scoped consent, budget
editor, MON gas wording, 1 s receipt polling, http(s)-only deliverables, screening verdict
placement) and the board fixes that name a short-backing conflict and an approved-hire
validation failure instead of an internal error. Host acceptance and authenticated MCP
calls remain unverified.

The previous guarded dev application release was `4dc03be`, deployed on 6 October 2026
at 14:33:59 UTC. The [host-parity live receipt](evidence/sidequest-dev/2026-10-06-4dc03be-live.json)
records its source/tree, green gates, successful guarded update and anonymous readback.
Health and OAuth metadata returned 200; MCP discovery, tools, App and skills returned 401.

The previous signed-off dev application release was `e90b9f5`, deployed on 6 October 2026
at 11:51:14 UTC. The [dated live receipt](evidence/sidequest-dev/2026-10-06-e90b9f5-live.json)
records the exact source/tree, Worker versions, authority binding, anonymous browser smoke and
public readback. It includes the video-review application and the anonymous publisher-handoff fix. Public health, release,
directory, agent setup and OAuth discovery checks pass. Anonymous writes and
MCP requests require authentication. Twenty browser page/theme/viewport checks
passed without page errors or overflow. The narrow Privy origin update has since
saved successfully, and the repeated sign-in modal smoke has no provider errors.
The Privy display name, evergreen color and Sidequest icon were saved and read
back through the narrow branding form. Authenticated MCP enumeration and real
human login remain unverified. Anonymous 390px/1440px browser checks visually
confirmed the deployed icon in the live sign-in modal with no provider errors.
The separate Sidequest routine policy now pins the fresh contracts and preserves
the legacy policy and its recovery authority. Its dev binding is guarded by a
private journal and a four-field dev overlay. See
[release evidence](reality-check.md#sidequest-greenfield-dev-release-6-oct-2026) for dated readbacks.
The indexer retains its minute cron and progressing checkpoints; one completed
testnet hire is now indexed. V11 verified chain events entering the feed and a
paid request to the public `/x402/demo` endpoint. Its local test-wallet signature
does not establish acceptance of the hosted managed signer.
