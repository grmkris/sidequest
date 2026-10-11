# ADR-0012: Named agents, hosted MCP and website approvals

Date: 4 October 2026. Status: implemented; release and acceptance evidence is in
`docs/reality-check.md`. Mainnet is outside this change.

Sidequest's primary interface is the user's existing coding agent. A single
connector and skill supports both hiring and providing work. The website creates
or imports named agents, grants connector access, shows current observations,
and approves wallet operations.

## Identity and authority

The operator and each named agent have separate wallets. Privy creates an
additional embedded wallet; an external ERC-8004 agent can be imported after
proving ownership of its current registered wallet. Imported agents retain their
wallet and registry identity. Sidequest displays registry identity and platform
activity separately; it does not claim to import another platform's reputation.

Hosted MCP uses OAuth authorization-code flow with S256 PKCE, exact registered
redirects, explicit resource audiences and selected-agent grants. Access tokens
expire, refresh tokens rotate once, and agent generations fence revoked grants.
Website SIWE sessions do not authenticate the hosted MCP endpoint. Connector
scopes authorize board access; wallet authority is separate.

The existing Board Durable Object class stores management records in the
reserved `__sidequest_fleet_v1__` instance. This adds no class, namespace, D1
migration or infrastructure resource to the release graph. Job state remains in
the existing board objects; escrow and payment remain on-chain.

## Worker bootstrap

The shared skill installs a self-contained Node 22+ companion on Linux/macOS,
checks the versioned module against the emitted SHA-256 manifest, and pairs with
a single-use expiring code. The companion stores a locally generated P-256
authorization key in a mode-0600 file. It never receives the Ethereum private
key or the Privy application secret.

The current adapter launches an installed, authenticated Claude Code process
with its first prompt and a local wallet MCP. Startup is observed in order:
`launched`, MCP handshake `ready`, then signed `healthy` heartbeats. Challenges
are one-use, generation-bound and expiring. A stale observation is unknown
health, and a process exiting reports `stopped`. This does not establish paid
work completion or permission to spend.

## Economic operations

MCP wallet output is frozen into an owner approval with its selected wallet,
board, chain, calldata, terms and action hash. The website reviews it, reserves a
durable execution claim, and checks the wallet/network before signing. The local
browser journal preserves signatures and transaction outcomes across reloads.
An operation claimed in another browser cannot be sent again there.

Approval execution sends direct transactions. Batch and relay sponsorship are
disabled for this surface so each confirmed receipt matches one exact frozen
step. The API checks sender, target, calldata, value and successful receipt.
Selection is verified by the board before it is marked recorded; it does not
fund or activate a job. Failed reporting reconciles existing receipts.

## Automatic signing gate

The companion exposes only status, submit and dispute wallet tools. The real
Privy sign-only fixture proved direct submit restrictions, recovered signed
bytes, owner policy updates, signer revocation, and denial of altered requests.
It created a key-owned fixture; it did not establish a real browser user's
ownership and consent. No signed fixture transaction was broadcast.

Consequently `AUTONOMOUS_SIGNING_VERIFIED` stays false and pairing advertises
`gatewayEnabled: false`. Users approve submit/dispute on the website too. There
is no generic signing/execute path. Enabling automatic authority requires genuine
user-owned policy consent and live acceptance evidence; a fixture success alone
cannot enable it. EIP-7702 account code, Privy signer policies and ERC-7710
execution budgets remain separate authorities.

Telegram and MCP Apps were discussed as possible approval surfaces; neither is
added by this change. Existing Telegram behavior is preserved. Approval of an
action never means acceptance of paid work.

**Amendment, 11 Oct 2026.** The operator, not the client, chooses an agent's roles. A coding agent may connect before
any agent exists (a setup connection, scope `sidequest:setup`); that option is offered on every consent, whatever the
client requested. Work and Hire are chosen once, in the browser: on the consent page when the operator picks an
existing agent, or on the approval page when a setup connection's proposed agent is approved. The OAuth scopes a
client requests only pre-tick those choices, and the operator may narrow or widen them; every agent connection also
gets `sidequest:read`. Why: requesting role scopes made each client's setup command differ and let a client's request
silently fix what the operator could approve (Jonas's Codex onboarding on dev, 11 Oct).
