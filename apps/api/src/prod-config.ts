import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { mainnetProdSecretSources } from '@sidequest/board/runtime'
import { PRODUCTION_CLOCKS, type DeploymentConfig, type SidequestClocks } from '@sidequest/sdk'
import { launchAaFailures, type LaunchAaProbe } from './launch-gas.ts'
export { mainnetProdSecretSources, runtimeSecret } from '@sidequest/board/runtime'

interface ProdStack {
  // JSON artifacts are validated at runtime below; keep this broad enough for
  // inferred JSON fixtures while the accepted values remain fail-closed.
  kind?: string | undefined
  factory?: string | null | undefined
  holding: string | null
  evaluator: string | null
  openTokens?: boolean | undefined
}

interface ProdSidequest {
  block: number | null
  safe?: string | null | undefined
  /** Artifact only (LAUNCH-AUDIT-003): the reviewed Safe owners and threshold that D16 reads back live. */
  safeOwners?: string[] | null | undefined
  safeThreshold?: number | null | undefined
  factory: string | null
  vault: string | null
  feeSchedule: string | null
}

export interface ProdArtifact {
  stage: string
  network: string
  chainId: number
  rpc: { url: string; chainId: number | null }
  hyperSync: { url: string; chainId: number | null }
  privy: { appId: string | null; origins: string[]; approved: boolean }
  remoteState: boolean
  /** Reviewed intended hosted admission mode. A runtime mismatch refuses deployment. */
  admission: { drain: boolean }
  /** Explore's launch flag, `MAINNET_LIVE` in `apps/explore/src/release.ts` (PROD-GATE-006): pinned and checked. */
  explore: { mainnetLive: boolean }
  secretSources: Record<string, string>
  addresses: Record<string, string | null>
  deployment: {
    main: ProdStack
    sidequest: ProdSidequest
    legacy?: Record<string, ProdStack> | undefined
    /** LAUNCH-AUDIT-004: the promoted reward-token list, which must contain USDC. */
    rewardTokens?: string[] | undefined
  }
}

/** D24 deploy-time clocks, in seconds; recipe constructors enforce the same bounds. */
export type LaunchClocks = SidequestClocks

/** The compiled production clocks (SidequestConstants), from the one SDK copy so the launch gate cannot drift. */
export const productionLaunchClocks: LaunchClocks = { ...PRODUCTION_CLOCKS }

export interface ChainConfig {
  network: string
  chainId: number
  roles: Record<string, string>
  erc8004: { identity: string; reputation: string }
  x402: { usdc: string }
  knownTokens: string[]
  accountAbstraction?: NonNullable<DeploymentConfig['accountAbstraction']>
  /** SidequestRecipe's input; the preflight reads the default arbitrator and clocks from it (LAUNCH-AUDIT-FIX-001). */
  sidequest?: {
    token?: string
    defaultArbitrator?: string | null
    clocks?: LaunchClocks
    minimumCreatorBond?: number
    maxMinimumCreatorBond?: number
    unfilledForfeitBps?: number
  } | null
  deployment: {
    network?: string
    block?: number
    core?: string
    factory?: string
    main?: ProdStack
    sidequest?: ProdSidequest
    demo?: ProdStack
    fast?: ProdStack
    legacy?: Record<string, ProdStack>
    rewardTokens?: string[]
  }
}

/** LAUNCH-AUDIT-008: the relay, attester and arbitrator of `contracts/config/monad-mainnet.json` as of 1 Oct, when the
 *  relay and attester keys were exposed and the arbitrator replaced with them. No active mainnet role may be one. */
export const RETIRED_ROLE_ADDRESSES = [
  '0xac7282b6a519665dcb71563317C71d1F357f9e7e',
  '0x66b72404Ad8ce4C650C4f67F13AAd1Ee82F2963f',
  '0xc657F023F938BB89de590Ed96f79B775c7dDd632',
] as const
const retired = (value: unknown) =>
  typeof value === 'string' && RETIRED_ROLE_ADDRESSES.some((old) => old.toLowerCase() === value.toLowerCase())

const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)
const mainnetUrl = (value: string, hyperSync = false) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/testnet|10143|localhost|127\.0\.0\.1/i.test(url.hostname) &&
      (!hyperSync || url.origin === 'https://monad.hypersync.xyz')
    )
  } catch {
    return false
  }
}

