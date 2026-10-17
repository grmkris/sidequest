# ADR-0016: Dev and prod stages; prod cut over to mainnet

Date: 2026-10-07. Status: accepted.

## Context

Sidequest needs a stable public origin while the contracts, hosted board and operator evidence remain testnet-only. A
retired staging release system and legacy protocol pairs must not be mistaken for current deployment state.

## Decision

`dev` is `https://dev.sidequest.exchange` on Monad testnet (chain 10143), and `prod` is
`https://sidequest.exchange` on Monad mainnet (chain 143) after the October 2026 launch gate. Work is merged on `dev`; an
accepted SHA is promoted manually to `prod` with Kris's explicit approval. The profile in `infra/<stage>.json` owns origin,
network, relay, bot and resource names. Both stages use the shared remote Alchemy state store and release guard. The
mainnet cutover changed the prod profile and contract config together, followed by a guarded deploy and live readback.

## Consequences

Public prod exercises the v1 mainnet path while dev remains a testnet practice stage. Deploy commands have a clear approval
boundary, and old staging names or legacy pairs cannot enter current documentation. Local work remains isolated under the
`local` stage.

The pre-launch testnet arrangement described above was the state of this decision before the October 2026 cutover. The
runbook keeps the launch evidence and transaction procedure as historical records; current network and ownership facts come
from the stage profile, production artifact and reality check.
