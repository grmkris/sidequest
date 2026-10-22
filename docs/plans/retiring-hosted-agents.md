# Retiring hosted agents

Date: 18 October 2026
Status: exploratory. No lifecycle change is decided. This records why a duplicate setup cannot leave the sidebar, and the smallest UI that would let an operator put it away.

Prompt: an operator registered one agent twice. One finished and was authorized. The other stayed on the setup screen. The app has no delete, and that unfinished record has no path to the existing stop control.

## What the app does now

A hosted agent moves `created` → `upgraded` → `grants-live` → `registered` → `active`, and any of those can go to `revoked`. `revoked` is terminal. The transition table is in [packages/board/src/agents.ts](../../packages/board/src/agents.ts). `stopAccess` accepts every state except one that is already revoked ([packages/board/src/agent-lifecycle.ts](../../packages/board/src/agent-lifecycle.ts)). The website action is `POST /api/agents/<id>/stop-access` ([apps/api/src/agent-management.ts](../../apps/api/src/agent-management.ts)).

Stopping ends hosted actions. It does not remove the row. Signer removal and on-chain disablement are later steps on the same agent. Open jobs stay on chain.

Where the operator sees the row:

| Surface | What it lists | Label | Where a row goes |
| --- | --- | --- | --- |
| Sidebar, **Your agents** | Every hosted agent, then **New agent** | Name only | An agent with an Agent ID opens `/agent/<id>`. One without an ID opens `/agents/new?resume=<id>`. |
| Services, **Your agents** chips | The same list | **Stopped** when revoked, otherwise **Setup not finished** when not active | Same links as the sidebar. |
| Phone tab bar | Services, Jobs, Commons | — | No per-agent list. |
| Coding-agent sign-in | `state === 'active'` only | Name and Agent ID | A duplicate that never became active is already absent here. |

Sources: [apps/explore/src/components/Shell.tsx](../../apps/explore/src/components/Shell.tsx), [apps/explore/src/managed.ts](../../apps/explore/src/managed.ts) (`agentHome`), [apps/explore/src/routes/Services.tsx](../../apps/explore/src/routes/Services.tsx), [apps/explore/src/components/OAuthConsent.tsx](../../apps/explore/src/components/OAuthConsent.tsx). `/agents` redirects to `/services` ([apps/explore/src/main.tsx](../../apps/explore/src/main.tsx)).

**Stop hosted access and revoke** lives on the agent's Manage tab, in the Access card ([apps/explore/src/components/agent/ManagedAgentCard.tsx](../../apps/explore/src/components/agent/ManagedAgentCard.tsx)). That page exists only after registration mints an Agent ID. Until then the chip and the sidebar open **Finish setting up your agent**, which only continues registration ([apps/explore/src/routes/AgentNew.tsx](../../apps/explore/src/routes/AgentNew.tsx), [apps/explore/src/components/agent/CreateAgent.tsx](../../apps/explore/src/components/agent/CreateAgent.tsx)). Continuing a duplicate mints a second ERC-8004 identity.

The identity registry is an ERC-721. Its ABI has `register` and `unsetAgentWallet`, and no burn ([contracts/abi/erc8004/IdentityRegistry.json](../../contracts/abi/erc8004/IdentityRegistry.json)). An Agent ID that was minted stays. A setup discarded before registration minted nothing.

## Three meanings that stay separate

- **Hide** is a view. The sidebar and the Services chips show the working set.
- **Stop** is the action that already exists. It sets `revoked`. Hosted access ends. The record remains so receipts, signer removal and open jobs can still be found.
- **Discard** is that same stop, offered on the setup screen, with calmer copy, for a record that never became active.

A second terminal state beside `revoked` would be another off switch. Grants that were still live under a "retired" flag would be the failure mode. The [glossary](../../GLOSSARY.md) does not gain a term until a decision says otherwise.

## Proposed UI

The sidebar is the working set. Stopped and unfinished agents live on one operator page. The setup screen can discard a duplicate before it becomes an identity.

### Sidebar shows agents you can use

Keep active agents, then **New agent**. When anything else exists, add one quiet row, such as **2 unfinished**. That row opens the list below. Apply the same rule to the Services chips, so a stopped or half-registered agent does not sit in the marketplace strip. Sign-in already follows this rule.

### The setup screen can discard itself

On **Finish setting up your agent**, beside **Continue setting up**, add **Discard this setup**.

- If registration never finished, the confirm says hosted access ends and no identity is minted.
- If an Agent ID already exists, the confirm says the number stays, hosted access ends, and the agent page remains for anything still on chain.

After discard the chip reads **Stopped** on the archive page and leaves the sidebar. Do not offer a control that claims the Agent ID was deleted.

### One list holds the rest

**Your agents** is an operator page, separate from Services. Services stays the directory of what agents offer. Three groups:

| Group | Rows | Action |
| --- | --- | --- |
| In use | `active` | Open the agent page |
| Setting up | `created` through `registered`, not revoked | Continue setup, or discard |
| Stopped | `revoked` | Name, Agent ID when there is one, when access stopped, link to reconcile signer removal and open jobs |

Stopped starts collapsed. A discarded setup with no Agent ID has no public page, so that row is the whole record. A stopped agent that already took or posted work keeps `/agent/<id>`, because the chain record is still there.

The phone has no per-agent sidebar. This page, reached from Services and from the sidebar's quiet row, is the phone surface too.

## Out of scope

- Burning or hiding an ERC-8004 identity. The registry does not support it. `unsetAgentWallet` is a separate wallet change, not retirement.
- Removing the hosted row. Revocation receipts and open jobs need the record.
- Changing OAuth consent. It already lists active agents only.
- A new agent state, a new grant status, or a migration. Discard calls the existing `stop-access` action.
