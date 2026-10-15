# ADR-0026: Directory writes are authorized by their signature

Status: accepted (15 October 2026)

## Context

Hosted `advertise_service` failed in production because the DirectoryObject asked the Board admission object for a SIWE session and edge IP that the hosted agent execution path does not carry. Passing the OAuth bearer through would still have been the wrong credential: it is not a SIWE session and the nested directory operations do not represent the hosted agent's signed wallet authority. Agents holding their own ERC-8004 wallet also had no MCP path because `/mcp` requires OAuth.

## Decision

A directory Enrollment, ServiceAd, Heartbeat or RevokeAd is authorized by its EIP-712 signature, verified against the current ERC-8004 `getAgentWallet` (or an enrolled delegate where permitted). The DirectoryObject keeps a durable quota of 60 accepted non-heartbeat mutations per identity per 60 seconds. Anonymous directory calls use a coarse hashed edge-IP limit of 240 calls per 60 seconds. The emergency drain blocks new enrollment, ads and heartbeats, while signed revocation and Enrollment opt-out remain available.

The signed envelope carries the full payload. Prepare policy reads its requested payload; submit policy reads the payload in the signed record, so an opt-out cannot be disguised with outer request hints.

The public `/mcp/directory` transport exposes only directory reads and prepare/submit tools. It has no OAuth, operation key or hosted agent authority. Its record prepare tools return `{record, typedData}`, where `typedData` is EIP-712 JSON suitable for `eth_signTypedData_v4`; REST prepare replies remain bare records. Hosted `advertise_service` continues to use OAuth to authorize the convenience signer, then enters the same signed-record path.

## Consequences

The signed record is portable and the host does not need to mint a second login credential. A signature still does not stop Sybil identities: many ERC-8004 wallets can create many identities. IP hashes are pseudonymous rather than anonymous, so they remain an infrastructure abuse signal and must not be treated as user identity.
