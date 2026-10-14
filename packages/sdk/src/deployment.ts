/**
 * Addresses come from `contracts/config/<network>.json`, the file the deployment recipe writes; never from code
 * (AGENTS.md). One network, one core and the current Sidequest v1 pair.
 */
import { type Address, type Hex, isAddress, zeroAddress } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import type { Launcher } from './launcher.ts'
import { nativePriceFromConfig, nativeSwapFromConfig, poolIdOf, validAddress } from './pool-config.ts'

export type Network = 'monad-testnet' | 'monad-mainnet'
export type StackName = 'main'
export type StackKind = 'sidequest-v1'

/** Deploy-time protocol clocks. Values are seconds unless the field name says otherwise. */
export interface SidequestClocks {
  readonly minReviewWindow: number
  readonly minDisputeWindow: number
  readonly minArbitrationWindow: number
  readonly unstakeDelay: number
  readonly holdingDelay: number
  readonly feeDelay: number
  readonly proposalGrace: number
}

/** Production values used when an older deployment record has no clocks block. */
export const PRODUCTION_CLOCKS: SidequestClocks = Object.freeze({
  minReviewWindow: 3600,
  minDisputeWindow: 3600,
  minArbitrationWindow: 43200,
  unstakeDelay: 1209600,
  holdingDelay: 1814400,
  feeDelay: 259200,
  proposalGrace: 604800,
})

/** The 14-day window ceilings stay compiled constants (D24). */
export const MAX_SIDEQUEST_WINDOW = 14 * 86400

export function clocksFromConfig(value: SidequestClocks | undefined, chainId: number): SidequestClocks {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
    throw new Error('Invalid Sidequest clocks block')
  const source = value ?? PRODUCTION_CLOCKS
  // Only the v1 clocks: a record from before mining was deleted may still carry its epoch clocks.
  const keys = Object.keys(PRODUCTION_CLOCKS) as Array<keyof SidequestClocks>
  const clocks = Object.fromEntries(keys.map((key) => [key, source[key]])) as Record<keyof SidequestClocks, number>
  for (const key of keys) {
    const seconds = clocks[key]
    const minimum = key.startsWith('min') ? 1 : 60
    const maximum = key.startsWith('min') ? MAX_SIDEQUEST_WINDOW : 2 ** 48 - 1
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > maximum)
      throw new Error(`Invalid Sidequest clock ${key}`)
    if (chainId === 143 && seconds !== PRODUCTION_CLOCKS[key])
      throw new Error(`Mainnet requires production clock ${key}`)
  }
  if (clocks.holdingDelay <= clocks.unstakeDelay) throw new Error('Sidequest holdingDelay must exceed unstakeDelay')
  return clocks
}

export interface Stack {
  readonly kind: StackKind
  readonly factory: Address
  readonly holding: Address
  readonly evaluator: Address
  /**
   * Whether this pair's Holding is safe with any ERC-20 (ADR-0010: the reward must arrive in full, no re-entry, a
   * refused payout is owed). Pairs deployed before it take only known tokens through the board.
   */
  readonly openTokens: boolean
}

export interface SidequestDeployment {
  readonly block: bigint
  /** Owner Safe for every v1 contract and the core admin roles. */
  readonly safe: Address
  readonly factory: Address
  readonly vault: Address
  readonly feeSchedule: Address
  readonly clocks?: SidequestClocks
}

/** The caveat enforcers an execution budget is built from (MetaMask's `…Enforcer` contracts, ADR-0009). */
export interface DelegationEnforcers {
  readonly erc20PeriodTransfer: Address
  readonly erc20TransferAmount: Address
  readonly allowedCalldata: Address
  readonly valueLte: Address
  readonly allowedTargets: Address
  readonly allowedMethods: Address
  readonly limitedCalls: Address
  readonly timestamp: Address
}

export interface DelegationDeployment {
  readonly manager: Address
  readonly delegator: Address
  readonly enforcers: DelegationEnforcers
}

