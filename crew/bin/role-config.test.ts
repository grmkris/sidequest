import { expect, test } from 'bun:test'
import { stageProfile } from '../../infra/stage.ts'
import { roleEnvironment, roleLayout } from './role-config.ts'

const dev = stageProfile('dev')!
const mainnet = { ...stageProfile('prod')!, network: 'monad-mainnet' as const, chainId: 143 }
const inputs = {
  SIDEQUEST_DEV_ARBITRATOR_PRIVATE_KEY: 'testnet-fixture',
  SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: 'mainnet-fixture',
  MONAD_RPC_URL: 'https://mainnet-rpc.example',
  MONAD_TESTNET_RPC_URL: 'https://testnet-rpc.example',
  ARBITER_MODEL: 'fixture-model',
  CLIPROXY_API_KEY: 'fixture-model-key',
}

test('mainnet uses only its dedicated arbiter key and its stage board and RPC', () => {
  const env = roleEnvironment('arbiter', inputs, mainnet, 'https://model.example', [dev.origin])
  expect(env).toMatchObject({
    NETWORK: 'monad-mainnet',
    BOARD_URLS: mainnet.origin,
    SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: 'mainnet-fixture',
    MONAD_RPC_URL: inputs.MONAD_RPC_URL,
    ARBITER_RULING_DIR: '/state/arbiter-rulings',
  })
  expect(env.V1_ARBITRATOR_PRIVATE_KEY).toBeUndefined()
  expect(
    roleEnvironment('arbiter', { ...inputs, MONAD_RPC_URL: undefined }, mainnet, '', []).MONAD_RPC_URL,
  ).toBeUndefined()
  expect(() => roleEnvironment('moderator', inputs, mainnet, '', [])).toThrow('Only arbiter')
})

test('mainnet compose, pinned source and journal paths cannot replace the running testnet role', () => {
  const before = roleLayout('/repo', dev)
  const after = roleLayout('/repo', mainnet)
  expect(before.project).toBe('sidequest-roles')
  expect(before.tree).toBe('/repo.wt/roles')
  expect(after.suffix).toBe('-mainnet')
  for (const field of ['project', 'tree', 'composeFile', 'stateDir', 'envDir'] as const)
    expect(after[field]).not.toBe(before[field])
})

test('testnet retains the dev key and observes only testnet boards', () => {
  const env = roleEnvironment('arbiter', inputs, dev, '', [dev.origin])
  expect(env.NETWORK).toBe('monad-testnet')
  expect(env.V1_ARBITRATOR_PRIVATE_KEY).toBe('testnet-fixture')
  expect(env.BOARD_URLS).toBe(dev.origin)
  expect(env.SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY).toBeUndefined()
})
