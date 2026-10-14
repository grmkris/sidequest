import { expect, test } from 'bun:test'
import { stageProfile } from '../../infra/stage.ts'
import { assertRoleOnNetwork, mergeCompose, roleEnvironment, roleLayout, roleTree, unusedTrees } from './role-config.ts'

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
  expect(
    roleEnvironment('arbiter', { ...inputs, MONAD_RPC_URL_MAINNET: 'https://mainnet-named.example' }, mainnet, '', [])
      .MONAD_RPC_URL,
  ).toBe('https://mainnet-named.example')
  expect(roleEnvironment('arbiter', { ...inputs, ARBITER_MODEL: undefined }, mainnet, '', []).ARBITER_MODEL).toBe(
    'meta/muse-spark-1.3',
  )
  expect(
    roleEnvironment('moderator', { ...inputs, MODERATOR_PRIVATE_KEY: 'moderator-fixture' }, mainnet, '', []),
  ).toMatchObject({
    NETWORK: 'monad-mainnet',
    BOARD_URL: mainnet.origin,
    MODERATOR_PRIVATE_KEY: 'moderator-fixture',
  })
  expect(() => roleEnvironment('maintainer', inputs, mainnet, '', [])).toThrow('not enabled on mainnet')
  expect(() => assertRoleOnNetwork('maintainer', dev)).not.toThrow()
})

test('each commit gets its own tree, so a new role never moves the source under a running one', () => {
  const layout = roleLayout('/repo', mainnet)
  const one = roleTree(layout, '7845027230153c51a625363ff41c0dd1571b8ef9')
  const two = roleTree(layout, '899f0ddbee1ce36e1d1261e09d538e870b54592f')
  expect(one).toBe('/repo.wt/roles-mainnet-784502723015')
  expect(two).not.toBe(one)
  expect(roleTree(roleLayout('/repo', dev), '899f0ddbee1ce36e1d1261e09d538e870b54592f')).toBe(
    '/repo.wt/roles-899f0ddbee1c',
  )
})

test('starting one role keeps every other role in the compose file, at its own commit and tree', () => {
  const layout = roleLayout('/repo', mainnet)
  const arbiter = { working_dir: '/repo.wt/roles-mainnet', labels: { 'sidequest.source': '78450272' } }
  const existing = {
    name: layout.project,
    services: { 'sq-arbiter-mainnet': arbiter },
    networks: { crew: { name: 'sidequest-crew', external: true } },
  }
  const moderator = { working_dir: '/repo.wt/roles-mainnet-899f0ddbee1c' }
  const merged = mergeCompose(existing, layout.project, { 'sq-moderator-mainnet': moderator })
  expect(merged.services['sq-arbiter-mainnet']).toEqual(arbiter)
  expect(merged.services['sq-moderator-mainnet']).toEqual(moderator)
  expect(merged.networks).toEqual(existing.networks)
  expect(mergeCompose(undefined, layout.project, { 'sq-moderator-mainnet': moderator }).services).toEqual({
    'sq-moderator-mainnet': moderator,
  })
})

test('prune only offers this stage’s per-commit trees that no role runs from', () => {
  const layout = roleLayout('/repo', dev)
  const compose = {
    name: layout.project,
    services: { 'sq-arbiter': { working_dir: '/repo.wt/roles-aaaaaaaaaaaa' } },
    networks: {},
  }
  const trees = [
    '/repo',
    '/repo.wt/roles',
    '/repo.wt/roles-aaaaaaaaaaaa',
    '/repo.wt/roles-bbbbbbbbbbbb',
    '/repo.wt/roles-mainnet',
    '/repo.wt/roles-mainnet-cccccccccccc',
  ]
  expect(unusedTrees(layout, compose, trees)).toEqual(['/repo.wt/roles-bbbbbbbbbbbb'])
  expect(unusedTrees(roleLayout('/repo', mainnet), undefined, trees)).toEqual(['/repo.wt/roles-mainnet-cccccccccccc'])
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

test('the maintainer runs Kimi through the AI Gateway with its own key, not the model gateway key', () => {
  const env = roleEnvironment(
    'maintainer',
    { ...inputs, AI_GATEWAY_API_KEY: 'gateway-fixture' },
    dev,
    'https://model.example',
    [],
  )
  expect(env).toMatchObject({
    MAINTAINER_MODEL: 'moonshotai/kimi-k3',
    MAINTAINER_MODEL_BASE_URL: 'https://ai-gateway.vercel.sh/v1',
    MAINTAINER_MODEL_API_KEY: 'gateway-fixture',
  })
  expect(roleEnvironment('moderator', inputs, dev, 'https://model.example', []).MODERATOR_MODEL_API_KEY).toBe(
    'fixture-model-key',
  )
})

test('testnet retains the dev key and observes only testnet boards', () => {
  const env = roleEnvironment('arbiter', inputs, dev, '', [dev.origin])
  expect(env.NETWORK).toBe('monad-testnet')
  expect(env.V1_ARBITRATOR_PRIVATE_KEY).toBe('testnet-fixture')
  expect(env.BOARD_URLS).toBe(dev.origin)
  expect(env.SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY).toBeUndefined()
})