/**
 * ERC-4337 on this chain (ADR-0023): the EntryPoint (v0.7) every account's user operations go through, and the ERC-20
 * paymaster that takes their gas in `gasToken` (USDC). Mainnet uses Pimlico's paymaster; testnet our own, which also
 * sponsors faucet claims. Amounts are the gas token's base units.
 */
export interface AccountAbstraction {
  readonly entryPoint: Address
  /** Null until the paymaster is deployed (testnet) — no user operation is built before then. */
  readonly paymaster: Address | null
  readonly paymasterKind: 'pimlico-erc20' | 'sidequest-testnet'
  readonly gasToken: Address
  /** The standing approval an account gives the paymaster: a batch tops it up only when it runs short. */
  readonly standingApproval: bigint
  /** The most one operation's gas may cost; above it nothing is signed. */
  readonly maxCostPerOp: bigint
  /**
   * The most one MON-paid operation's gas may cost, in wei: an operation with no paymaster, whose account pays the
   * EntryPoint's prefund from its own balance. Null where that lane is not configured.
   */
  readonly maxNativeCostPerOp: bigint | null
  /**
   * Monad's reserve balance, in wei (0 where the chain has none): a delegated account paying a bundler's transaction
   * may not end it below this, or below its starting balance if that was lower, so the transaction reverts.
   */
  readonly nativeReserve: bigint
}

export interface Deployment {
  readonly network: Network
  readonly chainId: number
  /** Origins serving content-addressed frozen offers, in discovery order; empty when absent. */
  readonly boards?: readonly string[]
  readonly core: Address
  readonly factory: Address
  /** The v1 protocol contracts, or null before the v1 recipe has deployed. */
  readonly sidequest: SidequestDeployment | null
  /**
   * Known reward tokens, which the apps list first: the faucet tokens and the config's `knownTokens` (testnet
   * `$CHOMP`, mainnet USDC). Not a gate: a reward may be any ERC-20 (ADR-0010).
   */
  readonly rewardTokens: readonly Address[]
  readonly stacks: Readonly<Partial<Record<StackName, Stack>>>
  readonly identity: Address
  readonly reputation: Address
  /**
   * The MetaMask Delegation Framework (ERC-7710, v1.3.0) on this chain: the `DelegationManager` a worker redeems an
   * execution budget against, the `EIP7702StatelessDeleGatorImpl` every account points its EIP-7702 code at (it
   * batches through ERC-7579 `execute` and validates the account's own key through ERC-1271), and the caveat
   * enforcers a budget delegation is built from (ADR-0009).
   */
  readonly delegation: DelegationDeployment
  /** The core's admin (deployer EOA): pauses, upgrades and verifier registration. */
  readonly admin: Address
  readonly arbitrator: Address
  readonly attester: Address
  /** Legacy testnet compatibility field; zero on mainnet, which has no relay (ADR-0023). Removed in P8. */
  readonly relay: Address
  /**
   * x402 on this chain: the EIP-3009 USDC and Monad's facilitator, where a worker pays paid APIs and tools from its
   * own wallet (funded by an advance). Null where none is recorded.
   */
  readonly x402: { readonly usdc: Address; readonly facilitator: string } | null
  /**
   * Testnet only: the `TestnetFaucet` that gives an address SIDE and each payment token once a day. Null on mainnet
   * and wherever none is deployed.
   */
  readonly testnetFaucet: Address | null
  /**
   * The SIDE market Explore's Buy swaps through: the Uniswap v4 SIDE/quote pool the liquidity seed created (config
   * `liquidity`), traded through Uniswap's UniversalRouter and V4Quoter. Null until the config names both.
   */
  readonly market: Market | null
  /**
   * The chain's coin in dollars (config `prices.native`): a Uniswap v4 pool of the native coin against a
   * dollar-pegged token, read at its mid price through `liquidity.uniswapV4.stateView`. Null where none is configured
   * (testnet), so nothing is priced there.
   */
  readonly nativePrice: NativePrice | null
  /**
   * The same native/pegged pool as a route (config `swap`): Uniswap's UniversalRouter and V4Quoter, and Permit2 from
   * `liquidity.uniswapV4`, so a wallet can turn USDC into MON and back within one batch (a SIDE buy or sale in USDC).
   * Null unless `prices.native`, `swap` and Permit2 are all configured (testnet has none).
   */
  readonly nativeSwap: NativeSwap | null
  /**
   * SIDE on nad.fun's router (config `nadfun.router` and the deployment's SIDE), which Explore's Buy and Sell use where
   * there is no market of ours: the same calls on testnet and mainnet. Null until both exist.
   */
  readonly launcher: Launcher | null
  /** User operations and their USDC paymaster (config `accountAbstraction`); null where none is configured. */
  readonly aa: AccountAbstraction | null
  /** Stateless earnings sweep contract; absent until its deployment is recorded. */
  readonly agentSweep: Address | null
  /** The block the recipe deployed at: where an indexer starts and a rebuild restarts. */
  readonly deployBlock: bigint
}

