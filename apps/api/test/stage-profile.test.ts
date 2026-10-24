import { afterEach, expect, test, vi } from 'vitest'
import { encodeAbiParameters, getAddress, pad, parseAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { stageProfile, validateStageProfile } from '../../../infra/stage.ts'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import { deploymentFromConfig, type DeploymentConfig } from '@sidequest/sdk'
import { rpcUrlForNetwork } from '../src/network.ts'
import { assertDeployConfig, assertTestnetProdConfig, sameOrigin } from '../src/deploy-preflight.ts'
import { validateReleaseProbe } from '../src/prod-config.ts'
import { assertLiveRelease, stateMode } from '../../../scripts/sidequest/state.ts'

afterEach(() => vi.unstubAllEnvs())

test('Commons is enabled by validated roles: dev and prod each with a moderator and their maintainers', () => {
  expect(stageProfile('dev')?.roles).toEqual({
    moderator: ['0xe834D5B7b9703E0BFB8a756Eb27bd9B4e41D1373'],
    maintainer: ['0x5f3D114a607b5bBB71a2E11Ba045fC9f4F239Ce7', '0xF1f2Aa797e63690045F506464bcb329Fc3f526d4'],
  })
  expect(stageProfile('prod')?.roles).toEqual({
    moderator: ['0xaC7F8233dc0CC8F613F73c220dFf2c1D7809f504'],
    maintainer: ['0x45873F5286159eEF49De386ED74446190B1cBb64'],
  })
  for (const roles of [null, {}, { moderator: [], maintainer: ['invalid'] }, { moderator: 'invalid', maintainer: [] }])
    expect(() => validateStageProfile({ ...stageProfile('dev'), roles }, 'dev')).toThrow()
})

test('the media team (ADR-0029): Kris operates media on both stages; profiles refuse malformed teams', () => {
  const kris = { wallet: '0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471', role: 'operator' }
  expect(stageProfile('prod')?.media?.team).toEqual([kris])
  expect(stageProfile('dev')?.media?.team).toContainEqual(kris)
  for (const stage of ['dev', 'prod'] as const) {
    expect(stageProfile(stage)?.media?.timezone).toBe('Europe/Ljubljana')
    expect(stageProfile(stage)?.resources.Media).toBe(`sidequest-${stage}-media`)
  }
  const dev = stageProfile('dev')!
  const media = dev.media!
  for (const bad of [
    { ...media, team: [{ wallet: 'invalid', role: 'operator' }] },
    { ...media, team: [{ ...kris, role: 'owner' }] },
    { ...media, team: [kris, { ...kris, wallet: kris.wallet.toLowerCase() }] },
    { ...media, timezone: 'Mars/Olympus' },
    { ...media, pullHosts: ['https://media.sidequest.exchange'] },
  ])
    expect(() => validateStageProfile({ ...dev, media: bad }, 'dev')).toThrow()
  expect(() => validateStageProfile({ ...dev, resources: { ...dev.resources, Media: '' } }, 'dev')).toThrow()
})

test('dev (testnet) and prod (mainnet since 13 Oct) profiles own distinct resources and domains', () => {
  for (const stage of ['dev', 'prod'] as const) {
    const p = stageProfile(stage)!
    expect(p.network).toBe(stage === 'dev' ? 'monad-testnet' : 'monad-mainnet')
    expect(p.chainId).toBe(stage === 'dev' ? 10143 : 143)
    expect(p.resources.Api).toBe(`sidequest-api-${stage}`)
    expect(p.resources.Database).toBe(`sidequest-${stage}-db`)
    expect(new URL(p.origin).hostname).toBe(stage === 'dev' ? 'dev.sidequest.exchange' : 'sidequest.exchange')
  }
  const dev = stageProfile('dev')!
  expect(deploymentFromConfig(dev.network, testnet as unknown as DeploymentConfig).stacks.main?.holding).toBe(
    testnet.deployment.main.holding,
  )
  expect(stageProfile('prod')!.relay).toBeUndefined()
  expect(stageProfile('local')).toBeUndefined()
  expect(() => stageProfile('staging')).toThrow('Unknown')
})

test('flipping the prod profile selects mainnet contracts, plain RPC, and the artifact preflight', async () => {
  const { relay: _relay, ...profile } = stageProfile('prod')!
  const p = validateStageProfile({ ...profile, network: 'monad-mainnet', chainId: 143 }, 'prod')
  expect(p.relay).toBeUndefined()
  const config: DeploymentConfig = {
    ...structuredClone(testnet),
    network: 'monad-mainnet',
    chainId: 143,
  } as unknown as DeploymentConfig
  if (config.deployment?.sidequest) delete config.deployment.sidequest.clocks
  // Like its fast clocks, testnet's own paymaster is refused on chain 143.
  delete config.accountAbstraction
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

test('testnet prod checks chain, stage signer keys and all four owners without mainnet clocks', async () => {
  const relayKey = `0x${'1'.repeat(64)}` as const,
    attesterKey = `0x${'2'.repeat(64)}` as const
  // Prod runs mainnet since 13 Oct; this is the testnet-prod path (prod on testnet, as before the launch).
  const p = {
    ...stageProfile('prod')!,
    network: 'monad-testnet' as const,
    chainId: 10143,
    relay: privateKeyToAccount(relayKey).address,
  }
  const config = { ...testnet, roles: { ...testnet.roles, attester: privateKeyToAccount(attesterKey).address } }
  const signerKey = `0x${'3'.repeat(64)}` as const
  const env = {
    MONAD_RPC_URL: 'https://rpc.example',
    RELAY_PRIVATE_KEY: relayKey,
    ATTESTER_PRIVATE_KEY: attesterKey,
    PIMLICO_API_KEY: 'pim_test',
    TESTNET_PAYMASTER_SIGNER_KEY: signerKey,
  }
  // The chain and Pimlico answer eth_chainId; Pimlico also lists the EntryPoint (ADR-0023).
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const asked = await new Request('https://rpc.test', init).text()
    const entryPoints = [testnet.accountAbstraction.entryPoint]
    return Response.json({ result: asked.includes('eth_supportedEntryPoints') ? entryPoints : '0x279f' })
  }) as unknown as typeof fetch
  const signerWord = pad(privateKeyToAccount(signerKey).address)
  // getDepositInfo: 1 MON deposit, staked, 1 MON stake, a day's delay, no withdrawal.
  const depositInfo = encodeAbiParameters(parseAbiParameters('uint256, bool, uint112, uint32, uint48'), [
    10n ** 18n,
    true,
    10n ** 18n,
    86_400,
    0,
  ])
  const ownerWord = pad(getAddress(testnet.deployment.sidequest.safe))
  const call = vi.fn(async (_to: string, data: `0x${string}`) =>
    data.startsWith('0x238ac933') ? signerWord : data.startsWith('0x5287ce12') ? depositInfo : ownerWord,
  )
  const reader = () => ({
    call,
    code: async () => '0x01',
    balance: async () => 0n,
    storage: async () => '0x00' as `0x${string}`,
  })
  await assertTestnetProdConfig(p, config, env, fetcher, reader)
  expect(call).toHaveBeenCalledTimes(6)
  await expect(
    assertTestnetProdConfig(p, config, { ...env, TESTNET_PAYMASTER_SIGNER_KEY: attesterKey }, fetcher, reader),
  ).rejects.toThrow("signer is not the Worker's key")
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

test('the reviewed artifact names the RPC provider by origin, so the keyed URL stays in the secret', () => {
  const provider = 'https://monad-mainnet.provider.example'
  expect(sameOrigin(`${provider}/v2/a-key`, provider)).toBe(true)
  expect(sameOrigin(`${provider}/v2/a-key`, `${provider}/`)).toBe(true)
  expect(sameOrigin('https://rpc.monad.xyz', provider)).toBe(false)
  expect(sameOrigin(`http://monad-mainnet.provider.example/v2/a-key`, provider)).toBe(false)
  expect(sameOrigin('not a url', 'not a url')).toBe(false)
})
