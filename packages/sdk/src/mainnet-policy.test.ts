import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import * as deployments from './deployment.ts'
import { authorityPolicy } from '../scripts/privy/policy.ts'
import { explicitNetwork } from '../scripts/privy/network.ts'
import { authorityRulesUpdate } from '../scripts/privy/setup.ts'

const fixtureAddress = (digit: string) => `0x${digit.repeat(40)}`

function promoted() {
  const address = fixtureAddress
  const factory = address('1')
  const source: deployments.DeploymentConfig = {
    ...mainnet,
    sidequest: { ...mainnet.sidequest, token: factory },
    deployment: {
      block: 100,
      core: address('2'),
      factory,
      main: { kind: 'sidequest-v1', factory, holding: address('3'), evaluator: address('4'), openTokens: true },
      sidequest: { block: 100, safe: address('5'), factory, vault: address('6'), feeSchedule: address('7') },
      agentSweep: address('8'),
      rewardTokens: [mainnet.x402.usdc, factory],
    },
  }
  return deployments.deploymentFromConfig('monad-mainnet', source)
}

afterEach(() => vi.restoreAllMocks())

test('the testnet generator stays byte-identical to the policy frozen before the network change', () => {
  const fixture = readFileSync(new URL('../scripts/privy/fixtures/testnet-policy.json', import.meta.url), 'utf8')
  // Freeze the bytes sent to Privy, independent of the repository formatter's JSON whitespace.
  const before = `${JSON.stringify(JSON.parse(fixture), null, 2)}\n`
  expect(`${JSON.stringify(authorityPolicy('snapshot-admin', 'monad-testnet'), null, 2)}\n`).toBe(before)
})

test('mainnet policy pins chain 143 and all promoted targets, and snapshots the paymaster cap', () => {
  const selected = promoted()
  vi.spyOn(deployments, 'deployment').mockImplementation((network) => {
    expect(network).toBe('monad-mainnet')
    return selected
  })
  const policy = authorityPolicy('snapshot-admin', 'monad-mainnet')
  for (const rule of policy.rules) {
    for (const condition of rule.conditions.filter((item) => item.field === 'chainId' || item.field === 'chain_id'))
      expect(condition.value).toBe('143')
  }
  expect(policy.rules.some((rule) => rule.name === 'Allow Delegation')).toBe(false)
  expect(policy).toMatchSnapshot()
})

test('mainnet generation refuses before Promote or before AgentSweep is recorded', () => {
  // The shipped mainnet config is promoted since 13 Oct; an unpromoted one makes `deployment` throw.
  vi.spyOn(deployments, 'deployment').mockImplementationOnce(() => {
    throw new Error('no deployment recorded')
  })
  expect(() => authorityPolicy('admin', 'monad-mainnet')).toThrow('requires a promoted deployment')
  vi.spyOn(deployments, 'deployment').mockReturnValue({ ...promoted(), agentSweep: null })
  expect(() => authorityPolicy('admin', 'monad-mainnet')).toThrow('AgentSweep')
})

test('authority commands require an explicit supported network', () => {
  expect(() => explicitNetwork(undefined)).toThrow('explicitly')
  expect(() => explicitNetwork('mainnet')).toThrow('explicitly')
  expect(explicitNetwork('monad-mainnet')).toBe('monad-mainnet')
})

test('policy updates add only exact missing rules and reject changed authority or calls', () => {
  const desired = authorityPolicy('admin', 'monad-testnet')
  expect(authorityRulesUpdate({ ...desired, id: 'policy' }, desired)).toBe(false)
  expect(authorityRulesUpdate({ ...desired, rules: desired.rules.slice(1) }, desired)).toBe(true)
  expect(() => authorityRulesUpdate({ ...desired, owner_id: 'someone-else' }, desired)).toThrow('authority drift')
  const changed = { ...desired.rules[0]!, action: 'DENY' }
  expect(() => authorityRulesUpdate({ ...desired, rules: [changed] }, desired)).toThrow('rule drift')
})