/** A Uniswap v4 pool key; `hooks` is the zero address for the SIDE pool. */
export interface PoolKey {
  readonly currency0: Address
  readonly currency1: Address
  readonly fee: number
  readonly tickSpacing: number
  readonly hooks: Address
}

/** A native/pegged Uniswap v4 pool to price the chain's coin by: the native coin is always `currency0`. */
export interface NativePrice {
  readonly key: PoolKey
  readonly poolId: Hex
  readonly quote: Address
  readonly stateView: Address
}

/** `NativePrice` as a route: the router and quoter that trade it, and Permit2 for the pegged token's approval. */
export interface NativeSwap extends NativePrice {
  readonly permit2: Address
  readonly universalRouter: Address
  readonly quoter: Address
}

export interface Market {
  readonly key: PoolKey
  readonly poolId: Hex
  readonly side: Address
  readonly quote: Address
  readonly poolManager: Address
  readonly stateView: Address
  readonly permit2: Address
  readonly universalRouter: Address
  readonly quoter: Address
  /**
   * Whether the router's ExactInputSingleParams has `minHopPriceX36` before `hookData` (newer v4-periphery; Monad
   * testnet's router). Config `liquidity.uniswapV4.minHopPrice`.
   */
  readonly minHopPrice: boolean
}

interface LiquidityConfig {
  uniswapV4: {
    poolManager: string
    positionManager: string
    permit2: string
    stateView: string
    universalRouter?: string
    quoter?: string
    minHopPrice?: boolean
  }
  quote: string
  fee: number
  tickSpacing: number
}

