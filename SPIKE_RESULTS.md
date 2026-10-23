# Spike: workload OIDC assertions for hosted MCP

Local implementation and fixture evidence, 23–24 October 2026. Feature flag default off. No deployment, live-stage
acceptance, provider token, paid API call or cloud resource change was used. Workflow files are unchanged.

## Problem and decision

An unattended agent should exchange a short-lived platform identity for narrowly scoped Sidequest access rather
than store a reusable bearer token. Trust belongs to the human operator of an existing agent; it must not grant
operator decisions, wallet ownership or broader scope than that agent has.

The spike adds the [MCP client-credentials extension][mcp] using its recommended RFC 7523 JWT bearer grant.
[ADR-0030](docs/adr/0030-workload-oidc-assertions.md) is **proposed (spike)**. It preserves the authority boundary in
[ADR-0013](docs/adr/0013-agent-authority.md) and the role/scope refusal distinction in
[ADR-0021](docs/adr/0021-agent-roles-live-mcp.md).

## What changed

- The SDK exports the OIDC UI policy contract, `validateOidcPolicy`, exact claim matching and a GitHub compiler.
  Issuer must use HTTPS; an `aud` rule is required; an empty claim set never matches. Every listed rule must match;
  string arrays match on intersection. Registry code was inspected and adapted to the repo's schemas and UI,
  using the public [policy registry][registry-policy], [verifier registry][registry-verify] and
  [GitHub provider][registry-github], rather than installing a second form stack.
- The owning operator's agent Manage tab can save GitHub Actions or custom trust, list it, disable it or delete it.
  The GitHub form pins repository, branch, workflow, subject and audience. Custom trust requires HTTPS, audience
  and subject, with additional exact claim rules. Each policy has an explicit read/work/hire scope cap and exact
  MCP resource. The API authenticates the existing operator session and checks ownership on every operation.
