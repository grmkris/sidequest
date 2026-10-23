# ADR-0030: Workload assertions connect an operator-owned agent

Status: proposed (spike)

Date: 2026-10-23

## Context

An unattended MCP caller needs an agent identity without an interactive OAuth consent or a stored bearer token.
The MCP client-credentials extension recommends the RFC 7523 JWT bearer grant. OIDC UI supplies a shared
issuer/claims policy contract, but a matching workload identity alone must not grant operator authority.

## Decision

Behind `WORKLOAD_OIDC_ENABLED=1` (default off), an operator may attach an OIDC policy and explicit scope cap to an
active agent they own. Save and verification use the same OIDC UI validation contract. The spike pins audience,
subject and MCP resource; the GitHub form also pins repository, branch and workflow. Policies live in additive
SQLite tables in the management object defined by [ADR-0013](0013-agent-authority.md).

The token endpoint accepts a signed workload assertion with the policy ID as `client_id`. It verifies the exact
issuer, discovery, signature, lifetime and every saved claim, then atomically consumes the issuer/JTI pair and
issues an opaque five-minute access token. There is no refresh token. Scope is bounded by the policy and the
agent's current roles. Only read, work and hire scopes are supported; operator decisions and Commons maintenance
remain outside this grant. Existing signing, spending approval and execution checks still apply.

Disabling or deleting trust prevents issuance and revokes its existing OAuth families. Resolution also checks the
live policy and feature flag. The existing [ADR-0021](0021-agent-roles-live-mcp.md) distinction between missing role
and `403 insufficient_scope` remains. A workload cannot expand its policy by following a step-up challenge; an
operator must explicitly grant more access and it must exchange a fresh assertion.

## Consequences

The management object's transaction keeps replay consumption and token issuance together and rechecks policy and
roles after asynchronous verification. Each exchange creates an OAuth family visible in the existing connected
clients UI. Requiring `jti`, `sub`, `iat`, `exp` and a maximum ten-minute assertion lifetime deliberately narrows the
set of issuers supported by the spike. Discovery accepts HTTPS and same-origin JWKS only.

Production still needs issuer/egress restrictions, rate and storage limits, cached discovery/JWKS with rotation
tests, a retention policy for expired families, and local Workerd coverage with the feature enabled. See
[SPIKE_RESULTS.md](../../SPIKE_RESULTS.md) for evidence and rollout questions. This proposal authorizes no rollout.
