import * as sdk from '@sidequest/sdk'
import { type Chain, type EIP1193Provider, zeroAddress } from 'viem'
import { createConfig, custom, http, useReadContract } from 'wagmi'
import { monad, monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { closeWrites } from './launch.ts'
import { MAINNET_LIVE } from './release.ts'

declare const __SIDEQUEST_NETWORK__: sdk.Network
declare const __PRIVY_APP_ID__: string
declare const __SIDEQUEST_STAGE__: string
declare const __SIDEQUEST_RELAY__: `0x${string}`

/** Privy's public app id; empty hides the email/social sign-in. */
export const privyAppId: string = typeof __PRIVY_APP_ID__ === 'string' ? __PRIVY_APP_ID__ : ''

export const network: sdk.Network = typeof __SIDEQUEST_NETWORK__ === 'string' ? __SIDEQUEST_NETWORK__ : 'monad-testnet'
export const stage = typeof __SIDEQUEST_STAGE__ === 'string' ? __SIDEQUEST_STAGE__ : 'local'
if (typeof __SIDEQUEST_RELAY__ === 'string' && (__SIDEQUEST_RELAY__ as string) !== '')
  sdk.setRelayOverride(__SIDEQUEST_RELAY__)
export const isMainnet = network === 'monad-mainnet'

const links = sdk.networkMeta(network).links
/**
 * The other network's Explore, which the network switch opens: testnet from mainnet (`links.testnet`), and mainnet from
 * testnet (`links.mainnet`, which the testnet config names only once mainnet is live). Null without a link: no switch.
 */
export const otherNetwork: { readonly label: 'Mainnet' | 'Testnet'; readonly href: string } | null = isMainnet
  ? links.testnet === undefined
    ? null
    : { label: 'Testnet', href: links.testnet }
  : links.mainnet === undefined
    ? null
    : { label: 'Mainnet', href: links.mainnet }
/** Testnet's Explore origin on mainnet, where the "launching soon" notices send people before launch; else null. */
export const testnetLink: string | null = isMainnet ? (links.testnet ?? null) : null
/** The project's X profile (`links.x`), or null. */
export const xLink: string | null = links.x ?? null
/** Sidequest's own wallets, crew Agent IDs and founder demo jobs, for the job page's related-party labels. */
export const firstParty: sdk.NetworkMeta['firstParty'] = sdk.networkMeta(network).firstParty
/** SIDE's page on its launcher (nad.fun on mainnet), where people get SIDE while it has no market of ours; or null. */
export const getSideLink: string | null = sdk.networkMeta(network).getSide ?? null
/** SIDE's other pages (MonadVision, DEX Screener once graduated) from the network config; empty while SIDE is unknown. */
export const sidePages: sdk.NetworkMeta['sidePages'] = sdk.networkMeta(network).sidePages
/** The deploy's chain; testnet with the explorer overridden (the chain's default testnet explorer entry is stale). */
export const chain: Chain = isMainnet
  ? monad
  : { ...monadTestnet, blockExplorers: { default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' } } }

/** A deployment with Sidequest v1: its contracts and the v1 `main` pair. The only kind of network Explore serves. */
export type V1Deployment = sdk.Deployment & {
  readonly sidequest: sdk.SidequestDeployment
  readonly stacks: { readonly main: sdk.Stack }
}

const isV1 = (d: sdk.Deployment): d is V1Deployment => d.sidequest !== null && d.stacks.main?.kind === 'sidequest-v1'

/** The network's contracts, or null before launch day promotes them (mainnet's `deployment` block is empty until then). */
function loadDeployment(): V1Deployment | null {
  try {
    const d = sdk.deployment(network)
    return isV1(d) ? d : null
  } catch (error) {
    if (error instanceof sdk.NotDeployedError) return null
    throw error
  }
}
const loaded = loadDeployment()
/** Whether this network has Sidequest v1 (U-MAINNET-EMPTY): false only on mainnet before launch day promotes it. */
export const deployed = loaded !== null
/**
 * The network's deployment. Before launch day it is a placeholder of zero addresses, so module-level reads of it stay
 * harmless; `deployed` is false, writes stay closed and the chain transport below sends nothing.
 */
export const deployment: V1Deployment = loaded ?? undeployed()
function undeployed(): V1Deployment {
  const none = zeroAddress
  const enforcers = {
    erc20PeriodTransfer: none,
    erc20TransferAmount: none,
    allowedCalldata: none,
    valueLte: none,
    allowedTargets: none,
    allowedMethods: none,
    limitedCalls: none,
    timestamp: none,
  }
  const sidequest = {
    block: 0n,
    safe: none,
    factory: none,
    vault: none,
    feeSchedule: none,
  }
  return {
    network,
    chainId: chain.id,
    core: none,
    factory: none,
    sidequest,
    rewardTokens: [],
    stacks: { main: { kind: 'sidequest-v1', factory: none, holding: none, evaluator: none, openTokens: false } },
    identity: none,
    reputation: none,
    delegation: { manager: none, delegator: none, enforcers },
    admin: none,
    arbitrator: none,
    attester: none,
    relay: none,
    x402: null,
    testnetFaucet: null,
    market: null,
    nativePrice: null,
    nativeSwap: null,
    launcher: null,
    aa: null,
    agentSweep: null,
    deployBlock: 0n,
  }
}

/**
 * Whether this deploy may publish, take, stake, pay or administer anything (D16): always on testnet, on mainnet only
 * once `MAINNET_LIVE` is set and the contracts are deployed. Closed, the pages that write show "launching soon", the
 * board client refuses write tools and the wallet refuses to send or sign (`launch.ts`), whatever URL was opened.
 */
export const writesOpen = (!isMainnet || MAINNET_LIVE) && deployed

/**
 * The Privy embedded wallet (email or social login) as a wagmi connector: the same `injected` connector pointed at
 * the provider Privy hands out after login, so transactions and typed-data signing go through the same wagmi hooks
 * as a browser wallet. Set by `PrivyBridge` once the user is logged in.
 */
let privyProvider: EIP1193Provider | undefined
export const setPrivyProvider = (p: EIP1193Provider | undefined) => {
  privyProvider = p
}
const privyConnector = injected({
  target: { id: 'privy', name: 'Privy', provider: () => closeWrites(privyProvider, writesOpen) },
})
/**
 * A browser wallet (`window.ethereum`) for the embedded widget only (`/embed/<board>?wallet=injected`, ADR-0008):
 * a host page that already has a wallet passes it through. Explore's own sign-in stays Privy only; nothing here
 * auto-connects.
 */
const injectedConnector = writesOpen
  ? injected()
  : injected({
      target: {
        id: 'injected',
        name: 'Browser wallet',
        provider: () => closeWrites((globalThis as { ethereum?: EIP1193Provider }).ethereum, false),
      },
    })

export const wagmiConfig = createConfig({
  chains: [chain] as [Chain],
  // Sign-in is Privy only (email or social login with an embedded wallet); the injected connector serves the widget.
  connectors: privyAppId === '' ? [injectedConnector] : [privyConnector, injectedConnector],
  // With no contracts deployed there is nothing to read: every chain request is refused here, none goes out.
  transports: {
    [chain.id]: deployed
      ? http()
      : custom({ request: () => Promise.reject(new Error('Sidequest is not deployed on this network yet')) }),
  },
  // Monad makes a block about every 0.4 s; viem's 4 s default left a confirmed send looking stuck for seconds.
  pollingInterval: 1_000,
})

/** The core's pause flag (admin power, README Trust): while set, every core call reverts and the board hands out none. */
export function usePaused(): boolean {
  const { data } = useReadContract({
    address: deployment.core,
    abi: sdk.coreAbi,
    functionName: 'paused',
    chainId: chain.id,
    query: { refetchInterval: 30_000, enabled: deployed },
  })
  return data === true
}

export const explorer = (kind: 'tx' | 'address' | 'nft' | 'token', value: string) =>
  `${chain.blockExplorers?.default.url ?? ''}/${kind}/${value}`

/**
 * SIDE's address, for the SIDE control: the deployment's once deployed, else the one the config names (mainnet between
 * the token's creation and launch day's promotion, when only links work); null while neither is known.
 */
export const sideToken: `0x${string}` | null = deployed ? deployment.factory : (sdk.networkMeta(network).side ?? null)

/** An agent's ERC-8004 identity off this site: its NFT on Monadscan and its profile on 8004scan. */
export const agentExplorerLinks = (agentId: string) =>
  [
    { name: 'Monadscan', href: explorer('nft', `${deployment.identity}/${agentId}`) },
    { name: '8004scan', href: `https://8004scan.io/agents/${isMainnet ? 'monad' : 'monad-testnet'}/${agentId}` },
  ] as const
