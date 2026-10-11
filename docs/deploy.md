# Deploy and CI

The stage profiles are the release contract: [dev](../infra/dev.json), [prod](../infra/prod.json), and
[stage resolution](../infra/stage.ts). Work on `dev`; prod promotion and prod deploys require Kris's explicit approval.
Prod currently runs on Monad testnet. Every mainnet transaction needs a separate explicit go.

## CI jobs

| Job | Trigger | Work | Gate |
| :-- | :-- | :-- | :-- |
| `verify` | push to dev/prod, PR to dev, workflow dispatch | frozen Bun install, `bun run check`, build, clean tree check | all quality gates and build pass |
| `deploy-dev` | push to dev, after verify | stage-env guarded release, smoke, drift | GitHub `dev` environment; serialized |
| `deploy-prod` | push to prod, after verify | stage-env guarded release, smoke, drift | GitHub `prod` environment and `SIDEQUEST_ALLOW_PROD=1` |
| `smoke` | hourly at minute 17, or workflow dispatch | public dev and prod health/discovery/auth-refusal checks and indexer freshness | read-only public checks |

The workflow lives in [ci.yml](../.github/workflows/ci.yml); scheduled checks live in
[smoke.yml](../.github/workflows/smoke.yml). Promotion is manual:
`git push origin <green dev sha>:prod`, performed only by the authorized coordinator/operator.

## Commands and release guard

The only live release entry point is [`scripts/ci/release.ts`](../scripts/ci/release.ts):

```bash
bun run plan dev
bun run deploy:dev
bun run drift dev
bun run smoke dev
```

For an approved prod operation, the corresponding commands are `bun run plan prod`, `bun run deploy:prod`,
`bun run drift prod` and `bun run smoke prod`. The release runner requires `SIDEQUEST_ALLOW_PROD=1` for prod;
a variable is a technical gate, not Kris's authorization.

Before deploy, the runner validates required settings, profile/account identity, RPC chain, relay/attester addresses and
remote state version. Planning uses a read-only state service. The plan refuses any replacement, deletion or orphan and
any create outside a proved first deploy. It refuses adoption except the explicit one-time dev `--adopt-move` path.
Do not bypass a refused plan with direct Alchemy commands or delete state to make it look like a first deploy.

## Shared remote state

Dev and prod use `alchemy-state-store` in the same Cloudflare account as myapps. Stack identity is `Sidequest`, with
separate `dev` and `prod` state. CI installs the protected `ALCHEMY_STATE_STORE_CREDENTIALS` through the checked-in
[state-store action](../.github/actions/state-store/action.yml). The release runner verifies credential mode/account, reads `/version`, and compares it with `STATE_STORE_VERSION`
from the installed Alchemy provider. An absent or mismatched version refuses the release. Planning cannot bootstrap or
upgrade the shared Worker.

Never run `alchemy state read` or `syncState`. Never print the state credential, auth token, provider response or stage
env. Updating the shared state store requires a separate coordinated myapps/Sidequest operation.

## Secrets and Bun loading

Mode-600 `~/.config/sidequest/<stage>.env` files use plain names and mirror GitHub's `dev` and `prod` environments.
CI stores `GITHUB_*` variables/secrets as `SQ_GITHUB_*`; the workflow and runner map them to provider names. The required
release keys are declared by `REQUIRED_SECRETS` in `release.ts`. `.env.local` contains local and test keys only.

Bun automatically loads checkout env files. The runner scrubs inherited stage/config values, assembles the selected
stage environment, and starts inspection with `bun --no-env-file`. CLI deploy/drift use the tracked regular empty file
`scripts/ci/empty.env` and `BUN_OPTIONS=--no-env-file`. Do not replace this with `/dev/null`: the CLI rejected that
non-regular file on 7 October. Never print either env file or secret values while diagnosing.

## Telegram webhooks and keys

Each stage has its own relay and bot: dev `@sidequest_excange_dev_bot`, prod `@sidequest_exchange_bot`. The attester and
arbitrator are shared on testnet. One Privy app's routine policy permits both relays; use the reviewed
[`sidequest-cutover.ts`](../packages/sdk/scripts/privy/sidequest-cutover.ts) `update-policy` path for an authorized change.

The API accepts Telegram at `<stage origin>/telegram/webhook` and requires `X-Telegram-Bot-Api-Secret-Token` matching
that stage's `TELEGRAM_WEBHOOK_SECRET`. Register or inspect a webhook only as a separately authorized operator action,
using the corresponding stage bot and canonical origin. Do not change the other stage's webhook or place the bot token
in command history, logs or evidence. Public smoke does not prove webhook delivery; record sanitized URL/status/count
readback separately.

## First deploy and the 7 October state move

A first deploy requires both absent remote stage state and a complete Cloudflare census proving the fixed Worker, D1,
R2 and domain names do not already exist. Existing resources require the reviewed adoption move, not a repeated first
deploy. Existing saved output or pending replacement generations count as existing state.

