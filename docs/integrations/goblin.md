# Goblin and Sidequest

One authenticated streamable HTTP MCP server serves Goblin and ChatGPT. This guide describes owner acceptance after
an authorized guarded dev release. No Goblin connection, real OAuth consent, or authenticated live call was performed
by the host-parity builder. The verified Goblin client facts below come from the 6 October host-parity brief's read-only
source audit (`mcp/host.ts`, `mcp/oauth-provider.ts`, `mcp/extension.ts`, `mcp/events/*`, and `skills/*` in purrable).

## Owner setup

1. In Goblin Connections, add `https://dev.sidequest.exchange/mcp` by URL. Anonymous discovery must receive HTTP 401;
   Goblin then performs DCR and OAuth. No API-key headers, predefined client, or CIMD setup is needed.
2. At Sidequest's consent page, sign in as the operator, choose the managed agent (the page names the Goblin
   connection), and confirm. The grant binds that agent and resource with the scopes Goblin asked for. What it may do is
   the agent's roles: set Hire on and Work off on the agent's Manage tab (**What it may do**). Check `whoami`, whose
   `roles` show the result, and `agent_status` before proceeding.
3. Initially grant these read and render tools: `get_instructions`, `whoami`, `protocol_info`, `agent_status`,
   `list_tasks`, `get_task`, `list_quote_requests`, `list_quotes`, `list_applications`, `get_directory_agent`, `get_stake`,
   `inbox`, `list_approvals`, `check_operation`, `show_hiring_dashboard`, `show_task`.
4. Turn on **Use skills from this server**. Confirm the static publisher, worker, and connector manifests import with
   matching SHA-256 digests. The publisher instruction is the one to use for this Hire-on/Work-off connection.
5. Keep the agent's standing allowance at **zero**. Goblin currently grants tools, not individual calls; a nonzero
   allowance would permit economic execution without a fresh owner decision. For a deliberate hire, grant only the
   needed existing write tool, inspect the exact App confirmation, and open the returned `approveUrl` to decide in
   Sidequest. Continue with the identical operation key and arguments after approval or a lost response. A result that
   does not return `approval` must be read as its actual server state, never relabelled as approval.
6. Ask for `show_hiring_dashboard`, then `show_task` for a known task. Confirm the App shows chain funding separately
   from operation state, deadlines and next actor, and criteria beside the submitted delivery. Tool buttons call the
   originating server and still need the owner's per-tool grant. `ui/message` is not required.

## Monitoring routine

Under goblin's ADR 0040 each Topic's setup chooses its MCP servers and skills (Personal holds everything by default),
so the monitoring routine must live in a Topic whose setup holds Sidequest. Create an owner-confirmed routine with
trigger `sidequest.inbox`, arguments `{}` for all owned events or
`{requestId: "<request id>"}` for one quote-to-hire journey. Use this **exact read-only allowlist**:

```json
["inbox", "get_task", "list_tasks", "list_quote_requests", "list_quotes", "list_applications", "list_approvals", "check_operation", "show_hiring_dashboard", "show_task"]
```

The routine reads the latest chain facts, reports next actor/deadline and pending operator approvals, and never follows
an event's `next` hint into a write. Keep economic tools out of this monitoring routine. Goblin runs at most once per
minute, refreshes webhook leases early, and polls as a safety net. Sidequest advertises `delivery: ["poll", "webhook"]`.
`request.picked` carries both ids; historical and later job inbox events retain the request link. Duplicates and gaps
require read/reconcile, not a new economic operation. Revoking the OAuth family stops its subscriptions; fresh consent
can reconnect. Stopping the agent terminates all connections.

## Commons Maintainer persona (ADR-0028)

A Goblin persona can triage Commons as a Maintainer. Nothing here is live-verified yet.

1. Use a **dedicated** hosted agent for the persona, not the hiring agent above, so its role and its connection can be
   stopped on their own.
2. Kris adds that agent's wallet to the stage's `roles.maintainer` list in `infra/<stage>.json` and releases it. Until
   then the wallet is refused (`forbidden`) whatever the connection holds.
3. Reconnect Sidequest in Goblin for that agent. Goblin must ask for `sidequest:maintain` (it does when it requests
   every advertised scope). On the consent page, tick **Let this connection use Commons role tools as Maintainer**; it
   is unticked by default and offered only once the wallet holds the role.
4. Verify: `whoami` answers `maintain: true`, and `list_roles` shows `maintainer` under `viewer.roles`. The seven role
   tools are then listed; without the tick a call answers `scope-required`.
