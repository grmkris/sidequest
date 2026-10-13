import { readFileSync } from 'node:fs'
import { ARBITER_LAUNCH_MON } from '@sidequest/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import { stageProfile } from '../../../infra/stage.ts'
import { aaFromConfig } from '@sidequest/sdk'
import { assertAccountAbstraction } from './aa-preflight.ts'
import { MAINNET_LIVE } from '@sidequest/sdk'
import {
  liveLaunchGate,
  opensAdmission,
  mainnetProdSecretSources,
  safePolicy,
  validateAdmissionMode,
  validateExploreRelease,
  validateProdConfig,
  validateReleaseProbe,
  type ChainConfig,
  type LaunchReader,
  type ProdArtifact,
  type SafePolicy,
} from './prod-config.ts'
import type { LaunchAaProbe } from './launch-gas.ts'
import { hostedSendMode } from '@sidequest/sdk'

/** JSON-RPC reads only (eth_getCode, eth_call, eth_getBalance, eth_getStorageAt at latest). Any transport, HTTP or RPC
 *  error throws. */
export function rpcReader(url: string): LaunchReader {
  let id = 0
  const rpc = async (method: string, params: unknown[]): Promise<string> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as { result?: unknown; error?: unknown }
    if (
      !response.ok ||
      body.error !== undefined ||
      typeof body.result !== 'string' ||
      !/^0x[0-9a-fA-F]*$/.test(body.result)
    )
      throw new Error('read failed')
    return body.result
  }
  return {
    code: (address) => rpc('eth_getCode', [address, 'latest']),
    call: async (to, data) => (await rpc('eth_call', [{ to, data }, 'latest'])) as `0x${string}`,
    balance: async (address) => BigInt(await rpc('eth_getBalance', [address, 'latest'])),
    storage: async (address, slot) => (await rpc('eth_getStorageAt', [address, slot, 'latest'])) as `0x${string}`,
  }
}