function validateCompleteProdConfig(config: ChainConfig, artifact: ProdArtifact): string[] {
  const failures: string[] = []
  const check = (valid: boolean, label: string) => {
    if (!valid) failures.push(label)
  }
  check(
    artifact.stage === 'prod' && artifact.network === 'monad-mainnet' && config.network === artifact.network,
    'stage/network',
  )
  check(
    config.chainId === 143 &&
      artifact.chainId === 143 &&
      artifact.rpc.chainId === 143 &&
      artifact.hyperSync.chainId === 143,
    'chain/providers',
  )
  check(mainnetUrl(artifact.rpc.url), 'rpc URL')
  check(mainnetUrl(artifact.hyperSync.url, true), 'HyperSync URL')
  check(artifact.remoteState === true, 'remote state')
  check(typeof artifact.admission?.drain === 'boolean', 'admission mode')
  check(
    artifact.privy.approved === true &&
      typeof artifact.privy.appId === 'string' &&
      artifact.privy.appId.length > 0 &&
      artifact.privy.origins.length > 0 &&
      artifact.privy.origins.every((origin) => origin === 'https://sidequest.exchange'),
    'Privy app/origin approval',
  )
  check(
    config.knownTokens.every(address) &&
      new Set(config.knownTokens.map((token) => token.toLowerCase())).size === config.knownTokens.length &&
      config.knownTokens.some((token) => token.toLowerCase() === config.x402.usdc.toLowerCase()),
    'known USDC',
  )
  const deployed = config.deployment
  // A drained USDC-only record predating SIDE remains valid. Once SIDE is selected for promotion, both lists need it.
  const side = config.sidequest?.token
  check(side === undefined || config.knownTokens.some((token) => same(token, side)), 'known SIDE')
  check(
    deployed.network === artifact.network && Number.isSafeInteger(deployed.block) && (deployed.block ?? 0) > 0,
    'deployment network/block',
  )
  check(deployed.main?.openTokens === true, 'open-token main Holding metadata')
  check(deployed.demo === undefined && deployed.fast === undefined, 'single v1 stack')
  check(deployed.main?.kind === 'sidequest-v1' && artifact.deployment.main.kind === 'sidequest-v1', 'main v1 kind')
  check(
    address(deployed.main?.factory) &&
      deployed.main.factory.toLowerCase() === deployed.factory?.toLowerCase() &&
      deployed.main.factory.toLowerCase() === deployed.sidequest?.factory?.toLowerCase(),
    'v1 factory consistency',
  )
  check(
    Object.keys(deployed.legacy ?? {}).length === 0 && Object.keys(artifact.deployment.legacy ?? {}).length === 0,
    'no mainnet legacy pairs',
  )
  const sidequest = deployed.sidequest
  check(
    sidequest !== undefined &&
      Number.isSafeInteger(sidequest.block) &&
      (sidequest.block ?? 0) > 0 &&
      artifact.deployment.sidequest.block === sidequest.block,
    'sidequest block',
  )
  // D16 / PROD-GATE-001: the Safe that must own everything is part of the reviewed record, in config and artifact.
  for (const name of ['safe', 'factory', 'vault', 'feeSchedule'] as const) {
    const value = sidequest?.[name]
    check(
      address(value) && artifact.deployment.sidequest[name]?.toLowerCase() === value.toLowerCase(),
      `sidequest:${name}`,
    )
  }
  const pinned = safePolicy(artifact)
  check(pinned !== undefined, 'sidequest:safeOwners/safeThreshold')
  for (const name of ['factory', 'holding', 'evaluator'] as const) {
    const value = deployed.main?.[name]
    check(address(value) && artifact.deployment.main[name]?.toLowerCase() === value.toLowerCase(), `main:${name}`)
  }
  check(artifact.deployment.main.openTokens === true, 'artifact main open tokens')
  // LAUNCH-AUDIT-004: the SDK and Explore take their reward tokens from this list; mainnet's must hold USDC, and the
  // artifact pins the same list.
  const rewards = (list: unknown) =>
    Array.isArray(list) && list.every(address) ? list.map((token) => token.toLowerCase()) : undefined
  const configRewards = rewards(deployed.rewardTokens)
  const artifactRewards = rewards(artifact.deployment.rewardTokens)
  check(
    configRewards !== undefined &&
      new Set(configRewards).size === configRewards.length &&
      configRewards.includes(config.x402.usdc.toLowerCase()),
    'rewardTokens:USDC',
  )
  check(side === undefined || configRewards?.includes(side.toLowerCase()) === true, 'rewardTokens:SIDE')
  check(
    configRewards === undefined ||
      (artifactRewards !== undefined &&
        artifactRewards.length === configRewards.length &&
        artifactRewards.every((token, i) => token === configRewards[i])),
    'artifact rewardTokens',
  )
  const expected = {
    ...config.roles,
    identity: config.erc8004.identity,
    reputation: config.erc8004.reputation,
    usdc: config.x402.usdc,
    core: deployed.core,
    factory: deployed.factory,
    holding: deployed.main?.holding,
    evaluator: deployed.main?.evaluator,
  }
  for (const [name, value] of Object.entries(expected)) {
    if (name === 'relay') continue
    check(address(value) && artifact.addresses[name]?.toLowerCase() === value.toLowerCase(), `address:${name}`)
  }
  for (const [name, value] of Object.entries(config.roles))
    if (name !== 'relay') check(!retired(value), `role:${name} is a retired 1 Oct key`)
  for (const [name, value] of Object.entries(artifact.addresses))
    if (name !== 'relay') check(!retired(value), `address:${name} is a retired 1 Oct key`)
  // LAUNCH-AUDIT-FIX-001: the recipe deploys the v1 Holding with sidequest.defaultArbitrator, and promotion checks the
  // Holding's defaultArbitrator() against it; so it must be roles.arbitrator, and never a retired key.
  const defaultArbitrator = config.sidequest?.defaultArbitrator
  check(
    address(defaultArbitrator) &&
      address(config.roles.arbitrator) &&
      defaultArbitrator.toLowerCase() === config.roles.arbitrator.toLowerCase(),
    'sidequest.defaultArbitrator is not roles.arbitrator',
  )
  check(!retired(defaultArbitrator), 'sidequest.defaultArbitrator is a retired 1 Oct key')
  for (const [binding, source] of Object.entries(mainnetProdSecretSources)) {
    check(artifact.secretSources[binding] === source, `secret source:${binding}`)
  }
  check(
    Object.keys(artifact.secretSources).length === Object.keys(mainnetProdSecretSources).length,
    'unexpected secret source',
  )
  return failures
}

