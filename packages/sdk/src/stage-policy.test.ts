import { expect, test } from 'vitest'
import { authorityPolicy, RELAY_ADDRESSES } from '../scripts/privy/policy.ts'
import { stageProfile } from '../../../infra/stage.ts'
test('routine Privy policy permits exactly the two stage relays', () => {
  const delegationRule = authorityPolicy('admin', 'monad-testnet').rules.find(
    (candidate) => candidate.name === 'Allow Delegation',
  )!
  expect(delegationRule!.conditions.find((condition) => condition.field === 'delegate')).toMatchObject({
    operator: 'in',
    value: [...RELAY_ADDRESSES],
  })
  expect(RELAY_ADDRESSES).toEqual([stageProfile('dev')!.relay, stageProfile('prod')!.relay])
})