export interface DeploymentConfig {
  network: string
  liquidity?: LiquidityConfig
  /** `native`: the v4 pool that prices the chain's coin, against a token in `usdPegged`. */
  prices?: { native?: { quote: string; fee: number; tickSpacing: number } }
  /** Uniswap's UniversalRouter and V4Quoter for `prices.native` (not `liquidity.uniswapV4`, which would open a market). */
  swap?: { universalRouter: string; quoter: string }
  chainId: number
  boards?: string[]
  roles: { admin: string; relay?: string; attester: string; arbitrator: string }
  erc8004: { identity: string; reputation: string }
  delegation: { manager: string; delegator: string; enforcers: Record<keyof DelegationEnforcers, string> }
  x402?: { usdc: string; facilitator: string }
  /** See `AccountAbstraction`; quantities are decimal strings. */
  accountAbstraction?: {
    entryPoint: string
    paymaster?: string
    paymasterKind: string
    gasToken: string
    standingApproval: string
    maxCostPerOp: string
    /** Wei; absent turns the MON-paid lane off. */
    maxNativeCostPerOp?: string
    /** Wei; absent means no reserve. */
    nativeReserve?: string
  }
  /** See `NetworkMeta`. */
  links?: { testnet?: string; mainnet?: string; x?: string }
  /** The launcher SIDE trades on (mainnet): its app's origin; the token's page is `<app>/tokens/<SIDE>`. */
  nadfun?: { app?: string; [key: string]: unknown }
  /** See `NetworkMeta.sidePages`: each `url` names SIDE as `{token}`. */
  sidePages?: { name: string; url: string; graduated?: boolean }[]
  /** The deploy recipe's input; `token` is the existing SIDE it deploys against (contracts/script/SidequestRecipe.sol). */
  sidequest?: { token?: string; [key: string]: unknown }
  /** See `NetworkMeta.firstParty`. */
  firstParty?: { addresses?: string[]; agents?: string[]; demoJobs?: string[] }
  usdPegged?: string[]
  deployment: {
    block?: number
    core?: string
    factory?: string
    sidequest?: {
      block: number
      safe: string
      factory: string
      vault: string
      feeSchedule: string
      clocks?: SidequestClocks
    }
    rewardTokens?: string[]
    testnetFaucet?: string
    agentSweep?: string
    main?: StackEntry
  }
}

interface StackEntry {
  kind?: StackKind
  factory?: string
  holding: string
  evaluator: string
  openTokens?: boolean
}

const stackOf = (s: StackEntry): Stack => {
  const kind = s.kind
  if (kind !== 'sidequest-v1') throw new Error('Unknown deployment stack kind')
  const factory = s.factory
  if (!validAddress(factory)) throw new Error('Deployment stack requires a SIDE address')
  return {
    kind,
    factory,
    holding: s.holding as Address,
    evaluator: s.evaluator as Address,
    openTokens: s.openTokens === true,
  }
}

const files: Record<Network, DeploymentConfig> = {
  'monad-testnet': testnet as DeploymentConfig,
  'monad-mainnet': mainnet as DeploymentConfig,
}

export class NotDeployedError extends Error {
  constructor(network: Network) {
    super(`${network} has no deployment recorded in contracts/config/${network}.json`)
  }
}

let relayOverride: Address | undefined

/** Set once by a hosted Worker so stage-specific relay policy reaches every SDK consumer. */
export function setRelayOverride(relay: Address | undefined): void {
  if (relay !== undefined && !isAddress(relay)) throw new Error('Invalid relay override')
  relayOverride = relay?.toLowerCase() as Address | undefined
}

/**
 * @param network Which network's recorded deployment to read.
 * @throws NotDeployedError when the recipe has not been run there.
 */
export function deployment(network: Network): Deployment {
  const result = deploymentFromConfig(network, files[network])
  return network === 'monad-mainnet' || relayOverride === undefined ? result : { ...result, relay: relayOverride }
}

/**
 * What the network config says before (and apart from) any deployment, so it never throws `NotDeployedError`:
 * - `links.testnet` / `links.mainnet`: the other network's Explore origin, which the network switch opens. Mainnet's
 *   config names testnet; testnet's names mainnet only once mainnet is live (the launch commit adds it).
 * - `links.x`: the project's X profile.
 * - `getSide`: SIDE's page on its launcher, where people get it while it has no market of ours: `nadfun.app` and the
 *   SIDE address (`sidequest.token`, then the deployed `factory`). Absent until both are known.
 * - `usdPegged`: tokens Explore values at one US dollar each in its estimates. Anything else needs a live price.
 * - `sidePages`: SIDE's pages besides its launcher (a block explorer, a market tracker), with the SIDE address filled in;
 *   a `graduated` page lists it only once SIDE trades on a DEX pair (trackers index no bonding curve). Empty until SIDE
 *   is known.
 * - `firstParty`: Sidequest's own wallets (the Safe, the official account, the crew) and crew Agent IDs, so a job
 *   between them is labelled a related party; `demoJobs` are the founder demo hires. Empty until the config names them.
 */
