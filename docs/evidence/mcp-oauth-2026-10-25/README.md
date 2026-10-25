# MCP OAuth conformance, 25 October 2026

Scope: audit §3.5 and the revised standards-first decisions. Runtime source: `f7848821`; first dev release: `1a562ae727897a02f0ee82b9aed8bd1579825073`. The [independent review](review.md) found one loopback edge case, fixed before release.

| Gap | Before | After / proof |
| --- | --- | --- |
| M1 | Plain HTTP served OAuth metadata and reached the token handler; HSTS absent | Cloudflare edge now redirects HTTP, including token POST, and adds one-year HSTS with subdomains. No Worker guard added. |
| M3 | Authorization rejected a registered loopback callback on a different port | IPv4/IPv6 callbacks vary only by port; path/query bytes remain exact. Tests cover empty paths and query-only suffixes. Code exchange requires the actual requested URI. |
| M4 | Issuer response parameter existed but was not advertised | `authorization_response_iss_parameter_supported: true`; existing success/error `iss` tests retained. |
| I6 | Foreign Origin on protected-resource discovery returned 403 | OAuth discovery/register/token/revoke accept credential-free CORS; foreign Origin on consent approval still returns 403. Tenant CORS on `/mcp` is unchanged. |
| S1 | CIMD absent | Public-client CIMD enabled for the documented exact URL trust list on dev and prod. Metadata fetched outside the serialized DO queue, bounded and validated. |
| S2 / S4 | Challenge lacked scope and invalid-token detail | MCP-only scopes on every challenge; presented invalid Bearer gets 401 `invalid_token`. |
| Offline access | Refresh already issued unconditionally; an explicit `offline_access` request was refused | Refresh remains available without that scope, and an optional request is excluded from granted scopes. Unit lifecycle tests cover refresh/revocation. |
| Canonical issuer | Issuer/resource depended on request origin | Hosted OAuth uses `PUBLIC_ORIGIN`; alternate hosts redirect 308 preserving the query. |

DCR already narrowed unsupported grants, and the live probes recheck that behavior. `cursor://` and other custom callback schemes remain refused. DPoP was absent; no binding or advertising was added. ADR [0031](../../adr/0031-mcp-oauth-standards.md) records these decisions.

## Validation limits

The full local gate passed: API 104 files (102 passed, two skipped), 936 passed and 17 skipped tests; Explore 134 files, 689 passed. The build passed. No test floor was lowered. `check:files` reports existing baseline lint debt; the authoritative full `lint:gate` passed, with two owned baseline counts reduced. The earlier M4 commit body incorrectly said owned-file checks passed; only formatting/typechecking passed at that point, and the final full gate supersedes that preliminary wording.

The official suite's non-interactive authorization-server metadata scenario is applicable. Its authorization-code and DPoP scenarios require interaction; the audit retained no Sidequest signed-in session. Public registration/authorization probes and local lifecycle tests do not establish signed-in acceptance in Claude, Claude Code, ChatGPT, Codex, VS Code or Cursor. ChatGPT's published CIMD requires `private_key_jwt`, outside this release's public-client-only implementation; retain DCR until the required clients are verified through CIMD. Arbitrary Inspector browser origins still need the existing tenant `/mcp` CORS policy.

No mainnet transactions, wallet signatures or paid model calls were made by this workstream. Role-container code was not changed.

## Dev acceptance and cleanup

[CI 40192403249](https://github.com/grmkris/sidequest/actions/runs/40192403249) passed verify, deploy-dev, smoke and drift. The separate `bun run smoke dev` passed. Local `heavy bun run drift dev` refused before planning because the local stage env lacks `PIMLICO_API_KEY` and `TESTNET_PAYMASTER_SIGNER_KEY`; no keys were copied or changed. CI's protected-credential drift passed.

Initial readback at 12:25 UTC still saw the sponsor Durable Object's old metadata/port matcher while the Worker already served new CORS/challenges. Cloudflare's eventual DO rollout converged by 12:29 UTC without redeploy or mutation; [the transient receipt](rollout-delay.json) is retained. Final [audit probes](dev-probe.json) have no findings. [Active probes](dev-active2.json) verify 302 for port changes, 400 for path changes, and narrowed DCR grants. [Header readback](dev-headers.json) verifies M1 and I6. [Official suite checks](conformance-checks.json), from upstream suite commit `c37eec888e1c6ff140af79987a40008548b7cc5f`, pass 2/2 with no warnings.

| Client | Dev evidence | Remaining acceptance |
| --- | --- | --- |
| Claude web | Real CIMD document and callback reach consent (302) | Sign-in, token exchange and MCP call |
| Claude Code | DCR shape accepted | Actual client sign-in and refresh |
| Codex | Real CIMD, port-less loopback registration and ephemeral port reach consent (302) | Actual client sign-in and refresh |
| VS Code | Real CIMD reaches consent; mixed-loopback/HTTPS DCR narrows extra grants | Actual client sign-in and refresh |
| ChatGPT | Public-only validator refuses its `private_key_jwt` CIMD (400) | Client-auth support and attended connector acceptance |
| Cursor | Custom scheme refused (400), per revised decision | Standards-compliant HTTPS/localhost callback and client acceptance |

[Dev cleanup](dev-cleanup.json) removed 30 tagged audit clients, ten related requests and three pending CIMD audit requests. There were no audit token families or issued tokens. Readback shows zero tagged clients and zero pending CIMD audit requests. Production was not touched by cleanup.

Reproduce read-only discovery with `curl -s https://dev.sidequest.exchange/.well-known/oauth-authorization-server` and `curl -i -H 'Origin: https://inspector.example' https://dev.sidequest.exchange/.well-known/oauth-protected-resource/mcp`. Run `bun run smoke dev`; run `bun run drift dev` with the documented complete stage environment. In the audit conformance checkout: `npx tsx src/index.ts authorization --url https://dev.sidequest.exchange --scenario authorization-server-metadata-endpoint --output-dir /tmp/sidequest-oauth-conformance`.


## Production acceptance

Accepted runtime SHA `1a562ae727897a02f0ee82b9aed8bd1579825073` was pushed to `prod` under the overnight Sidequest lock. [Production CI 40194845004](https://github.com/grmkris/sidequest/actions/runs/40194845004) passed verify, deploy-prod, smoke and drift. A separate `bun run smoke prod` passed. Local drift, with the explicit prod guard enabled, refused before planning because the local stage env lacks `PIMLICO_API_KEY`; CI drift passed with protected credentials.

Production's sponsor Durable Object also briefly served the previous version after Worker deployment. By 12:58 UTC the new flags were visible, and the final read-only [production probe](prod-probe.json) reported no findings. [Production headers](prod-headers.json) confirm edge HTTPS/HSTS, foreign-Origin discovery, and retained consent-origin refusal. No production client registrations, consents, cleanup, wallet signatures or mainnet transactions were performed.

The dev evidence commit `41ae4298` also passed [CI 40194808490](https://github.com/grmkris/sidequest/actions/runs/40194808490). Later commits carry receipts only; production remains on the accepted runtime SHA above.
