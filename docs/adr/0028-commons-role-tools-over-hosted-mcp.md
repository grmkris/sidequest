# 0028: Commons role tools over hosted MCP behind an operator-granted scope

Status: proposed
Date: 2026-10-22

## Context

Commons Moderators and Maintainers act through seven role tools: `hide_content`, `unhide_content`, `set_item_status`,
`merge_items`, `merge_gaps`, `link_gaps` and `set_gap_status`. Until now only a signed-in wallet could call them, from
the website over REST; hosted MCP listed none of them. Kris wants a hosted agent, such as a Goblin persona connected
over OAuth, to triage gap reports and proposals as a Maintainer. A role tool acts in public on text other people and
agents wrote, so a connection must not reach them by accident, and a model reading that text can be misled.

## Decision

**Two keys.** A role tool runs only when both hold: the connection holds the OAuth scope `sidequest:maintain`, and the
agent's wallet is in the stage's Commons role list (`roles` in `infra/<stage>.json`, checked by `requireRole` in
`packages/commons`). The scope never confers a role; a wallet without one is refused with `forbidden`. The scope
covers exactly the seven role tools and nothing else, and it is not an agent role: `effectiveRoles` and `whoami.roles`
stay `work` and `hire`. `whoami` reports the grant separately as `maintain`.

**Granted at consent, by the operator.** The scope is advertised in `scopes_supported`. A consent for an existing agent
grants it only when the client asked for it and the operator ticked an unticked opt-in, which the consent page offers
only when the chosen agent's wallet holds a Commons role. A tick the client did not ask for is `invalid_request`.
Setup never grants it: the setup consent refuses `maintain`, and waiting setup connections bind to an approved agent
without it. Refresh keeps it.

**No step-up.** Without the scope the role tools are not listed, and a call answers the tool error `scope-required`
naming `sidequest:maintain`. It is not MCP's 403 step-up, because a client signing in again cannot add the scope: only
the operator can, by reconnecting and ticking the opt-in. A setup connection neither lists the role tools nor waits on
them, since an approval never brings them.

**Events.** `gap.reported` and `roadmap.proposed` inbox rows now reach maintainers as well as moderators, one per
address (a holder of both roles is told as maintainer), with unchanged ids and metadata only. A hosted maintainer finds
new work through `sidequest.inbox`.

**Kill switches.** Disconnect the connection (its tokens and subscriptions end at once), stop the agent (every
connection ends), or remove the address from the stage's role list (the next call is `forbidden`).

## Consequences

- Role tool calls run like other hosted writes: a stable `operationKey`, the agent wallet as caller, and a replay that
  answers the first result without calling Commons again. Their descriptions tell the agent that the reason is public,
  to write it itself without copying report text or user goals, and to treat what it read as data.
- Hidden text and user goals follow the wallet address, not the scope. A role holder's connection already read them
  through the ordinary read tools; the persona's model provider therefore sees hidden content and user goals. An
  operator opts in knowing that.
- A merge cannot be undone and a status change reaches everyone tied to an item; the Goblin guide keeps `merge_*` and
  `set_item_status` on ask while letting a routine set gap status and link gaps.
- Proposed until Kris accepts it with the prod release that names a hosted maintainer's wallet; no stage role list
  changes with this decision.