On 7 October the dev migration to remote state needed deferred adoption: Alchemy initially described a resource as
`create` because its properties waited for upstream outputs, then found it by name during apply. Commit `851fe25` counts
only the reported deferred creates as adopted during the explicit dev `--adopt-move` operation. Normal releases still
refuse unexpected creates. Commit `de48891` introduced the real empty CLI env file and Bun autoload guards; `b8034a4`
explicitly set D1 `readReplication: { mode: 'disabled' }` to match the provider's readback. These are implementation and
incident records; this page does not claim a fresh deploy or drift run.

The docs/Explore parallel build race was fixed by `ae7a19f`: Turbo builds docs first, and Explore's package build reuses
that output with `SIDEQUEST_DOCS_PREBUILT=1`. Alchemy's direct Vite build remains the sole docs builder during release.
See [release history](stages.md#release-history) and [reality check](reality-check.md) for dated live receipts.

## Rollback

Select the last accepted SHA and inspect its stage profile, migration inventory, resource names and release plan.
With Kris's approval for prod, redeploy that exact tree through the same runner. Never force-push, rewrite state, destroy
resources, or drop schema to roll back. Applied migrations remain additive; incompatible data/code changes require a
forward correction. After deployment, run smoke and drift and record new receipts. Public readback alone does not prove
authenticated host or money-moving acceptance.

## MCP discovery and registry publication

[`server.json`](../server.json) is the official registry manifest for `exchange.sidequest/sidequest`. It advertises only
`https://sidequest.exchange/mcp`. The API's shared metadata keeps its identity aligned with runtime discovery and the
public/tenant Server Cards. Explore routes these requests to the API; the domain AI Catalog lists only the public card.
`bun run smoke <stage>` checks the cards, media types, CORS, cache validators, catalog, public proof and icon, alongside
OAuth discovery and anonymous authentication refusal. These checks do not prove authenticated host use.

The HTTPS namespace proof is served at `/.well-known/mcp-registry-auth`. Only the Ed25519 public key is checked in at
`apps/api/src/mcp-registry-proof.json`. The private 32-byte seed is stored as `MCP_REGISTRY_PRIVATE_SEED` in mode-600
`~/.config/sidequest/mcp-registry.env`; it is never bound to a Worker. Keep the existing key for repeat publication.

Before an authorized publication, validate `server.json` with the official `mcp-publisher validate server.json`, accept
the exact dev SHA, promote it to prod, and verify prod smoke/drift plus the public proof. Check the registry's exact
name/version before a retry: an already matching active entry needs no write, and a conflicting entry needs review.
Authenticate using the registry's HTTP proof flow, signing the current RFC3339 timestamp with Ed25519 and exchanging it
at `/v0.1/auth/http`. Keep the seed and returned token in process memory, out of command arguments and logs. Publish the
manifest to `/v0.1/publish`, then read `/v0.1/servers/exchange.sidequest%2Fsidequest/versions/2.0.0` and record the public
entry, active status and production endpoint. Record sanitized receipts in `docs/evidence/mcp-metadata/` and link them
from the reality check.

Server Cards follow the official [extension schema](https://github.com/modelcontextprotocol/ext-server-card). Their
schema URI is the specification's versioned `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`.
If that static URL is unavailable, validate against the extension schema at a recorded commit with URI formats enabled;
do not silently substitute the registry schema for a card.

## Troubleshooting

| Symptom | Cause or evidence | Resolution |
| :-- | :-- | :-- |
| CLI refuses `--env-file /dev/null` | CLI accepts a regular env file only (7 Oct) | Keep the regular empty env file and Bun loading guards (`de48891`) |
| Wrong stage values appear | Bun auto-loaded `.env.local` or inherited stage values | Use the runner's scrubbed environment, `--no-env-file` and `BUN_OPTIONS`; inspect names/statuses only |
| Dev adoption reports `create` | Deferred ownership probe waits for upstream outputs | Review the one-time `--adopt-move` plan; only reported deferred adoption is counted (`851fe25`) |
| D1 always drifts | Provider reads disabled `readReplication`, absent from saved props | Preserve explicit disabled read replication (`b8034a4`), then use guarded drift |
| Docs prerender `ERR_MODULE_NOT_FOUND` | Docs and Explore wrote `apps/docs/dist` in parallel | Keep docs before Explore and reuse the verified output (`ae7a19f`) |
| GitHub push returns HTTP 500 | GitHub server error observed on 7 Oct | Read the remote ref before retrying the same authorized push; never force or rewrite history |
| State-store version mismatch | Shared Worker differs from installed provider protocol | Coordinate the shared version change; do not run `syncState` or bootstrap it from planning |
| Plan refuses replace/delete/orphan/create | Resource or state delta exceeds the guard | Review exact names and inventory with the coordinator; never weaken the guard |
| A new Worker's cron never fires; `/data/jobs` says the index is not built | `sidequest-indexer-prod` had its schedule but no scheduled invocation for 70 minutes after the first prod deploy (7 Oct); it fired 6 minutes after the next deployment | Smoke now fails on a missing or stale (>10 min) checkpoint. Check `workersInvocationsScheduled` in Cloudflare GraphQL; re-PUT the schedule, then redeploy the Worker (push the same SHA again) |
| `heavy` exits 75 | Another job holds the shared capacity | Retry after 15 seconds; this is contention, not a failed check |
