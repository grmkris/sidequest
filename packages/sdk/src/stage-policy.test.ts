import { expect, test } from 'vitest'
import { authorityPolicy, config, RELAY_ADDRESSES } from '../scripts/privy/policy.ts'
import { stageProfile } from '../../../infra/stage.ts'
test('routine testnet Privy policy permits dev relay and the retired prod-testnet relay', () => {
  const delegationRule = authorityPolicy('admin', 'monad-testnet').rules.find(
    (candidate) => candidate.name === 'Allow Delegation',
  )!
  expect(delegationRule!.conditions.find((condition) => condition.field === 'delegate')).toMatchObject({
    operator: 'in',
    value: [...RELAY_ADDRESSES],
  })
  // Prod moved to mainnet on 13 Oct and has no relay; the live testnet policy still names its old one.
  expect(stageProfile('prod')!.relay).toBeUndefined()
  expect(RELAY_ADDRESSES).toEqual([stageProfile('dev')!.relay, ...config.roles.retiredRelays])
})