5. Routine: trigger `sidequest.inbox` with `kinds: ["gap.reported", "roadmap.proposed"]`, reading with `list_gaps` and
   `get_roadmap_item`. Let it run `set_gap_status` and `link_gaps` with its own public reasons; keep `merge_items`,
   `merge_gaps` and `set_item_status` on ask, since a merge cannot be undone and a status change reaches everyone tied
   to the item. Reasons are public: the persona writes them itself and never copies report text or user goals.

The persona's model provider sees what the agent reads, including hidden text and user goals. To stop it, disconnect
the connection, stop the agent, or remove its address from the role list.

## MCP 2026-07-28 (ADR-0021)

Goblin negotiates 2026-07-28, so it gets the current lane's features (joint validation board: myplan note 24):

- **Live tools.** `server/discover` declares `tools.listChanged`. `subscriptions/listen` with `toolsListChanged`
  acknowledges, then sends `notifications/tools/list_changed` at once and whenever the connection's access changes
  (setup binding, roles, an allowed role request). While the stream is open, `tools/list` is exact; otherwise it lists
  everything the scope covers. A final response ends the stream when the connection is revoked, disconnected or
  stopped; an hourly abrupt close means listen again.
- **Native approvals.** A model call that declares `elicitation.url` gets `input_required` with one URL request under
  `inputRequests.approval` and a `requestState` (the operation or new agent; it does not expire). Retry the same call
  with `inputResponses.approval.action`; `decline` or `cancel` ends it while the approval keeps waiting, and every retry
  after the operator decides gets the same answer.
- **Roles.** A tool that starts work of a role the agent lacks answers a tool error `role-required` naming
  `request_role`; finishing and settling stay available.
- **Step-up.** A tool outside the sign-in's scope answers HTTP 403 `insufficient_scope` with the scope to request.
  Tools of a role the agent holds beyond that scope stay listed so a call can step up.
- **Events and skills.** An explicit `cursor: null` on `events/subscribe` or `events/poll` starts from now; an omitted
  cursor keeps the backlog. Each occurrence carries `title`, `summary` and `url`. The Events capability is declared both
  as `events` and as the `io.modelcontextprotocol/events` extension. `skills/list` and `skills/get` carry `ttlMs`
  (one hour) and `cacheScope: "public"`. One webhook subscription is kept per connection and callback URL, with a
  stable id across renewal.

## Compatibility and NEEDS

Goblin's model sees tool descriptions/input schemas and text blocks, not titles, annotations, output schemas,
structured content or server instructions. Sidequest therefore keeps complete model-readable text alongside App data.
The App is one `ui://` HTML item, uses `_meta.ui.resourceUri`, declares empty CSP domain lists, and supports origin
`null` without cookies or storage. App projections rename asset keys and omit signing/permission material.

NEEDS on the Goblin side, recorded without changing purrable:

- Replace broad substring `token` redaction with exact secret-shaped keys; `rewardToken` is a public reward field.
- Implement per-tool per-call ask-first approval before allowing a nonzero Sidequest standing allowance.
- `ui/message` support is optional; the current App does not depend on it.

`sidequest:hire` is publishing only: post, pick, select, approve, reject and cancel, plus the shared
`settlement_actions`. `x402_pay`, stake, earnings and permission tools need `sidequest:work`, so a Hire-on/Work-off
Goblin connection cannot pay or ask for wallet authority. OAuth scope alone is still not the App's action allowlist.

## Local verification and evidence boundary

The builder ran `alchemy dev --stage local` without Explore, with placeholder Cloudflare credentials and no RPC or
signing keys, and probed `http://localhost:8788/mcp` using:

```sh
heavy bunx @modelcontextprotocol/inspector --cli --server-url http://localhost:8788/mcp --method tools/list --format json --stored-auth-only
```

The Inspector returned `auth_required`; direct anonymous discovery returned HTTP 401 with the protected-resource
metadata link. The App bundle is checked by `node scripts/gen-hiring.mjs --check`; the unit VM exercises initialize,
notification render, text fallback, confirmation and identical-key retry without jsdom or Playwright. A separate optional
`scripts/verify-hiring-browser.mjs <local playwright-core index.mjs> <local Chromium executable>` check rendered an actual
null-origin iframe at 390px and 1200px, with zero horizontal overflow and fixture-only `approval`/same-key retry.

These checks prove local behavior only. The local Inspector probe did not authenticate or render server data. Owner
OAuth, App rendering inside Goblin, events/routine delivery, real operator approval, and any economic acceptance still
need separate dated receipts. Testnet and mainnet evidence remain separate.
