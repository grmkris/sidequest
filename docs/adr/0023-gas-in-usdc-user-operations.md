# ADR-0023: Gas in USDC through ERC-4337 user operations; no relay

Date: 2026-10-12. Status: accepted (Kris, 12 Oct). Being implemented; see "State" below. It amends
[ADR-0009](0009-budget-delegation.md), [ADR-0011](0011-sidequest-v1.md) and [ADR-0013](0013-agent-authority.md)
wherever they have the relay EOA send or pay for something.

## Context

One relay EOA paid MON gas for nearly every onchain action:
- hosted agents' actions (ERC-7710 delegations the relay redeemed);
- owners' and agents' EIP-7702 upgrades, and sponsored registration;
- browser "sponsorship" grants;
- evidence attestations and arbiter rulings;
- testnet drips.

That made one hot key a funding dependency and a single point of failure for every stage. It also meant Sidequest
paid everyone's gas.

Goblin had just proven the alternative on Base mainnet. An agent on MetaMask's EIP7702StatelessDeleGator, signing
through Privy's `eth_signUserOperation`, sent an ERC-4337 v0.7 user operation and paid 0.008 USDC of gas through
Pimlico's ERC-20 paymaster, holding no ETH. The same contracts are deployed on Monad 143 and 10143, and Pimlico serves
both.

## Decision

- **No relay on any stage.** Every onchain action is a user operation (EntryPoint v0.7) sent through Pimlico's bundler
  from the acting account. Gas is paid in USDC by whoever acts. USDC is the only gas token.
- **The account** is the DeleGator the EOA already delegates to.
  - The call data is its ERC-7579 batch `execute`.
  - It signs its own EIP-712 `PackedUserOperation` digest, not the userOpHash.
  - An undelegated EOA's first operation carries `eip7702Auth`.
- **Nonces.** Each operation has its own 2D nonce lane (`nonceKey(operationId)`, sequence 0). Every attempt at one
  operation shares the nonce, so at most one lands. The signed operation and its hash are persisted before the send,
  and the board reconciles the lane before any retry.
- **Hosted agents** send from their own DeleGator account.
  - Gas comes from an operator **gas allowance**: USDC, an ERC20PeriodTransfer of 5 USDC per week by default,
    editable. It is separate from the reward allowance, and the agent pulls a small float from it.
  - Privy's `eth_signUserOperation` rules pin every inner call by contract, function and constant arguments. The board
    checks the rest: sender, nonce lane, paymaster, cost ceiling and per-agent arguments.
  - Earnings leave an agent only through `AgentSweep`, to the current owner of its ERC-8004 identity.
- **Browser users** send user operations paying USDC from their own balance. A user who holds MON but no USDC sends
  plain transactions paying MON.
- **Rulings:** the arbitrator key sends `ruleWithSignature` itself and keeps a small MON float.
- **Evidence:** the board returns the signed attestation, and the worker attaches it in its own submit batch.
- **Paymasters.**
  - Mainnet uses Pimlico's ERC-20 paymaster `0x7777…834C` with Circle USDC.
  - Testnet uses our `SidequestTestnetPaymaster`, because Pimlico has no ERC-20 paymaster tokens there. It charges
    Circle testnet USDC at a fixed rate, against a quote the Worker signs.
  - Pimlico's free testnet sponsorship covers faucet claims, so a new tester needs no MON.
  - The Pimlico key stays server-side. The browser reaches Pimlico only through the API's `/aa/rpc` proxy, which has a
    method allowlist and on mainnet never sponsors.
- **Smart sessions are not adopted.** ERC-7579 smart sessions are early, and they do not fit the DeleGator, which
  cannot install modules. MetaMask's operator-as-delegator pattern (the allowances) plus AgentSweep covers the same
  limits.

## Consequences

- No Sidequest key pays anyone's gas, and there is no relay float to watch. The paymaster's deposit (testnet) and the
  arbitrator's MON float are the only balances ops must monitor.
- Every acting account needs a little USDC. On Monad an action costs about 0.001 USDC, because gas is billed on the
  limit and margins stay tight.
- Existing hosted agents pause with "add a gas budget" until their operator signs a gas allowance. We sign for the
  crew's operators.
- **Residual risk of a backend compromise:**
  - protocol-mediated spending of an agent's own balance;
  - gas burned up to the paymaster approval;
  - x402 payments up to their caps.

  Operator money stays capped onchain by the allowances.
- The relay code, its secrets, `roles.relay`, the `sponsor_*` tools and the sponsorship routes are deleted once both
  stages run on this path. Their tables stay, because migrations are additive.

## State (12 Oct 2026)

**Live on testnet:**
- the bundler path with a 7702 authorization;
- the Privy user-operation rules (routine policy, 37 rules);
- `SidequestTestnetPaymaster` `0x998D…38C9`, deployed, funded and staked.

**On `dev`:** the SDK core (`packages/sdk/src/aa`), the hosted agents' Privy signer, and AgentSweep (not yet
deployed).

**In progress:** the Worker's quote signer and `/aa/rpc`, the board's user-operation desk and executor, Explore's user
operations, rulings and evidence. Evidence is in [reality-check](../reality-check.md).
