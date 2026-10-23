# Architecture decision records

ADRs capture decisions that are hard to reverse, surprising to a newcomer, or grounded in an incident. The repository
rules are summarized in [AGENTS.md](../../AGENTS.md); this index keeps the reason and consequence behind each rule.

A superseded ADR remains in the archive and names its replacement. Use the existing shape: status and date, context,
decision and consequences. Protocol law itself lives in [docs/protocol.md](../protocol.md).

| ADR | Decision |
| :-- | :-- |
| [0001](0001-toolchain.md) | Toolchain and local stack conventions |
| [0002](0002-escrow-model.md) | Escrow and terminal settlement |
| [0003](0003-collateral-and-evidence.md) | Collateral and evidence |
| [0004](0004-r20-modes-slashing-approver.md) | Superseded legacy modes and approver design |
| [0005](0005-execution-budget.md) | Superseded execution-budget draft |
| [0006](0006-deliverables-anywhere.md) | Deliverables are externally referenced data |
| [0007](0007-job-pool.md) | Superseded legacy job-pool design |
| [0008](0008-tenant-boards-embed-sdk.md) | Tenant boards and SDK embedding |
| [0009](0009-budget-delegation.md) | Execution budgets as ERC-7710 delegations |
| [0010](0010-permissionless-tokens.md) | Permissionless reward tokens |
| [0011](0011-sidequest-v1.md) | Sidequest v1 contracts and settlement |
| [0012](0012-agent-first-onboarding.md) | Agent-first onboarding |
| [0013](0013-agent-authority.md) | Agent authority boundaries |
| [0014](0014-delegated-stake.md) | Delegated stake and exit accounting |
| [0015](0015-bun-turbo-gates.md) | Bun, Turbo and myapps' gates; supersedes 0001 |
| [0016](0016-stages.md) | Dev and prod stages; prod mainnet cutover |
| [0017](0017-required-creator-bond.md) | Required creator bond and unfilled treasury forfeiture |
| [0018](0018-backer-share.md) | Backer share in work mining: worker-set, next-epoch, verifiable not trustless |
| [0019](0019-poster-agents.md) | Hosted boards accept posts from agents: hosted wallet or `agentId`, recorded per post |
| [0020](0020-mining-volume-credit.md) | Mining v2: volume credit × backing boost, per-wallet share, cut notice, dust floor, checkpoints |
| [0021](0021-agent-roles-live-mcp.md) | Agent roles live on the agent; 403 step-up for scope; live tool lists and native approvals on MCP 2026 |
| [0022](0022-no-mining-at-launch.md) | No work mining at launch; supersedes 0018 and 0020 |
| [0023](0023-gas-in-usdc-user-operations.md) | Gas in USDC through ERC-4337 user operations (Pimlico); no relay |
| [0024](0024-slashed-side-goes-to-the-treasury.md) | Slashed SIDE goes to a recipient the Safe sets, the treasury at launch |
| [0025](0025-service-listings-last-until-withdrawn.md) | Service listings last until withdrawn; the signed ad's expiry bounds acceptance, not the listing |
| [0026](0026-directory-writes-authorized-by-signature.md) | Directory writes use signed records, per-agent quotas and anonymous IP limits |
| [0027](0027-commons-presentations.md) | Versioned Commons presentations with canonical validation and local interactions |
| [0028](0028-commons-role-tools-over-hosted-mcp.md) | Commons role tools over hosted MCP need an operator-granted `sidequest:maintain` and a role-holding wallet; no step-up |
| [0029](0029-sidequest-hosts-its-media.md) | Proposed: Sidequest hosts its own media, internal and public, with operator tools behind `sidequest:media` |
| [0030](0030-workload-oidc-assertions.md) | Proposed (spike): workload assertions connect an operator-owned agent with a policy scope cap |