export interface NetworkMeta {
  readonly links: { readonly testnet?: string; readonly mainnet?: string; readonly x?: string }
  readonly getSide?: string
  /** SIDE's address once the config names it (`sidequest.token`, then the deployed `factory`), before any deployment. */
  readonly side?: Address
  readonly sidePages: readonly { readonly name: string; readonly href: string; readonly graduated: boolean }[]
  readonly usdPegged: readonly Address[]
  readonly firstParty: {
    readonly addresses: readonly Address[]
    readonly agents: readonly string[]
    readonly demoJobs: readonly string[]
  }
}

export function networkMeta(network: Network): NetworkMeta {
  return networkMetaFromConfig(files[network])
}

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+$/

/** An optional https origin from the network config, refused with `name` when it is anything else. */
function originAt(name: string, origin: string | undefined): string | undefined {
  if (origin !== undefined && !HTTPS_ORIGIN.test(origin))
    throw new Error(`Network config ${name} must be an https origin`)
  return origin
}

/** SIDE's address: the recipe's input, then the deployed one; undefined until the config names either. */
function sideOf(c: DeploymentConfig): Address | undefined {
  const side = c.sidequest?.token ?? c.deployment.factory
  if (side === undefined) return undefined
  if (!validAddress(side)) throw new Error('Network config SIDE must be a token address')
  return side
}

/** SIDE's page on its launcher: `nadfun.app` and the SIDE address. */
function getSideFromConfig(c: DeploymentConfig): string | undefined {
  const app = originAt('nadfun.app', c.nadfun?.app)
  const side = sideOf(c)
  return app === undefined || side === undefined ? undefined : `${app}/tokens/${side}`
}

const SIDE_PAGE = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9/._~-]*\{token\}[A-Za-z0-9/._~-]*$/

/** SIDE's other pages: each named, on https, with `{token}` in its path. */
function sidePagesFromConfig(c: DeploymentConfig): NetworkMeta['sidePages'] {
  const pages = c.sidePages ?? []
  if (!pages.every((p) => p.name.trim() !== '' && SIDE_PAGE.test(p.url)))
    throw new Error('Network config sidePages must name https pages with {token} in the path')
  const side = sideOf(c)
  if (side === undefined) return []
  return pages.map((p) => ({ name: p.name, href: p.url.replace('{token}', side), graduated: p.graduated === true }))
}

const DECIMAL_ID = /^[1-9][0-9]*$/

function firstPartyFromConfig(c: DeploymentConfig): NetworkMeta['firstParty'] {
  const { addresses = [], agents = [], demoJobs = [] } = c.firstParty ?? {}
  if (!addresses.every(validAddress)) throw new Error('Network config firstParty.addresses must list addresses')
  if (![...agents, ...demoJobs].every((id) => DECIMAL_ID.test(id)))
    throw new Error('Network config firstParty agents and demoJobs must be decimal ids')
  return { addresses, agents, demoJobs }
}