- `POST /oauth/token` accepts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`, policy ID as
  `client_id`, exact `resource` and optional `scope`. It verifies discovery, same-origin JWKS, signature, exact
  issuer, lifetime and policy claims with `jose`. HTTPS documents are bounded, timed out, and redirects refused.
- Issuance rechecks policy and live agent roles after verification, then atomically consumes issuer/JTI and writes
  the access token. Tokens are opaque, last 300 seconds and have no refresh token. Requested scopes must be within
  the policy cap intersected with the current roles. Setup and Commons maintenance scopes are excluded.
- Existing MCP resolution and execution paths use that OAuth family and retain role checks and HTTP 403
  `insufficient_scope`. Disable/delete revokes existing families and prevents new issuance. Resolution also checks
  the policy and global feature flag. Policies, connection links and replay hashes use additive management-object
  SQLite tables; the existing D1 migration and its lock are unchanged.
- `WORKLOAD_OIDC_ENABLED=1` enables the grant, owner form, and extension advertisement in authorization metadata
  and MCP capabilities. Unset or any other value disables it, including previously issued workload bearers.

The installed MCP SDK is `1.32.1`: both `ClientCredentialsProvider` and `PrivateKeyJwtProvider` exist but prepare
`client_credentials`. The tests therefore perform a minimal RFC 7523 assertion exchange and reuse the SDK's token
storage and HTTP transport for the authenticated MCP call. No dependency major upgrade was needed.

## Run locally

The focused tests require no environment file, real issuer or external service:

```sh
bun --no-env-file run --cwd packages/sdk test src/oidc-policy.test.ts
bun --no-env-file run --cwd apps/explore test src/components/agent/WorkloadPolicyForm.test.tsx
bun --no-env-file run --cwd apps/api test --project unit test/workload-oidc.test.ts test/workload-http.test.ts
```

The fake issuer generates fresh ES256/RS256 keys and answers discovery/JWKS through injected fetch. An unexpected
URL fails the fixture. The HTTP test listens on an OS-assigned loopback port, exchanges the assertion over HTTP,
initializes an installed SDK MCP client, and calls `list_approvals` through the production MCP route and `runAgent`
executor. Policy disable then makes the same bearer return 401. This is local HTTP/SQLite evidence, not hosted
acceptance or proof of a real provider configuration.

For an already running local stack, enable the flag in its local process configuration. On an active agent's
Manage tab save trust; copy its client ID and resource. A workload requests an issuer token for the exact saved
audience, then sends this form to the same origin's `/oauth/token`:

```text
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
client_id=<saved policy id>
resource=<saved MCP resource>
assertion=<fresh platform-issued JWT>
scope=sidequest:read
```

Use the returned `access_token` as a bearer on that resource. The policy ID is public configuration, not a secret.
Tokens require `iss`, `sub`, `aud`, `iat`, `exp`, `jti` and an ES256/RS256 signature; maximum assertion age and lifetime
are 600 seconds. A workload cannot widen its cap through step-up; its operator must explicitly change trust and
it must obtain a fresh assertion. The spike offers add/disable/delete, not policy editing or re-enable.

## Gates and measurements

Base is `origin/dev` at `6bb21e881a473a164cf76d268a263d16af569313`. Before implementation, API/SDK baselines were
run from an unmodified `git archive origin/dev` under the ignored `report/oidc-spike/base`, with installed dependency
links. Explore's baseline ran in the original unmodified checkout. Initial archive runs failed on dependency
resolution; the recorded successful runs followed repair of those links. No stash/reset or other checkout was
used. The temporary archive was removed after measurement. Baselines below are measured counts, not the older
workspace instruction floors.

Long suites use `heavy` and retry unchanged after exit 75. Final broad gates use an empty environment except
`HOME`, `PATH`, `CI=1`, via `env -i HOME="$HOME" PATH="$PATH" CI=1`; no RPC or provider key is supplied. Logs are
local ignored files under `report/oidc-spike/`. Durations vary with other agents on the box; no performance claim
is made from these test runs. Initial gate attempts were interrupted by model-capacity restarts or queued behind
other agents. The initial Knip hint was resolved by `git submodule update --init --depth 1 -- contracts/lib/forge-std
contracts/lib/openzeppelin-contracts contracts/lib/openzeppelin-contracts-upgradeable` at their pinned revisions.
Lint then found a new file-length violation and unused fixture export; both were fixed without changing its baseline.

For the final lint and standard check, an ignored task-local `report/oidc-spike/bin/heavy` adapter contained only
`exec /usr/local/bin/heavy --wait "$@"`. The environment's `PATH` prepended that directory, so the existing collectors
used the wrapper's documented waiting mode and the same four-slot limit. The exact final command prefixes were
`env -i HOME="$HOME" PATH="$PWD/report/oidc-spike/bin:$PATH" CI=1 bun --no-env-file run lint:gate` and
`env -i HOME="$HOME" PATH="$PWD/report/oidc-spike/bin:$PATH" CI=1 heavy bun --no-env-file run check`.
No gate, threshold, lint configuration or migration lock was weakened.

The first complete repository check ended with SIGTERM (exit 143) after 17 of 18 workspace test tasks succeeded,
while contract compilation was unfinished. The cause was not established. The final retry reused completed Turbo
tasks from the local cache; cached test output is evidence from the earlier successful runs, not another execution.

| Measurement | Base                                               | Spike                                              | Exact command (from the corresponding source root)                                                                      |
| :---------- | :------------------------------------------------- | :------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| API unit    | 846 passed, 12 skipped; 89 passed files, 2 skipped | 868 passed, 12 skipped; 91 passed files, 2 skipped | Base: `heavy bun --no-env-file run --cwd apps/api test --project unit`; spike unit rows from the full API command below |
| SDK         | 430 passed, 33 skipped; 54 passed files, 4 skipped | 433 passed, 33 skipped; 55 passed files, 4 skipped | `heavy bun --no-env-file run --cwd packages/sdk test`                                                                   |
| Explore     | 674 passed; 132 files                              | 678 passed; 133 files                              | `heavy bun --no-env-file run --cwd apps/explore test`                                                                   |

| Gate                             | Result                                                   | Command                                                                                                                                                      |
| :------------------------------- | :------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API focused + OAuth regression   | 42 passed, 4 files                                       | `bun --no-env-file run --cwd apps/api test --project unit test/oauth.test.ts test/oauth-setup.test.ts test/workload-oidc.test.ts test/workload-http.test.ts` |
| SDK policy                       | 3 passed, 1 file                                         | `bun --no-env-file run --cwd packages/sdk test src/oidc-policy.test.ts`                                                                                      |
| Explore policy form              | 4 passed, 1 file                                         | `bun --no-env-file run --cwd apps/explore test src/components/agent/WorkloadPolicyForm.test.tsx`                                                             |
| SDK typecheck                    | Pass                                                     | `bun --no-env-file run --cwd packages/sdk typecheck`                                                                                                         |
| API typecheck                    | Pass                                                     | `bun --no-env-file run --cwd apps/api typecheck`                                                                                                             |
| Explore typecheck                | Pass                                                     | `bun --no-env-file run --cwd apps/explore typecheck`                                                                                                         |
| New source/test format + lint    | Pass, 14 files                                           | `bun --no-env-file run check:files --lint-only <new-source-and-test-paths>`; explicit list below                                                             |
| Full API including local Workerd | Pass: 893 passed, 17 skipped; 98 passed files, 2 skipped | `heavy bun --no-env-file run --cwd apps/api test`                                                                                                            |
| Standard repository check        | Pass, exit 0; 18/18 workspace tasks (17 cached)          | `heavy bun --no-env-file run check`                                                                                                                          |
| Repository lint baseline         | Pass; no increases, Knip 0                               | `bun --no-env-file run lint:gate` (collectors use `heavy` internally)                                                                                        |
| Final documentation              | Pass; format and agent/document checks                   | `bun --no-env-file run check:files SPIKE_RESULTS.md docs/adr/0030-workload-oidc-assertions.md docs/adr/README.md`                                            |

```sh
bun --no-env-file run check:files --lint-only \
  apps/api/src/oidc-verify.ts apps/api/src/oauth-metadata.ts apps/api/src/workload-policies.ts \
  apps/api/src/workload-schema.ts apps/api/src/workload-token.ts \
  apps/api/test/workload-fixture.ts apps/api/test/workload-oidc.test.ts \
  apps/api/test/workload-http.test.ts \
  apps/explore/src/components/agent/WorkloadPolicies.tsx \
  apps/explore/src/components/agent/WorkloadPolicyForm.tsx \
  apps/explore/src/components/agent/WorkloadPolicyForm.test.tsx \
  apps/explore/src/workload-policy.ts \
  packages/sdk/src/oidc-policy.ts packages/sdk/src/oidc-policy.test.ts