/** The Safe policy D16 enforces, as pinned in the artifact: distinct owners, a threshold between 1 and their number. */
export interface SafePolicy {
  owners: string[]
  threshold: number
}

export function safePolicy(artifact: Pick<ProdArtifact, 'deployment'>): SafePolicy | undefined {
  const owners = artifact.deployment?.sidequest?.safeOwners
  const threshold = artifact.deployment?.sidequest?.safeThreshold
  if (!Array.isArray(owners) || owners.length === 0 || !owners.every(address)) return undefined
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) return undefined
  if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length)
    return undefined
  return { owners, threshold }
}

export function validateProdConfig(config: ChainConfig, artifact: ProdArtifact): string[] {
  try {
    return validateCompleteProdConfig(config, artifact)
  } catch {
    return ['artifact structure']
  }
}

// ---- D16: the live launch gate (PROD-GATE-001/002/003/004) ----

/** Read-only chain access for the launch gate. Every method throws on a failed read. */
export interface LaunchReader {
  code(address: string): Promise<string>
  call(to: string, data: `0x${string}`): Promise<`0x${string}`>
  balance(address: string): Promise<bigint>
  /** One 32-byte storage word. */
  storage(address: string, slot: `0x${string}`): Promise<`0x${string}`>
}

const launchAbi = parseAbi([
  'function MIN_REVIEW_WINDOW() view returns (uint32)',
  'function MIN_DISPUTE_WINDOW() view returns (uint32)',
  'function MIN_ARBITRATION_WINDOW() view returns (uint32)',
  'function UNSTAKE_DELAY() view returns (uint48)',
  'function HOLDING_DELAY() view returns (uint48)',
  'function PROPOSAL_GRACE() view returns (uint48)',
  'function DELAY() view returns (uint48)',
  'function MAX_REVIEW_WINDOW() view returns (uint32)',
  'function MAX_DISPUTE_WINDOW() view returns (uint32)',
  'function MAX_ARBITRATION_WINDOW() view returns (uint32)',
  'function owner() view returns (address)',
  'function ADMIN_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function verifiers(address account) view returns (bool)',
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])