/** The chain an RPC answers for (`eth_chainId`); throws on any transport or HTTP failure. */
async function rpcChainId(rpc: string, fetcher: typeof fetch): Promise<number> {
  const response = await fetcher(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('RPC failed')
  // SAFETY: a JSON-RPC answer is an object; a missing or malformed result becomes NaN, which matches no chain.
  return Number(((await response.json()) as { result?: string }).result)
}

/** Whether two URLs share an origin. The committed artifact names an RPC provider by its origin; the keyed URL for it
 *  stays in a secret. A URL that does not parse matches nothing. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** D16: refuse a deploy that would open production admission unless the live launch predicates hold. A deploy that pins
 *  an explicit drained `PROD_ADMISSION_DRAIN` (setup or emergency) does not need them. Runs before any resource. */
export async function assertLaunchGate(
  config: ChainConfig,
  drain: string | undefined,
  reader: LaunchReader,
  policy: SafePolicy | undefined,
  aaProbe?: LaunchAaProbe,
): Promise<void> {
  if (!opensAdmission(drain)) return
  const failures = await liveLaunchGate(config, reader, ARBITER_LAUNCH_MON, policy, aaProbe)
  if (failures.length > 0) throw new Error(`production launch gate refused: ${failures.join(', ')}`)
}

export async function assertDeployConfig(stage: string, profile = stageProfile(stage)): Promise<void> {
  const network = profile?.network ?? process.env.SIDEQUEST_NETWORK ?? 'monad-testnet'
  if (stage !== 'prod' && network !== 'monad-mainnet') return
  if (stage !== 'prod' || process.env.SIDEQUEST_STAGE !== stage) throw new Error('production stage/network mismatch')
  if (network === 'monad-testnet') {
    await assertTestnetProdConfig(profile!, testnet)
    return
  }
  hostedSendMode('monad-mainnet', process.env.HOSTED_SEND)
  const path = process.env.SIDEQUEST_PROD_ARTIFACT
  if (path === undefined || !path.endsWith('.json'))
    throw new Error('production needs an explicit reviewed JSON artifact')
  let artifact: ProdArtifact
  try {
    artifact = JSON.parse(readFileSync(path, 'utf8')) as ProdArtifact
  } catch {
    throw new Error('production artifact is unreadable or invalid JSON')
  }
  let failures: string[]
  try {
    failures = [
      ...validateProdConfig(mainnet, artifact),
      ...validateAdmissionMode(artifact, process.env.PROD_ADMISSION_DRAIN),
      ...validateExploreRelease(artifact, MAINNET_LIVE),
    ]
  } catch {
    throw new Error('production artifact has missing or invalid fields')
  }
  if (failures.length > 0) throw new Error(`production preflight rejected: ${failures.join(', ')}`)
  if (process.env.ALCHEMY_REMOTE_STATE !== '1') throw new Error('production requires remote state')
  if (process.env.PRIVY_APP_ID !== artifact.privy.appId || process.env.HYPERSYNC_URL !== artifact.hyperSync.url)
    throw new Error('production provider/Privy runtime mapping mismatch')
  for (const [binding, source] of Object.entries(mainnetProdSecretSources)) {
    const value = process.env[source]
    if (value === undefined || value === '' || value === 'unset')
      throw new Error(`production secret source missing: ${binding}`)
  }
  for (const [source, role] of [['ATTESTER_PRIVATE_KEY', 'attester']] as const) {
    let matches = false
    try {
      matches =
        privateKeyToAccount(process.env[source] as `0x${string}`).address.toLowerCase() ===
        mainnet.roles[role].toLowerCase()
    } catch {
      throw new Error(`production signing source invalid: ${role}`)
    }
    if (!matches) throw new Error(`production signing address mismatch: ${role}`)
  }
  const rpc = process.env.MONAD_RPC_URL
  if (rpc === undefined || !sameOrigin(rpc, artifact.rpc.url))
    throw new Error('production RPC runtime mapping mismatch')
  if ((await rpcChainId(rpc, fetch).catch(() => undefined)) !== 143)
    throw new Error('production read-only RPC chain proof failed')
  const aa = aaFromConfig(mainnet)
  await assertAccountAbstraction('production', {
    aa,
    chainId: 143,
    env: process.env,
    fetcher: fetch,
    reader: rpcReader(rpc),
  })
  await assertLaunchGate(mainnet, process.env.PROD_ADMISSION_DRAIN, rpcReader(rpc), safePolicy(artifact), {
    env: process.env,
    fetcher: fetch,
  })
}

/** Testnet prod deliberately keeps writes open, but proves its stage relay and the v1 ownership boundary. */
export async function assertTestnetProdConfig(
  profile: NonNullable<ReturnType<typeof stageProfile>>,
  config: typeof testnet,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  readerFactory = rpcReader,
): Promise<void> {
  if (profile.network !== 'monad-testnet' || profile.chainId !== 10143)
    throw new Error('production stage/network mismatch')
  const rpc = env.MONAD_RPC_URL
  if (rpc === undefined || rpc === '') throw new Error('testnet production needs MONAD_RPC_URL')
  let chainId: number
  try {
    chainId = await rpcChainId(rpc, fetcher)
  } catch {
    throw new Error('testnet production RPC chain proof failed')
  }
  if (chainId !== 10143) throw new Error('testnet production RPC chain mismatch')
  for (const [source, expected, label] of [
    ['RELAY_PRIVATE_KEY', profile.relay ?? '', 'relay'],
    ['ATTESTER_PRIVATE_KEY', config.roles.attester, 'attester'],
  ] as const) {
    try {
      if (privateKeyToAccount(env[source] as `0x${string}`).address.toLowerCase() !== expected.toLowerCase())
        throw new Error('mismatch')
    } catch {
      throw new Error(`testnet production signing address mismatch: ${label}`)
    }
  }
  const safe = config.deployment.sidequest?.safe
  const addresses = config.deployment.sidequest
  if (safe === undefined || addresses === undefined)
    throw new Error('testnet production deployment is missing Sidequest v1')
  const reader = readerFactory(rpc)
  const ownerAbi = '0x8da5cb5b' as `0x${string}`
  for (const [label, address] of [
    ['vault', addresses.vault],
    ['feeSchedule', addresses.feeSchedule],
    ['holding', config.deployment.main.holding],
    ['evaluator', config.deployment.main.evaluator],
  ] as const) {
    try {
      const raw = await reader.call(address, ownerAbi)
      const owner = `0x${raw.slice(-40)}`
      if (owner.toLowerCase() !== safe.toLowerCase()) throw new Error('owner mismatch')
    } catch {
      throw new Error(`testnet production Safe ownership check failed: ${label}`)
    }
  }
  await assertAccountAbstraction('testnet production', {
    aa: aaFromConfig(config),
    chainId: 10143,
    env,
    fetcher,
    reader,
  })
}

/** Post-deploy (PROD-GATE-006): GET `<origin>/release.json` and compare it to the artifact. A failed fetch or a body that
 *  is not JSON fails; returns labels only. */
export async function probeRelease(
  artifact: Pick<ProdArtifact, 'network' | 'explore'>,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  let url: URL
  try {
    url = new URL('/release.json', origin)
  } catch {
    return ['release.json origin invalid']
  }
  let served: unknown
  try {
    const request = {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    } as const
    const response = await fetcher(url, request)
    if (!response.ok) return ['release.json unreachable']
    served = await response.json()
  } catch {
    return ['release.json unreachable']
  }
  return validateReleaseProbe(artifact, served)
}