export function networkMetaFromConfig(c: DeploymentConfig): NetworkMeta {
  const testnetOrigin = originAt('links.testnet', c.links?.testnet)
  const mainnetOrigin = originAt('links.mainnet', c.links?.mainnet)
  const x = c.links?.x
  if (x !== undefined && !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(x))
    throw new Error('Network config links.x must be an https://x.com/<handle> profile')
  const usdPegged = c.usdPegged ?? []
  if (!usdPegged.every(validAddress)) throw new Error('Network config usdPegged must list token addresses')
  const getSide = getSideFromConfig(c)
  const side = sideOf(c)
  return {
    ...(getSide === undefined ? {} : { getSide }),
    ...(side === undefined ? {} : { side }),
    sidePages: sidePagesFromConfig(c),
    links: Object.fromEntries(
      Object.entries({ testnet: testnetOrigin, mainnet: mainnetOrigin, x }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    usdPegged,
    firstParty: firstPartyFromConfig(c),
  }
}

/** Only explicit HTTPS origins may supply offers; paths and credentials are never discovery targets. */
function boardsFromConfig(c: DeploymentConfig): readonly string[] {
  const boards = c.boards ?? []
  for (const origin of boards) {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username !== '' || url.password !== '') {
      throw new Error('Network config boards must list https origins')
    }
  }
  return [...new Set(boards)]
}

/** Parse a recorded network config. This also lets offline readers use an archived config without changing it. */
export function deploymentFromConfig(network: Network, c: DeploymentConfig): Deployment {
  if (c.network !== network) throw new Error('Deployment config network mismatch')
  const d = c.deployment
  if (d.core === undefined || d.factory === undefined || d.main === undefined) throw new NotDeployedError(network)
  if (d.sidequest === undefined) throw new Error('Sidequest stack requires its matching v1 deployment')
  const stacks: Partial<Record<StackName, Stack>> = { main: stackOf(d.main) }
  let sidequest: SidequestDeployment | null = null
  if (d.sidequest !== undefined) {
    const h = d.sidequest
    for (const name of ['safe', 'factory', 'vault', 'feeSchedule'] as const) {
      if (!validAddress(h[name])) throw new Error(`Sidequest deployment requires ${name}`)
    }
    if (!Number.isSafeInteger(h.block) || h.block < 0) throw new Error('Sidequest deployment requires its block')
    const clocks = h.clocks === undefined ? undefined : clocksFromConfig(h.clocks, c.chainId)
    sidequest = {
      block: BigInt(h.block),
      safe: h.safe as Address,
      factory: h.factory as Address,
      vault: h.vault as Address,
      feeSchedule: h.feeSchedule as Address,
      ...(clocks === undefined ? {} : { clocks }),
    }
  }
  if (sidequest !== null && stacks.main?.factory.toLowerCase() !== sidequest.factory.toLowerCase())
    throw new Error('Current Sidequest SIDE does not match deployment SIDE')
  return {
    network,
    chainId: c.chainId,
    boards: boardsFromConfig(c),
    core: d.core as Address,
    factory: d.factory as Address,
    sidequest,
    rewardTokens: (d.rewardTokens ?? []) as Address[],
    stacks,
    identity: c.erc8004.identity as Address,
    reputation: c.erc8004.reputation as Address,
    delegation: {
      manager: c.delegation.manager as Address,
      delegator: c.delegation.delegator as Address,
      enforcers: c.delegation.enforcers as DelegationEnforcers,
    },
    admin: c.roles.admin as Address,
    arbitrator: c.roles.arbitrator as Address,
    attester: c.roles.attester as Address,
    // SAFETY: mainnet has no relay; the zero sentinel preserves the legacy field until P8 removes it.
    relay: network === 'monad-mainnet' ? zeroAddress : (c.roles.relay as Address),
    x402: c.x402 === undefined ? null : { usdc: c.x402.usdc as Address, facilitator: c.x402.facilitator },
    testnetFaucet: d.testnetFaucet === undefined || c.chainId === 143 ? null : (d.testnetFaucet as Address),
    market: marketFromConfig(d.factory as Address, c.liquidity),
    nativePrice: nativePriceFromConfig(c),
    nativeSwap: nativeSwapFromConfig(c),
    launcher:
      validAddress(c.nadfun?.router) && validAddress(d.factory) ? { router: c.nadfun.router, side: d.factory } : null,
    aa: aaFromConfig(c),
    agentSweep: agentSweepFromConfig(c),
    deployBlock: BigInt(d.block ?? 0),
  }
}

const UNITS = /^[1-9][0-9]{0,30}$/

/** Config `accountAbstraction`, checked; null when absent. Our own paymaster never runs on mainnet. */
export function aaFromConfig(c: Pick<DeploymentConfig, 'chainId' | 'accountAbstraction'>): AccountAbstraction | null {
  const a = c.accountAbstraction
  if (a === undefined) return null
  if (!validAddress(a.entryPoint) || !validAddress(a.gasToken))
    throw new Error('Network config accountAbstraction needs an entryPoint and a gasToken')
  if (a.paymaster !== undefined && !validAddress(a.paymaster))
    throw new Error('Network config accountAbstraction.paymaster must be an address')
  if (a.paymasterKind !== 'pimlico-erc20' && a.paymasterKind !== 'sidequest-testnet')
    throw new Error('Network config accountAbstraction.paymasterKind is unknown')
  if (a.paymasterKind === 'sidequest-testnet' && c.chainId === 143)
    throw new Error('The testnet paymaster never runs on mainnet')
  if (!UNITS.test(a.standingApproval) || !UNITS.test(a.maxCostPerOp))
    throw new Error('Network config accountAbstraction amounts must be positive base units')
  const standingApproval = BigInt(a.standingApproval)
  const maxCostPerOp = BigInt(a.maxCostPerOp)
  if (maxCostPerOp > standingApproval)
    throw new Error('Network config accountAbstraction.maxCostPerOp must fit in the standing approval')
  return {
    entryPoint: a.entryPoint,
    paymaster: a.paymaster === undefined ? null : a.paymaster,
    paymasterKind: a.paymasterKind,
    gasToken: a.gasToken,
    standingApproval,
    maxCostPerOp,
    maxNativeCostPerOp: optionalWei(a.maxNativeCostPerOp),
    nativeReserve: optionalWei(a.nativeReserve) ?? 0n,
  }
}

/** An optional MON amount of config `accountAbstraction`: null when absent, refused unless positive wei. */
function optionalWei(value: string | undefined): bigint | null {
  if (value === undefined) return null
  if (!UNITS.test(value)) throw new Error('Network config accountAbstraction native amounts must be positive wei')
  return BigInt(value)
}

function agentSweepFromConfig(c: DeploymentConfig): Address | null {
  const address = c.deployment.agentSweep
  if (address === undefined) return null
  if (!validAddress(address)) throw new Error('Deployment agentSweep must be an address')
  return address
}

function marketFromConfig(side: Address, l: LiquidityConfig | undefined): Market | null {
  if (l === undefined || !validAddress(l.quote)) return null
  const v4 = l.uniswapV4
  if (!validAddress(v4.universalRouter) || !validAddress(v4.quoter)) return null
  const quote = l.quote as Address
  const [currency0, currency1] = side.toLowerCase() < quote.toLowerCase() ? [side, quote] : [quote, side]
  const key: PoolKey = { currency0, currency1, fee: l.fee, tickSpacing: l.tickSpacing, hooks: zeroAddress }
  return {
    key,
    poolId: poolIdOf(key),
    side,
    quote,
    poolManager: v4.poolManager as Address,
    stateView: v4.stateView as Address,
    permit2: v4.permit2 as Address,
    universalRouter: v4.universalRouter,
    quoter: v4.quoter,
    minHopPrice: v4.minHopPrice === true,
  }
}

export function stack(d: Deployment, name: StackName): Stack {
  const s = d.stacks[name]
  if (s === undefined) throw new Error(`${d.network} has no "${name}" stack`)
  return s
}

/** The configured v1 pairs on the network, by name. */
export function allStacks(d: Deployment): Array<[name: string, stack: Stack]> {
  const out: Array<[string, Stack]> = []
  for (const [name, s] of Object.entries(d.stacks)) if (s !== undefined) out.push([name, s])
  return out
}

/** The configured pair whose Holding is `holding`; undefined for a retired or unknown address. */
export function stackByHolding(d: Deployment, holding: string): [name: string, stack: Stack] | undefined {
  return allStacks(d).find(([, s]) => s.holding.toLowerCase() === holding.toLowerCase())
}