export const launchClockReads = [
  ['holding', 'MIN_REVIEW_WINDOW', 'minReviewWindow'],
  ['holding', 'MIN_DISPUTE_WINDOW', 'minDisputeWindow'],
  ['holding', 'MIN_ARBITRATION_WINDOW', 'minArbitrationWindow'],
  ['vault', 'UNSTAKE_DELAY', 'unstakeDelay'],
  ['vault', 'HOLDING_DELAY', 'holdingDelay'],
  ['vault', 'PROPOSAL_GRACE', 'proposalGrace'],
  ['feeSchedule', 'DELAY', 'feeDelay'],
  ['feeSchedule', 'PROPOSAL_GRACE', 'proposalGrace'],
] as const

/** The canonical SafeL2 v1.4.1 singleton on Monad (runbook §1.1); a Safe proxy keeps it at storage slot 0. */
export const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
/** keccak256("guard_manager.guard.address"): Safe v1.4.1's transaction guard. */
export const SAFE_GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001'
const SLOT_0 = `0x${'0'.repeat(64)}` as const
const word = (value: unknown): value is `0x${string}` => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The four Ownable2Step v1 contracts the Safe must own (not merely be pending for) before admission opens. */
export const launchOwnedContracts = ['vault', 'feeSchedule', 'holding', 'evaluator'] as const

/** Only an explicit open value opens. Missing, empty and malformed values are drained. */
export function opensAdmission(drain: string | undefined): boolean {
  return drain === '0' || drain?.toLowerCase() === 'false'
}

/** The exact deploy binding, shared with the live gate's mode check. */
export function admissionDrainBinding(drain: string | undefined): '0' | '1' {
  return opensAdmission(drain) ? '0' : '1'
}

export function validateAdmissionMode(artifact: Pick<ProdArtifact, 'admission'>, drain: string | undefined): string[] {
  if (typeof artifact.admission?.drain !== 'boolean') return ['admission mode']
  return artifact.admission.drain === !opensAdmission(drain) ? [] : ['admission runtime mismatch']
}

// ---- PROD-GATE-006: Explore's launch flag, pinned ----

/** What an Explore build serves at `/release.json` (its vite config writes it from `release.ts`). */
interface ExploreRelease {
  network: string
  mainnetLive: boolean
  writesOpen: boolean
}

/**
 * The artifact pins `explore.mainnetLive`, which must equal the source (`MAINNET_LIVE` in `apps/explore/src/release.ts`,
 * the only place it is set) and agree with the admission mode: an open artifact (`admission.drain` false) needs it true,
 * a drained setup artifact needs it false. Labels only, no values.
 */
export function validateExploreRelease(
  artifact: Pick<ProdArtifact, 'admission' | 'explore'>,
  sourceMainnetLive: boolean,
): string[] {
  const pinned = artifact.explore?.mainnetLive
  if (typeof pinned !== 'boolean') return ['explore:mainnetLive']
  const failures: string[] = []
  if (pinned !== sourceMainnetLive) failures.push('explore:mainnetLive differs from apps/explore/src/release.ts')
  const drain = artifact.admission?.drain
  if (typeof drain !== 'boolean') failures.push('admission mode')
  else if (drain && pinned) failures.push('explore:mainnetLive must be false while admission is drained')
  else if (!drain && !pinned) failures.push('explore:mainnetLive must be true to open admission')
  return failures
}

/**
 * Post-deploy: the served `/release.json` must be the artifact's: the mainnet network, the pinned `mainnetLive`, and
 * writes open exactly when it is live. Anything else, including a body that is not that shape, fails.
 */
export function validateReleaseProbe(artifact: Pick<ProdArtifact, 'network' | 'explore'>, served: unknown): string[] {
  const pinned = artifact.explore?.mainnetLive
  if (typeof pinned !== 'boolean') return ['explore:mainnetLive']
  if (typeof served !== 'object' || served === null) return ['release.json is not an object']
  const body = served as Partial<ExploreRelease>
  const failures: string[] = []
  if (body.network !== artifact.network) failures.push('release.json network')
  if (body.mainnetLive !== pinned) failures.push('release.json mainnetLive')
  if (body.writesOpen !== (artifact.network === 'monad-testnet' || pinned)) failures.push('release.json writesOpen')
  return failures
}

