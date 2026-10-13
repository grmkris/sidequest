import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { directoryDomainFields, directoryRecordFields } from '../../src/directory.ts'
import { X402_PAYMENT_CAP, authorityPolicy, config } from './policy.ts'
import { AGENT_RULES, agentRulesUpdate } from './update-agent-rules.ts'

type Rules = ReturnType<typeof authorityPolicy>['rules']
const desired = authorityPolicy('policy-admin', 'monad-testnet')
const rule = (name: string) => desired.rules.find((item) => item.name === name)!
function live(rules: Rules) {
  return {
    ...structuredClone(desired),
    id: 'policy-id',
    created_at: 1,
    rules: rules.map((item, index) => ({ ...structuredClone(item), id: `rule-${index}` })),
  }
}
const without = (names: readonly string[]) => desired.rules.filter((item) => !names.includes(item.name))

describe('hosted-agent Privy rules', () => {
  it('pins x402 to the chain, the configured USDC, the signer as payer and the per-payment cap', () => {
    expect(rule('Allow TransferWithAuthorization').conditions).toEqual([
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '10143' },
      {
        field_source: 'ethereum_typed_data_domain',
        field: 'verifyingContract',
        operator: 'eq',
        value: config.x402.usdc,
      },
      expect.objectContaining({
        field_source: 'ethereum_typed_data_message',
        field: 'from',
        operator: 'eq',
        value: '{{wallet.address}}',
      }),
      expect.objectContaining({
        field_source: 'ethereum_typed_data_message',
        field: 'value',
        operator: 'lte',
        value: X402_PAYMENT_CAP,
      }),
    ])
  })

  it('pins each directory record to the zero verifying contract, the signer wallet, the registry and version 1, with the salted domain schema', () => {
    for (const kind of ['Enrollment', 'ServiceAd', 'RevokeAd']) {
      const conditions = rule(`Allow ${kind}`).conditions as Array<Record<string, unknown>>
      expect(conditions.slice(0, 2)).toEqual([
        { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '10143' },
        { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: zeroAddress },
      ])
      expect(conditions.slice(2).map(({ field, operator, value }) => [field, operator, value])).toEqual([
        ['wallet', 'eq', '{{wallet.address}}'],
        ['identityRegistry', 'eq', config.erc8004.identity],
        ['version', 'eq', '1'],
      ])
      for (const condition of conditions.slice(2))
        expect(condition.typed_data).toEqual({
          types: { EIP712Domain: directoryDomainFields, [kind]: directoryRecordFields },
          primary_type: kind,
        })
    }
    expect(desired.rules.some((item) => item.name === 'Allow Heartbeat')).toBe(false)
    expect(desired.rules.at(-1)!.name).toBe('Deny export')
  })

  it('adds exactly the missing hosted-agent rules, also after a partial apply, and reports a current policy', () => {
    expect(agentRulesUpdate(live(without(AGENT_RULES)), desired)).toEqual({
      status: 'add',
      adding: [...AGENT_RULES],
      rules: desired.rules,
    })
    expect(agentRulesUpdate(live(without(['Allow ServiceAd'])), desired)).toMatchObject({
      status: 'add',
      adding: ['Allow ServiceAd'],
    })
    expect(agentRulesUpdate(live(desired.rules), desired)).toEqual({ status: 'current' })
  })

  it('refuses any other drift, including a new rule with other conditions', () => {
    const drifted = live(without(AGENT_RULES))
    ;(drifted.rules[0]!.conditions[1] as { value: string }).value = '0x1111111111111111111111111111111111111111'
    expect(() => agentRulesUpdate(drifted, desired)).toThrow(/drift/)
    const otherCap = live(
      desired.rules.map((item) =>
        item.name !== 'Allow TransferWithAuthorization'
          ? item
          : {
              ...item,
              conditions: item.conditions.map((condition) =>
                'field' in condition && condition.field === 'value' ? { ...condition, value: '9000000' } : condition,
              ),
            },
      ),
    )
    expect(() => agentRulesUpdate(otherCap, desired)).toThrow(/drift/)
    const extra = live([...desired.rules, { ...structuredClone(rule('Allow ServiceAd')), name: 'Allow Heartbeat' }])
    expect(() => agentRulesUpdate(extra, desired)).toThrow(/drift/)
  })
})
