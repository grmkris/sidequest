import { describe, expect, it } from 'vitest'
import { deployment, stack } from '../deployment.ts'
import { buildGrant, describeGrant, periodTransferTerms, workTargets } from './grants.ts'
import { agentWalletTypes } from '../registry.ts'
import { delegationHash } from './index.ts'
import { createERC20TokenPeriodTransferTerms } from '@metamask/delegation-core'
import { encodePacked, pad } from 'viem'

const d = deployment('monad-testnet')
const ctx = { deployment: d, stack: stack(d, 'main') }
const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const now = 1_800_000_000

describe('spec v2 grant templates', () => {
  it('encodes MetaMask period terms byte-for-byte', () => {
    const token = d.rewardTokens[0]!
    const actual = periodTransferTerms(token, 25_000_000n, 604800, now)
    const expected = createERC20TokenPeriodTransferTerms({
      tokenAddress: token,
      periodAmount: 25_000_000n,
      periodDuration: 604800,
      startDate: now,
    })
    expect(actual).toBe(expected.toLowerCase())
    expect(actual).toBe(
      encodePacked(
        ['address', 'uint256', 'uint256', 'uint256'],
        [token, 25_000_000n, 604800n, BigInt(now)],
      ).toLowerCase(),
    )
  })

  it('builds an allowance pinned to the agent, token and fixed period', () => {
    const grant = buildGrant(ctx, {
      kind: 'allowance',
      delegator: operator,
      agent,
      token: d.rewardTokens[0]!,
      amount: 25_000_000n,
      salt: 1n,
      start: now,
    })
    const description = describeGrant(
      ctx,
      {
        kind: 'allowance',
        delegator: operator,
        agent,
        token: d.rewardTokens[0]!,
        amount: 25_000_000n,
        salt: 1n,
        start: now,
      },
      grant,
    )
    expect(description).toMatchObject({
      kind: 'allowance',
      delegate: agent,
      recipient: agent,
      amount: '25000000',
      periodSeconds: 604800,
      expiresAt: now + 30 * 86400,
    })
    expect(
      grant.caveats.some(
        (caveat) => caveat.enforcer.toLowerCase() === d.delegation.enforcers.erc20PeriodTransfer.toLowerCase(),
      ),
    ).toBe(true)
  })

  it('builds a separate gas allowance only for configured USDC', () => {
    const spec = {
      kind: 'gas-allowance' as const,
      delegator: operator,
      agent,
      token: d.aa!.gasToken,
      amount: 5_000_000n,
      periodSeconds: 7 * 86400,
      salt: 9n,
      start: now,
    }
    const grant = buildGrant(ctx, spec)
    expect(describeGrant(ctx, spec, grant)).toMatchObject({
      kind: 'gas-allowance',
      amount: '5000000',
      periodSeconds: 7 * 86400,
      calls: null,
      recipient: agent,
    })
    expect(() => buildGrant(ctx, { ...spec, token: d.rewardTokens[0]! })).toThrow('configured USDC')
  })

  it('does not accept a mutated grant', () => {
    const spec = { kind: 'registration' as const, delegator: operator, salt: 2n, start: now }
    const grant = buildGrant(ctx, spec)
    expect(() => describeGrant(ctx, spec, { ...grant, delegate: agent })).toThrow('approved template')
    expect(delegationHash(grant)).not.toBe(delegationHash({ ...grant, delegate: agent }))
  })

  it('pins one-off token approval to Holding, the exact amount, one call and ten minutes', () => {
    const token = '0x3333333333333333333333333333333333333333' as const
    const spec = {
      kind: 'agent-approve-once' as const,
      delegator: agent,
      token,
      amount: 17n,
      operationId: `0x${'12'.repeat(32)}` as const,
      salt: 11n,
      start: now,
    }
    const grant = buildGrant(ctx, spec)
    expect(describeGrant(ctx, spec, grant)).toMatchObject({
      delegate: d.relay,
      recipient: ctx.stack.holding,
      token,
      amount: '17',
      calls: 1,
      expiresAt: now + 600,
    })
    const pins = grant.caveats.filter(
      (item) => item.enforcer.toLowerCase() === d.delegation.enforcers.allowedCalldata.toLowerCase(),
    )
    expect(pins).toHaveLength(2)
    expect(pins[1]!.terms).toBe(encodePacked(['uint256', 'uint256'], [36n, 17n]))
    expect(() => describeGrant(ctx, { ...spec, amount: 18n }, grant)).toThrow('approved template')
  })

  it('publishes the ERC-8004 consent schema for the registry signer', () => {
    expect(agentWalletTypes.AgentWalletSet.map((field) => field.name)).toEqual([
      'agentId',
      'newWallet',
      'owner',
      'deadline',
    ])
  })

  it('keeps vault recovery separate from one approved exact self-position exit', () => {
    expect(workTargets(ctx).find((target) => target.address === d.sidequest!.vault)?.methods).toEqual([
      'cancelUndelegate',
      'withdraw',
    ])
    const spec = {
      kind: 'unstake' as const,
      delegator: agent,
      shares: 17n,
      operationId: `0x${'12'.repeat(32)}` as const,
      salt: 12n,
      start: now,
    }
    const grant = buildGrant(ctx, spec)
    expect(describeGrant(ctx, spec, grant)).toMatchObject({ calls: 1, expiresAt: now + 600 })
    const pins = grant.caveats.filter(
      (c) => c.enforcer.toLowerCase() === d.delegation.enforcers.allowedCalldata.toLowerCase(),
    )
    expect(pins.map((c) => c.terms)).toEqual([
      encodePacked(['uint256', 'bytes32'], [4n, pad(agent)]),
      encodePacked(['uint256', 'uint256'], [36n, 17n]),
    ])
    expect(() => describeGrant(ctx, { ...spec, shares: 18n }, grant)).toThrow('approved template')
  })
})