/**
 * Every predicate that must hold, read live, before production admission opens. Returns failure labels, no values;
 * a failed or malformed read is a failure. Pending ownership passes promotion, never this gate.
 *   1. `deployment.sidequest.safe` is set and has code (it matching the artifact is the structural check), and it is the
 *      reviewed Safe (LAUNCH-AUDIT-003): a proxy of the canonical SafeL2 singleton, VERSION 1.4.1, exactly the
 *      artifact's pinned owners and threshold, no module (getModulesPaginated(0x1, 10) is empty) and no guard. A module
 *      acts without advancing the nonce, which the mining fund's guard (D18) relies on; a guard can block execution;
 *   2. `owner() == safe` on the four v1 contracts;
 *   3. the core's DEFAULT_ADMIN_ROLE and ADMIN_ROLE are held by the Safe, and by the deployer (`roles.admin`) for neither;
 *   4. `verifiers(roles.attester)` on the v1 Evaluator;
 *   5. the arbitrator holds at least the launch MON reserve, and Pimlico serves the configured USDC paymaster.
 */
export async function liveLaunchGate(
  config: ChainConfig,
  reader: LaunchReader,
  arbitratorFloor: bigint | undefined,
  policy: SafePolicy | undefined,
  aaProbe: LaunchAaProbe = { env: process.env, fetcher: fetch },
): Promise<string[]> {
  const failures: string[] = []
  const deployed = config.deployment
  const safe = deployed.sidequest?.safe
  if (!address(safe)) return ['launch:safe unset']
  const read = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch {
      failures.push(`${label} unreadable`)
      return undefined
    }
  }
  type LaunchFunction =
    | (typeof launchClockReads)[number][1]
    | 'MAX_REVIEW_WINDOW'
    | 'MAX_DISPUTE_WINDOW'
    | 'MAX_ARBITRATION_WINDOW'
    | 'owner'
    | 'ADMIN_ROLE'
    | 'DEFAULT_ADMIN_ROLE'
    | 'hasRole'
    | 'verifiers'
    | 'VERSION'
    | 'getOwners'
    | 'getThreshold'
    | 'getModulesPaginated'
  const view = async (to: unknown, functionName: LaunchFunction, args: readonly unknown[] = []) => {
    if (!address(to)) throw new Error('no address')
    const data = encodeFunctionData({ abi: launchAbi, functionName, args } as never)
    return decodeFunctionResult({ abi: launchAbi, functionName, data: await reader.call(to, data) } as never) as unknown
  }

  const code = await read('launch:safe code', () => reader.code(safe))
  if (code !== undefined && !/^0x[0-9a-fA-F]*$/.test(code)) failures.push('launch:safe code unreadable')
  else if (code !== undefined && /^0x0*$/.test(code)) failures.push('launch:safe has no code')

  // LAUNCH-AUDIT-003: the reviewed Safe, read live against the artifact's pinned policy.
  const singleton = await read('launch:safe singleton', () => reader.storage(safe, SLOT_0))
  if (
    singleton !== undefined &&
    !(word(singleton) && same(`0x${singleton.slice(26)}`, SAFE_SINGLETON) && /^0x0{24}/.test(singleton))
  ) {
    failures.push('launch:safe singleton is not the canonical SafeL2 v1.4.1')
  }
  const version = await read('launch:safe VERSION', () => view(safe, 'VERSION'))
  if (version !== undefined && version !== '1.4.1') failures.push('launch:safe VERSION is not 1.4.1')
  if (policy === undefined) failures.push('launch:safe owners/threshold not pinned in the artifact')
  const owners = await read('launch:safe owners', () => view(safe, 'getOwners'))
  if (owners !== undefined && policy !== undefined) {
    const live = Array.isArray(owners) ? owners.map((owner) => String(owner).toLowerCase()) : []
    const want = policy.owners.map((owner) => owner.toLowerCase())
    if (
      !Array.isArray(owners) ||
      live.length !== want.length ||
      new Set(live).size !== live.length ||
      !want.every((owner) => live.includes(owner))
    ) {
      failures.push('launch:safe owners differ from the pinned set')
    }
  }
  const threshold = await read('launch:safe threshold', () => view(safe, 'getThreshold'))
  if (threshold !== undefined && policy !== undefined && threshold !== BigInt(policy.threshold))
    failures.push('launch:safe threshold differs from the pinned one')
  const modules = await read('launch:safe modules', () => view(safe, 'getModulesPaginated', [SAFE_SENTINEL, 10n]))
  if (modules !== undefined && !(Array.isArray(modules) && Array.isArray(modules[0]) && modules[0].length === 0)) {
    failures.push('launch:safe has a module enabled')
  }
  const guard = await read('launch:safe guard', () => reader.storage(safe, SAFE_GUARD_SLOT))
  if (guard !== undefined && !(word(guard) && /^0x0{64}$/.test(guard))) failures.push('launch:safe has a guard set')

  const owned: Record<(typeof launchOwnedContracts)[number], unknown> = {
    vault: deployed.sidequest?.vault,
    feeSchedule: deployed.sidequest?.feeSchedule,
    holding: deployed.main?.holding,
    evaluator: deployed.main?.evaluator,
  }
  for (const name of launchOwnedContracts) {
    const owner = await read(`launch:owner:${name}`, () => view(owned[name], 'owner'))
    if (owner !== undefined && (typeof owner !== 'string' || !same(owner, safe)))
      failures.push(`launch:owner:${name} is not the Safe`)
  }

  // D24: no config override can relax chain 143. Missing testnet input means production.
  const clocks = { ...productionLaunchClocks }
  const input = config.sidequest?.clocks
  if (input !== undefined) {
    for (const key of Object.keys(clocks) as (keyof LaunchClocks)[]) {
      const value = input?.[key]
      const min = key.startsWith('min') ? 1 : 60
      const max = key.startsWith('min') ? 1209600 : 281474976710655
      if (
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max ||
        (config.chainId === 143 && value !== productionLaunchClocks[key])
      ) {
        failures.push(`launch:clocks:${key} config invalid`)
      } else clocks[key] = value
    }
    if (clocks.holdingDelay <= clocks.unstakeDelay) failures.push('launch:clocks holdingDelay must exceed unstakeDelay')
  }
  for (const [name, getter, key] of launchClockReads) {
    const label = `launch:clock:${name}.${getter}`
    const value = await read(label, () => view(owned[name], getter))
    if (value !== undefined && value !== BigInt(clocks[key]) && value !== clocks[key])
      failures.push(`${label} differs from config`)
  }
  for (const getter of ['MAX_REVIEW_WINDOW', 'MAX_DISPUTE_WINDOW', 'MAX_ARBITRATION_WINDOW'] as const) {
    const label = `launch:clock:holding.${getter}`
    const value = await read(label, () => view(owned.holding, getter))
    if (value !== undefined && value !== 1209600) failures.push(`${label} differs from production`)
  }

  const deployer = config.roles.admin
  if (!address(deployer) || same(deployer, safe)) failures.push('launch:deployer must be a separate account')
  for (const roleName of ['DEFAULT_ADMIN_ROLE', 'ADMIN_ROLE'] as const) {
    const role = await read(`launch:core ${roleName}`, () => view(deployed.core, roleName))
    if (role === undefined) continue
    const safeHolds = await read(`launch:core ${roleName} of the Safe`, () =>
      view(deployed.core, 'hasRole', [role, safe]),
    )
    if (safeHolds !== undefined && safeHolds !== true) failures.push(`launch:core ${roleName} not held by the Safe`)
    if (address(deployer)) {
      const deployerHolds = await read(`launch:core ${roleName} of the deployer`, () =>
        view(deployed.core, 'hasRole', [role, deployer]),
      )
      if (deployerHolds !== undefined && deployerHolds !== false)
        failures.push(`launch:core ${roleName} still held by the deployer`)
    }
  }

  const verifier = await read('launch:attester verifier', () =>
    view(deployed.main?.evaluator, 'verifiers', [config.roles.attester]),
  )
  if (verifier !== undefined && verifier !== true)
    failures.push('launch:attester is not a verifier on the v1 Evaluator')

  if (arbitratorFloor === undefined)
    failures.push('launch:arbitrator floor undefined (ARBITER_LAUNCH_MON, @sidequest/sdk)')
  const arbitrator = config.roles.arbitrator
  const balance = await read('launch:arbitrator balance', () => {
    if (!address(arbitrator)) throw new Error('no address')
    return reader.balance(arbitrator)
  })
  if (balance !== undefined && arbitratorFloor !== undefined && balance < arbitratorFloor)
    failures.push('launch:arbitrator below ARBITER_LAUNCH_MON')
  // D16's Pimlico readiness is a mainnet admission check. Testnet's separate
  // deploy preflight retains the legacy relay and testnet paymaster checks.
  if (config.network === 'monad-mainnet' && config.chainId === 143)
    failures.push(...(await launchAaFailures(config, reader, aaProbe)))
  return failures
}
