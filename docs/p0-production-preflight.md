# Mainnet production preflight

Prod runs on Monad mainnet (143) since 13 October 2026, as declared in [stages](stages.md). The populated artifact is checked
against that deployment. The gate remains a repeatable preflight for production candidates; it does not authorize a
production deployment, custody change or mainnet transaction.

Run `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json` for a no-secret-value structural check. The current artifact
passes this check; missing provider chain proofs, Privy approval or contract addresses fail it.
Malformed input produces a generic diagnostic rather than echoing JSON. A synthetic passing fixture proves
validation logic only; it is not live deployment proof or approval.

The same script has three modes:

- **No flag (structural).** Validates the artifact against `contracts/config/monad-mainnet.json`. It also checks
  Explore's launch flag (PROD-GATE-006): the artifact's `explore.mainnetLive` must equal `MAINNET_LIVE` in
  `packages/sdk/src/release.ts` (re-exported by Explore). It must be false while `admission.drain` is true,
  and true before the artifact may open admission.
- **`--live`.** Additionally runs the D16 launch gate, read-only through the artifact's public RPC:
  - the Safe has code;
  - `owner()` is the Safe on all four v1 contracts;
  - the core admin roles are held by the Safe and not by the deployer;
  - the attester is a verifier;
  - the configured arbitrator has the `ARBITER_LAUNCH_MON` MON reserve;
  - the EntryPoint, Pimlico paymaster and USDC have code, and Pimlico serves chain 143, the configured EntryPoint and
    the configured USDC paymaster quote.
- **`--probe <origin>`.** After a deploy, compares `<origin>/release.json` with the artifact: network, `mainnetLive`,
  and `writesOpen` equal to `mainnetLive`. A redirect, a non-OK response, or a body that is not JSON fails.

A missing or empty `PROD_ADMISSION_DRAIN` means drained, and the artifact's admission mode must match the runtime
value. The launch order is in [mainnet-runbook.md](mainnet-runbook.md) §3.8–3.10.

The Alchemy stack calls `assertDeployConfig` before any resources are evaluated whenever either `prod` stage or
`monad-mainnet` is selected. Prod on testnet uses `assertTestnetProdConfig`: chain 10143, the stage relay, shared
attester, and Safe ownership of the six v1 contracts. Mainnet requires both prod and chain 143, with `SIDEQUEST_STAGE=prod`,
`ALCHEMY_REMOTE_STATE=1`, and an explicit `SIDEQUEST_PROD_ARTIFACT` JSON path. There is no production local-state
fallback. The artifact checks network/chain 143, provider URL/chain metadata, approved Privy app and origin,
addresses matching the chain config, no faucet, zero hold gates, USDC, open-token main Holding metadata,
the single v1 pair, and the plain stage secret source names in `mainnetProdSecretSources`. Deploy preflight also checks
the actual named sources, runtime Privy/HyperSync/RPC mappings, the attester public address, and read-only
RPC `eth_chainId`. Mainnet release assembly defaults hosted agents to `HOSTED_SEND=userop` and refuses relay mode;
testnet keeps its legacy relay compatibility. No secret values are printed.

Mainnet needs freshly approved role keys in the prod environment; a plain source name is not permission to reuse a
testnet key. The release runner assembles only the chosen stage environment. The API independently refuses a
mainnet/non-prod runtime stage. R2 force-destroy is disabled for mainnet, and Explore uses the prod stage mapping.

Still required before launch: independently verify actual HyperSync network, deployed code/bytecode hashes,
immutable roles, windows, fee settings, provider/domain mappings, D1/DO/R2 policies, and mainnet read-only
`protocol_info`. An artifact's chain/approval fields are assertions to review, not a substitute for those live
checks. Every production deployment, domain change, and mainnet transaction needs separate authorization.