```

The API unit comparison is calculated from the full run's per-file project rows (the aggregate also includes
Workerd), using this exact command:

```sh
python3 - <<'PY'
from pathlib import Path
import re
text = re.sub(r'\x1b\[[0-9;]*m', '', Path('report/oidc-spike/test-api-final.log').read_text())
rows = re.findall(r'^\s*[✓↓]\s+unit\s+\S+\s+\((\d+) tests?(?: \| (\d+) skipped)?\)', text, re.M)
counts = [(int(total), int(skipped or 0)) for total, skipped in rows]
print({'unit_files': len(counts), 'unit_passed_files': sum(a>b for a,b in counts),
       'unit_skipped_files': sum(a==b for a,b in counts),
       'unit_passed_tests': sum(a-b for a,b in counts), 'unit_skipped_tests': sum(b for a,b in counts)})
PY
```

The successful standard check also completed the contracts workspace (`bun run test` through the root check):
27 launch-kit Python tests passed, then `forge test --threads 1` reported 436 passed, 0 failed and 22 skipped
across 43 suites. No RPC environment was supplied. Its final `bun tools/test-scripts.ts && bun test scripts/ci crew/bin`
reported 32 Node tests passed, 0 failed, followed by 75 Bun tests passed, 0 failed. The final receipt is exit 0
in `report/oidc-spike/check-final-retry.exit`; the complete local log is `report/oidc-spike/check-final-retry.log`.

Focused cases cover ES256/RS256 issuance and hosted MCP execution; wrong audience, subject, other claim, issuer,
expired/missing/future/overlong lifetime, malformed/missing assertion, missing JTI, bad signature, invalid policy,
untrusted discovery, simultaneous replay and cross-policy replay, disabled/deleted policy, token expiry, resource
binding, feature off, no refresh, scope caps, live role refusal, insufficient-scope step-up, operator ownership and
enabled-only metadata. Form tests follow Explore's existing static-render/component compiler pattern; no browser
interaction or visual acceptance is claimed.

## CI long-lived-secret audit (documentation only)

Inventory command: `rg -n 'secrets\.' .github/workflows/*.yml`. A Python `re.findall(r'secrets\.([A-Z0-9_]+)', ...)`
over those files found **15 distinct explicit secret names**. `ci.yml` uses Turbo credentials in verification;
dev/prod deploy and drift receive the runtime keys below through environment anchors. `smoke.yml` has no explicit
secret references. Public IDs/URLs such as `PRIVY_APP_ID`, `PRIVY_SIGNER_ID`, `CLOUDFLARE_ACCOUNT_ID`, `TURBO_TEAM`,
`TURBO_API`, GitHub app/installation IDs and `HYPERSYNC_URL` are variables, not additional credential names.

Official public pages were fetched and inspected with unauthenticated requests during this spike. The table
distinguishes documented short-lived support from a proposed broker; absence of evidence is not a claim that a
provider can never add federation. No workflow or provider configuration was changed.

| CI secret                         | Consumer                                                                               | Documented support checked                                                                                                                   | Recommended move                                                                                                                                                                                                                 |
| :-------------------------------- | :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURBO_TOKEN`                     | Verify/build and deploy/drift remote cache, with `TURBO_TEAM`/`TURBO_API`              | [Remote cache][turbo] documents token-based cache auth; no GitHub federation established for this configured cache                           | Identify the configured cache operator, scope/rotate its credential; use ephemeral job cache credentials only if that backend supports them. Verification must not inherit runtime signing keys.                                 |
| `ALCHEMY_STATE_STORE_CREDENTIALS` | State-store action writes credential JSON before deploy/drift, removes it in post-job  | [Alchemy state][alchemy] describes state backends; no GitHub OIDC federation established for this installed Cloudflare state store           | Restrict to protected deployment environments; introduce a state-access broker only after backend support and failure/recovery behavior are tested. The action's ephemeral file does not make its source credential short-lived. |
| `CLOUDFLARE_API_TOKEN`            | Alchemy deployment/drift and Cloudflare bindings                                       | [Cloudflare API tokens][cf] documents scoped API tokens/account tokens; the checked target docs do not establish direct GitHub OIDC exchange | Narrow resource/permission scope and validity; remove from non-deploy jobs. A broker issuing restricted credentials is a future integration, not supported by this spike.                                                        |
| `RELAY_PRIVATE_KEY`               | Legacy testnet relay binding; mainnet path is inert                                    | [Local signing][signing] uses a raw signing key, not a bearer-token exchange                                                                 | Keep out of general CI; retire with the testnet relay or move signing behind an operation-bound signer authenticated with workload identity. OIDC cannot replace an on-chain signer by itself.                                   |
| `ATTESTER_PRIVATE_KEY`            | Hosted screening/attestation signing binding                                           | [Local signing][signing] requires the signer key                                                                                             | Isolate signing from deployment; use a protected signing service with exact payload policy and short-lived job authentication. Rotate only with corresponding authority updates.                                                 |
| `PRIVY_APP_SECRET`                | Hosted Privy API authentication                                                        | [Privy API][privy-api] documents app ID/secret authentication; no direct GitHub OIDC exchange established                                    | Separate deploy from runtime use, restrict environment access and rotate; evaluate a narrowly scoped broker rather than distributing app-wide access.                                                                            |
| `PRIVY_SIGNER_KEY`                | Routine agent-wallet authorization signatures                                          | [Privy authorization keys][privy-keys] supports policy-scoped signing authorization; not an arbitrary GitHub JWT replacement                 | Keep signer material in protected runtime/signing infrastructure; enforce existing wallet policies and authenticate job requests separately.                                                                                     |
| `PIMLICO_API_KEY`                 | Bundler/paymaster requests in AA runtime bindings                                      | [Pimlico API keys][pimlico] documents API key issuance; no GitHub federation established                                                     | Limit chain, sponsor policy and budget where supported; rotate and isolate from verification. Consider a budgeted runtime proxy rather than a shared job credential.                                                             |
| `TESTNET_PAYMASTER_SIGNER_KEY`    | Testnet paymaster signing; inert on mainnet                                            | [Local signing][signing] requires signing authority                                                                                          | Remove from generic CI once the obsolete path is retired; otherwise use a testnet-only protected signer and short-lived job authentication.                                                                                      |
| `TELEGRAM_BOT_TOKEN`              | Telegram Bot API runtime/webhook setup                                                 | [Bot API][telegram] authenticates with a bot token                                                                                           | Isolate to the bot runtime and webhook configuration job; rotate via the bot owner. No OIDC exchange is established by the checked docs.                                                                                         |
| `TELEGRAM_WEBHOOK_SECRET`         | Shared webhook header checked by API                                                   | [Bot API setWebhook][telegram-webhook] supports `secret_token` delivered as a header                                                         | Generate a per-environment random value, rotate both sender and receiver together; this incoming-webhook check remains necessary even if deployment authenticates with OIDC.                                                     |
| `AI_GATEWAY_API_KEY`              | Hosted screening/model client; not used by spike tests                                 | [AI Gateway authentication][gateway] supports API keys and **Vercel-issued** OIDC; API keys do not expire until revoked                      | Use Vercel OIDC for workloads actually running on Vercel. Do not assume a GitHub-issued JWT is accepted; retain a scoped runtime key or introduce a documented broker path for Workers.                                          |
| `HYPERSYNC_API_TOKEN`             | Indexer's HyperSync/HyperRPC reads                                                     | [Envio tokens][envio] requires an API token; no GitHub federation established                                                                | Scope/rotate per environment and isolate to indexing. Evaluate provider-supported short-lived issuance before replacing it.                                                                                                      |
| `MONAD_RPC_URL`                   | Hosted runtime/deployment preflight RPC endpoint, possibly with embedded provider auth | [Monad JSON-RPC][monad] describes RPC, not federation for an arbitrary endpoint provider                                                     | Treat authenticated URL as a secret; use separate scoped provider credentials or a controlled RPC proxy. Confirm the actual provider before claiming OIDC support.                                                               |
| `SQ_GITHUB_APP_PRIVATE_KEY`       | Passed as `GITHUB_APP_PRIVATE_KEY` for GitHub App access                               | [Installation tokens][gh-token] expire after one hour; [app private keys][gh-key] do not expire automatically                                | Mint narrowly scoped installation tokens per job for GitHub work (or use `GITHUB_TOKEN` where sufficient). Runtime app access still needs its own protected signer/broker; minting a token does not eliminate the private key.   |

[GitHub OIDC][gh-oidc] can authenticate jobs to a target that trusts GitHub's issuer and claims. Adding
`id-token: write` alone does not convert the target's API-key or signing protocol into federation. A future CI
change should grant it only to the consuming job, pin repository/ref/workflow/environment/audience, and keep
deployment approvals. Trusted publishing is not applicable to these runtime secrets; this workflow publishes no
package registry artifact using them.

## Risks, open questions and production rollout

- Discovery fetches on every exchange. Before enabling publicly, add approved issuer/egress rules, including private
  destination protection, rate limits, negative caching and bounded JWKS/discovery caching with key rotation tests.
  Same-origin HTTPS JWKS and saved-issuer selection reduce exposure but do not establish an SSRF boundary.
- Decide supported providers and assertion lifetimes. The spike requires JTI and limits lifetime/age to 600 seconds;
  not every custom platform emits that profile. GitHub environment subjects and reusable workflow identities need
  explicit policy authoring; the current GitHub form deliberately pins the branch workflow case.
- Add retention for expired access tokens, OAuth families and connection rows; replay hashes are pruned on issuance.
  A busy CI workload currently creates a visible connection for each exchange. Review quotas, indexes and audit
  events without logging assertion/access-token values.
- Test in local Workerd with the feature enabled and real Workers Web Crypto, controlled issuer rotation/outages,
  race/revocation behavior, and browser save/disable/delete interactions. The loopback test covers production
  functions and real SQLite/signatures but does not boot the complete Worker for the enabled path.
- Before production, connect policy revocation to the existing D1 webhook-revocation tombstones and decide the
  lifetime of persistent subscriptions created by a workload. This spike revokes bearer families and management
  streams; it does not terminate independently stored webhook delivery records.
- Review operator policy UX and human-readable saved-claim inspection, board/resource selection, migrations and
  rollback. Disabling the flag stops workload bearers while preserving ordinary OAuth; the additive tables remain.
- Verify target federation documentation and protected signer/broker designs before a separate CI migration. No
  provider federation or secret retirement has been implemented or live-verified here.
- Production enablement requires security review and a separately authorized rollout. No deployed behavior or
  cloud-resource state is claimed by this spike.

[mcp]: https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials
[registry-policy]: https://ui.shadcn.com/oidc/r/policy.json
[registry-verify]: https://ui.shadcn.com/oidc/r/verify.json
[registry-github]: https://ui.shadcn.com/oidc/r/provider-github.json
[gh-oidc]: https://docs.github.com/en/actions/concepts/security/openid-connect
[cf]: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
[alchemy]: https://alchemy.run/docs/concepts/state/
[turbo]: https://turborepo.com/docs/core-concepts/remote-caching
[privy-api]: https://docs.privy.io/api-reference/introduction
[privy-keys]: https://docs.privy.io/controls/authorization-keys/overview
[pimlico]: https://docs.pimlico.io/guides/create-api-key
[gateway]: https://vercel.com/docs/ai-gateway/authentication
[envio]: https://docs.envio.dev/docs/HyperSync/api-tokens
[monad]: https://docs.monad.xyz/reference/json-rpc
[signing]: https://viem.sh/docs/accounts/local/privateKeyToAccount
[telegram]: https://core.telegram.org/bots/api
[telegram-webhook]: https://core.telegram.org/bots/api#setwebhook
[gh-token]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
[gh-key]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps

Lane status, 2026-10-24: local implementation and required gates complete; ready for draft PR review.
