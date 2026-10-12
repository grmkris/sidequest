import { describe, expect, it } from 'vitest'
import { authorityPolicy, config, userOpRules, userOpTargets } from '../scripts/privy/policy.ts'

type Condition = {
  readonly field_source: string
  readonly field: string
  readonly operator: string
  readonly value: unknown
}

const rule = (name: string): readonly Condition[] => {
  const found = userOpRules().find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no rule ${name}`)
  return found.conditions
}
const at = (conditions: readonly Condition[], source: string, field: string) =>
  conditions.find((condition) => condition.field_source === source && condition.field === field)

describe('the user-operation signing rules (ADR-0023)', () => {
  it('allow each work method only on its own contract, on this chain, with no native value', () => {
    for (const target of userOpTargets)
      for (const method of target.methods) {
        const conditions = rule(`Allow userOp ${target.name}.${method}`)
        expect(at(conditions, 'ethereum_transaction', 'chain_id')?.value).toBe('10143')
        expect(at(conditions, 'ethereum_transaction', 'to')?.value).toBe(target.to)
        expect(at(conditions, 'ethereum_transaction', 'value')).toMatchObject({ operator: 'lte', value: '0x0' })
        expect(at(conditions, 'ethereum_calldata', 'function_name')).toMatchObject({ operator: 'eq', value: method })
      }
  })

  it('pin every approval to the Holding, and allow no transfer', () => {
    const approve = rule('Allow userOp approve to the Holding')
    expect(at(approve, 'ethereum_calldata', 'approve.spender')?.value).toBe(config.deployment.main.holding)
    expect(userOpRules().some((candidate) => candidate.name.toLowerCase().includes('transfer'))).toBe(false)
  })

  it('are part of the routine signer policy the cutover applies', () => {
    const names = userOpRules().map((candidate) => candidate.name)
    const inPolicy = authorityPolicy('admin').rules.filter((candidate) => candidate.method === 'eth_signUserOperation')
    expect(inPolicy.map((candidate) => candidate.name)).toEqual(names)
  })
})
