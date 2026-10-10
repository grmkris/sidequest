import { afterEach, expect, test, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { stageProfile, validateStageProfile } from '../../../infra/stage.ts'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import { deploymentFromConfig, type DeploymentConfig } from '@sidequest/sdk'
import { rpcUrlForNetwork } from '../src/network.ts'
import { assertDeployConfig, assertTestnetProdConfig } from '../src/deploy-preflight.ts'
import { validateReleaseProbe } from '../src/prod-config.ts'
import { assertLiveRelease, stateMode } from '../../../scripts/sidequest/state.ts'

afterEach(() => vi.unstubAllEnvs())

test('Commons is enabled by validated dev roles and absent in prod', () => {
  expect(stageProfile('dev')?.roles).toEqual({
    moderator: ['0xe834D5B7b9703E0BFB8a756Eb27bd9B4e41D1373'],
    maintainer: ['0x5f3D114a607b5bBB71a2E11Ba045fC9f4F239Ce7', '0x77aEBfcCc5D10fDD4ca9A351B8D0eB75385BbC32'],
  })
  expect(stageProfile('prod')?.roles).toBeUndefined()
  for (const roles of [null, {}, { moderator: [], maintainer: ['invalid'] }, { moderator: 'invalid', maintainer: [] }])
    expect(() => validateStageProfile({ ...stageProfile('dev'), roles }, 'dev')).toThrow()
})

test('dev and prod dry profiles own distinct resources/domains on the same testnet deployment', () => {
  for (const stage of ['dev', 'prod'] as const) {
    const p = stageProfile(stage)!
    expect(p.network).toBe('monad-testnet')
    expect(p.chainId).toBe(10143)
    expect(p.resources.Api).toBe(`sidequest-api-${stage}`)
    expect(p.resources.Database).toBe(`sidequest-${stage}-db`)
    expect(new URL(p.origin).hostname).toBe(stage === 'dev' ? 'dev.sidequest.exchange' : 'sidequest.exchange')
    expect(deploymentFromConfig(p.network, testnet as unknown as DeploymentConfig).stacks.main?.holding).toBe(
      testnet.deployment.main.holding,
    )
  }
  expect(stageProfile('local')).toBeUndefined()
  expect(() => stageProfile('staging')).toThrow('Unknown')
})

test('flipping the prod profile selects mainnet contracts, plain RPC, and the artifact preflight', async () => {
  const p = validateStageProfile({ ...stageProfile('prod'), network: 'monad-mainnet', chainId: 143 }, 'prod')
  const config: DeploymentConfig = {
    ...structuredClone(testnet),
    network: 'monad-mainnet',
    chainId: 143,
  } as unknown as DeploymentConfig
  if (config.deployment?.sidequest) delete config.deployment.sidequest.clocks
  // Mainnet is not deployed yet: use distinct fixture addresses to prove profile
  // resolution selects the supplied mainnet deployment rather than testnet pins.
  config.deployment!.main!.holding = '0x1111111111111111111111111111111111111111'
  const resolved = deploymentFromConfig(p.network, config)
  expect(resolved.chainId).toBe(143)
  expect(resolved.stacks.main!.holding).toBe(config.deployment!.main!.holding)
  expect(resolved.stacks.main!.holding).not.toBe(testnet.deployment.main.holding)
  expect(rpcUrlForNetwork({ SIDEQUEST_STAGE: 'prod', MONAD_RPC_URL: 'https://rpc.example/mainnet' })).toBe(
    'https://rpc.example/mainnet',
  )
  vi.stubEnv('SIDEQUEST_STAGE', 'prod')
  vi.stubEnv('SIDEQUEST_PROD_ARTIFACT', '')
  await expect(assertDeployConfig('prod', p)).rejects.toThrow('explicit reviewed JSON artifact')
})

test('live gate requires the matching stage, remote state, migrations, and complete stack', () => {
  const env = {
    SIDEQUEST_RELEASE: '1',
    SIDEQUEST_STAGE: 'prod',
    SIDEQUEST_APPLY_MIGRATIONS: '1',
    ALCHEMY_REMOTE_STATE: '1',
  }
  expect(stateMode(env)).toBe('remote')
  expect(stateMode({ ...env, SIDEQUEST_STAGE: 'dev' })).toBe('remote')
  expect(stateMode({ SIDEQUEST_STAGE: 'dev' })).toBe('remote')
  expect(stateMode({ SIDEQUEST_STAGE: 'prod', SIDEQUEST_NETWORK: 'monad-mainnet' })).toBe('remote')
  expect(stateMode({ SIDEQUEST_STAGE: 'local' })).toBe('local')
  expect(stateMode({ SIDEQUEST_STAGE: 'prod', NODE_ENV: 'test' })).toBe('local')
  expect(() => assertLiveRelease('prod', 'remote', env)).not.toThrow()
  for (const patch of [
    { SIDEQUEST_RELEASE: '0' },
    { SIDEQUEST_STAGE: 'dev' },
    { SIDEQUEST_APPLY_MIGRATIONS: '0' },
    { SIDEQUEST_WITHOUT_EXPLORE: '0' },
  ]) {
    expect(() => assertLiveRelease('prod', 'remote', { ...env, ...patch })).toThrow()
  }
  expect(() => assertLiveRelease('prod', 'local', env)).toThrow('remote')
  expect(rpcUrlForNetwork({ SIDEQUEST_STAGE: 'prod', MONAD_TESTNET_RPC_URL: 'https://old.example' })).toBeUndefined()
})

test('testnet prod checks chain, stage signer keys and all six owners without mainnet clocks', async () => {
  const relayKey = `0x${'1'.repeat(64)}` as const,
    attesterKey = `0x${'2'.repeat(64)}` as const
  const p = { ...stageProfile('prod')!, relay: privateKeyToAccount(relayKey).address }
  const config = { ...testnet, roles: { ...testnet.roles, attester: privateKeyToAccount(attesterKey).address } }
  const env = { MONAD_RPC_URL: 'https://rpc.example', RELAY_PRIVATE_KEY: relayKey, ATTESTER_PRIVATE_KEY: attesterKey }
  const fetcher = vi.fn(async () => Response.json({ result: '0x279f' })) as unknown as typeof fetch
  const call = vi.fn(async () => `0x${testnet.deployment.sidequest.safe.slice(2).padStart(64, '0')}` as `0x${string}`)
  const reader = () => ({
    call,
    code: async () => '0x01',
    balance: async () => 0n,
    storage: async () => '0x00' as `0x${string}`,
  })
  await assertTestnetProdConfig(p, config, env, fetcher, reader)
  expect(call).toHaveBeenCalledTimes(6)
  await expect(
    assertTestnetProdConfig(p, config, { ...env, RELAY_PRIVATE_KEY: attesterKey }, fetcher, reader),
  ).rejects.toThrow('relay')
  const wrongChain = (async () => Response.json({ result: '0x8f' })) as typeof fetch
  await expect(assertTestnetProdConfig(p, config, env, wrongChain, reader)).rejects.toThrow('chain mismatch')
  call.mockResolvedValue(`0x${'0'.repeat(64)}`)
  await expect(assertTestnetProdConfig(p, config, env, fetcher, reader)).rejects.toThrow('ownership')
})

test('testnet prod release probe permits open writes with mainnetLive false', () => {
  expect(
    validateReleaseProbe(
      { network: 'monad-testnet', explore: { mainnetLive: false } },
      { network: 'monad-testnet', mainnetLive: false, writesOpen: true },
    ),
  ).toEqual([])
})
