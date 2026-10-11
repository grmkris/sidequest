# ADR-0021: Agent roles and live MCP connections

Date: 2026-10-11. Status: accepted (Kris, 11 Oct). Supersedes the two 11 Oct amendments to
[ADR-0012](0012-agent-first-onboarding.md) where they conflict; amends its hosted MCP authorization.

## Context

Hosted MCP stored Work and Hire per OAuth connection, chosen at consent or approval. An agent with several
connections had several sets of roles, a role could only change by signing in again, and the server could not tell a
client that its tools had changed: replies were always JSON and the server declared `tools.listChanged: false`.
Onboarding showed the cost (Jonas, 11 Oct): reconnects that never became the agent, a chat that had no posting tools
after approval, and an object-form `_meta["mcp/www_authenticate"]` that matches neither the MCP specification nor
ChatGPT's convention. Goblin, a client Kris controls, implements MCP 2026-07-28, so the server can follow the
standard end to end.

## Decision

1. **Roles live on the agent.** Work and Hire are the agent's roles (`agents.permissions_json`), set by its operator
   on the approval page, at creation and on the agent page. A connection's OAuth scope is the client's upper bound,
   granted as requested; what a connection may do is its scope intersected with the agent's roles. Consent for an
   existing agent picks the agent only.
2. **Agents may ask.** `request_role` creates an operator approval of kind `role`; the role is added only when the
   operator approves. Removing a role refuses its start tools (Work: apply, submit_quote, prepare_activation,
   advertise_service, x402_pay, request_permissions, use_permission; Hire: create_task, request_quotes, pick_quote,
   select_worker). Tools that finish committed work or move the agent's own money stay while the scope allows.
3. **Two kinds of refusal.** A missing role is a plain tool error naming `request_role`: signing in again would not
   help. A missing scope is the MCP step-up: HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope",
   scope="<granted and needed>", resource_metadata="…"`, so a client can re-authorize for more. The object-form
   `_meta["mcp/www_authenticate"]` is removed.
4. **Live tool lists on the 2026 lane.** `server/discover` declares `tools.listChanged: true`; legacy `initialize`
   keeps `false`. A client that opens `subscriptions/listen` with `toolsListChanged` gets the exact list (scope,
   roles and setup state) and `notifications/tools/list_changed` whenever roles, approval, setup binding or a
   disconnect change it. The management Durable Object holds those streams and pushes at once. Any other connection
   gets the stable list, everything its scope covers, with clear refusals, so a client that never refreshes is never
   left with stale tools.
5. **Native approvals on the 2026 lane.** When a request declares URL elicitation, a tool that needs an operator
   approval (a new agent, a role, a hire over the allowance, an unstake, a wallet permission) answers
   `input_required` with an `elicitation/create` URL request instead of returning a link. The client retries with
   the same arguments; `requestState` is the approval's operation id (or the new agent's key) and is checked against
   the calling connection, so it needs no secret. Other clients keep the `approveUrl` result.
6. **Connections are visible.** The agent page lists each connection with its client, last use and scope, and can
   disconnect one, which also ends its webhooks and streams.

## Consequences

Existing agents keep both roles and existing connections keep their scopes, so nothing widens or narrows on deploy.
Codex and Claude Code do not yet re-authorize on a 403, so the refusal text tells the user how to reconnect.
Open streams keep the management Durable Object active; a deploy closes them and clients listen again.
