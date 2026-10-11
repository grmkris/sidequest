import { describe, expect, it } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import {
  type DeploymentConfig,
  NotDeployedError,
  PRODUCTION_CLOCKS,
  allStacks,
  deployment,
  deploymentFromConfig,
  networkMeta,
  networkMetaFromConfig,
  stackByHolding,
} from './deployment.ts'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const currentConfig = () => structuredClone(testnet) as DeploymentConfig

describe('v1 deployment config', () => {
  it('loads only the current main pair and refuses discovery of a retired Holding', () => {
    const d = deploymentFromConfig('monad-testnet', currentConfig())
    expect(allStacks(d)).toEqual([['main', d.stacks.main]])
    expect(d.stacks.main?.kind).toBe('sidequest-v1')
    expect(stackByHolding(d, d.stacks.main!.holding.toUpperCase())?.[0]).toBe('main')
    expect(stackByHolding(d, address(99))).toBeUndefined()
  })
  it('exposes configured offer hosts and refuses paths, credentials and insecure targets', () => {
    const c = currentConfig()
    expect(deploymentFromConfig('monad-testnet', c).boards).toEqual(testnet.boards)
    expect(mainnet.boards).toEqual([])
    delete c.boards
    expect(deploymentFromConfig('monad-testnet', c).boards).toEqual([])
    for (const origin of [
      'http://board.example',
      'https://board.example/',
      'https://board.example/offers',
      'https://user@board.example',
    ]) {
      expect(() => deploymentFromConfig('monad-testnet', { ...c, boards: [origin] })).toThrow('https origins')
    }
  })
  it('loads optional deploy-time clocks and enforces production values on mainnet', () => {
    const c = currentConfig()
    delete c.deployment.sidequest!.clocks
    expect(deploymentFromConfig('monad-testnet', c).sidequest?.clocks).toBeUndefined()
    c.deployment.sidequest!.clocks = { ...PRODUCTION_CLOCKS, minReviewWindow: 120, epochDuration: 3600 }
    expect(deploymentFromConfig('monad-testnet', c).sidequest?.clocks?.epochDuration).toBe(3600)
    c.deployment.sidequest!.clocks = { ...c.deployment.sidequest!.clocks, epochDuration: 599 }
    expect(() => deploymentFromConfig('monad-testnet', c)).toThrow('epochDuration')
    c.deployment.sidequest!.clocks = { ...PRODUCTION_CLOCKS, minReviewWindow: 120 }
    c.network = 'monad-mainnet'
    c.chainId = 143
    expect(() => deploymentFromConfig('monad-mainnet', c)).toThrow('Mainnet requires production clock')
  })
  it('reports an unpromoted record unavailable independently of the shipped config', () => {
    expect(() => deploymentFromConfig('monad-mainnet', { ...mainnet, deployment: {} })).toThrow(NotDeployedError)
  })
  it.each([
    (c: DeploymentConfig) => {
      delete c.deployment.main!.kind
    },
    (c: DeploymentConfig) => {
      delete c.deployment.main!.factory
    },
    (c: DeploymentConfig) => {
      delete c.deployment.sidequest
    },
    (c: DeploymentConfig) => {
      c.deployment.main!.factory = address(99)
    },
    (c: DeploymentConfig) => {
      c.deployment.sidequest!.vault = address(0)
    },
    (c: DeploymentConfig) => {
      c.deployment.sidequest!.safe = address(0)
    },
    (c: DeploymentConfig) => {
      c.deployment.sidequest!.t0 = 0
    },
    (c: DeploymentConfig) => {
      c.deployment.sidequest!.block = 0.5
    },
    (c: DeploymentConfig) => {
      c.deployment.main!.kind = 'unknown' as never
    },
    (c: DeploymentConfig) => {
      c.network = 'monad-mainnet'
    },
  ])('refuses incomplete or inconsistent v1 metadata', (mutate) => {
    const c = currentConfig()
    mutate(c)
    expect(() => deploymentFromConfig('monad-testnet', c)).toThrow()
  })
})

describe('network meta', () => {
  it('reads the testnet link and the X profile before mainnet is deployed', () => {
    const meta = networkMeta('monad-mainnet')
    expect(meta.links).toEqual({ testnet: 'https://dev.sidequest.exchange', x: 'https://x.com/sidequest_0' })
    expect(meta.usdPegged).toEqual([mainnet.x402.usdc])
  })
  it('pegs the configured test dollar and links mainnet nowhere until the launch commit names it', () => {
    const meta = networkMeta('monad-testnet')
    expect(meta.links).toEqual({ x: 'https://x.com/sidequest_0' })
    expect(meta.usdPegged.map((a) => a.toLowerCase())).toContain(
      deployment('monad-testnet').rewardTokens[0]!.toLowerCase(),
    )
  })
  it('refuses links with paths or insecure origins and invalid pegged addresses', () => {
    const c = currentConfig()
    for (const origin of [
      'http://dev.sidequest.exchange',
      'https://dev.sidequest.exchange/',
      'https://dev.sidequest.exchange/start',
      'javascript:alert(1)',
    ]) {
      expect(() => networkMetaFromConfig({ ...c, links: { testnet: origin } })).toThrow('links.testnet')
      expect(() => networkMetaFromConfig({ ...c, links: { mainnet: origin } })).toThrow('links.mainnet')
    }
    for (const x of [
      'http://x.com/sidequest_0',
      'https://x.com/sidequest_0/status/1',
      'https://twitter.com/sidequest_0',
    ])
      expect(() => networkMetaFromConfig({ ...c, links: { x } })).toThrow('links.x')
    expect(networkMetaFromConfig({ ...c, links: { mainnet: 'https://sidequest.exchange' } }).links).toEqual({
      mainnet: 'https://sidequest.exchange',
    })
    expect(() => networkMetaFromConfig({ ...c, usdPegged: ['USDC'] })).toThrow('token addresses')
  })
})
