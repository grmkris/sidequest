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
    c.deployment.sidequest!.clocks = { ...PRODUCTION_CLOCKS, minReviewWindow: 120, feeDelay: 300 }
    expect(deploymentFromConfig('monad-testnet', c).sidequest?.clocks?.feeDelay).toBe(300)
    c.deployment.sidequest!.clocks = { ...c.deployment.sidequest!.clocks, feeDelay: 59 }
    expect(() => deploymentFromConfig('monad-testnet', c)).toThrow('feeDelay')
    // A record written before mining was deleted keeps its epoch clocks; they are ignored, not carried.
    c.deployment.sidequest!.clocks = Object.assign({}, PRODUCTION_CLOCKS, { epochDuration: 3600 })
    expect(deploymentFromConfig('monad-testnet', c).sidequest?.clocks).toEqual(PRODUCTION_CLOCKS)
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
      c.deployment.sidequest!.feeSchedule = address(0)
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

describe('account abstraction config', () => {
  it("reads the EntryPoint, USDC and Pimlico's paymaster on mainnet, and testnet's own paymaster kind", () => {
    const m = mainnet.accountAbstraction
    expect(m).toMatchObject({ paymasterKind: 'pimlico-erc20', paymaster: '0x777777777777AeC03fd955926DbF81597e66834C' })
    const t = deployment('monad-testnet').aa!
    expect(t).toMatchObject({
      entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      paymasterKind: 'sidequest-testnet',
      gasToken: testnet.x402.usdc,
      standingApproval: 1_000_000n,
      maxCostPerOp: 100_000n,
    })
  })

  it('refuses a malformed block and the testnet paymaster on mainnet', () => {
    const at = (patch: Record<string, unknown>, chainId = 10143) => {
      const c = currentConfig()
      c.chainId = chainId
      // Testnet's fast clocks would fail mainnet's clock check first.
      if (chainId === 143) delete c.deployment.sidequest!.clocks
      c.accountAbstraction = { ...c.accountAbstraction!, ...patch }
      return () => deploymentFromConfig('monad-testnet', c)
    }
    expect(at({ entryPoint: 'nope' })).toThrow('entryPoint')
    expect(at({ paymaster: '0x0' })).toThrow('paymaster must be an address')
    expect(at({ paymasterKind: 'relay' })).toThrow('paymasterKind is unknown')
    expect(at({ standingApproval: '0' })).toThrow('positive base units')
    expect(at({ maxCostPerOp: '2000000' })).toThrow('fit in the standing approval')
    expect(at({}, 143)).toThrow('never runs on mainnet')
    const c = currentConfig()
    delete c.accountAbstraction
    expect(deploymentFromConfig('monad-testnet', c).aa).toBeNull()
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
    expect(() => networkMetaFromConfig({ ...c, nadfun: { app: 'http://nad.fun' } })).toThrow('nadfun.app')
  })
  it('links SIDE on its launcher once the config names both the launcher and SIDE', () => {
    const c = currentConfig()
    const side = '0x1111111111111111111111111111111111117777'
    // G1f's SIDE is a nad.fun testnet launch, but nad.fun has no testnet website, so testnet gets SIDE from the faucet.
    expect(networkMeta('monad-testnet').getSide).toBeUndefined()
    expect(networkMeta('monad-mainnet').getSide).toBeUndefined() // no SIDE before the launch commit
    const launched = { ...c, nadfun: { app: 'https://nad.fun' }, sidequest: { token: side } }
    expect(networkMetaFromConfig(launched).getSide).toBe(`https://nad.fun/tokens/${side}`)
    expect(networkMetaFromConfig(launched).side).toBe(side)
    expect(networkMeta('monad-mainnet').side).toBeUndefined()
    expect(() => networkMetaFromConfig({ ...launched, sidequest: { token: 'SIDE' } })).toThrow('token address')
  })
  it("lists SIDE's other pages with its address once the config names SIDE, and refuses anything but https paths", () => {
    const c = currentConfig()
    const side = '0x1111111111111111111111111111111111117777'
    // Testnet SIDE has no nad.fun site and no tracker: MonadVision's testnet explorer only.
    expect(networkMeta('monad-testnet').sidePages).toEqual([
      {
        name: 'MonadVision',
        href: `https://testnet.monadvision.com/token/${testnet.sidequest.token}`,
        graduated: false,
      },
    ])
    expect(networkMeta('monad-mainnet').sidePages).toEqual([]) // no SIDE before the launch commit
    const launched = { ...c, sidequest: { token: side }, sidePages: mainnet.sidePages }
    expect(networkMetaFromConfig(launched).sidePages).toEqual([
      { name: 'MonadVision', href: `https://monadvision.com/token/${side}`, graduated: false },
      // Listed from day one: its page fills in once SIDE leaves the curve (Kris, 12 Oct).
      { name: 'DEX Screener', href: `https://dexscreener.com/monad/${side}`, graduated: false },
    ])
    for (const url of [
      'http://monadvision.com/token/{token}',
      'https://monadvision.com/token/',
      'javascript:alert(1)//{token}',
      'https://monadvision.com/token/{token}?ref=x',
    ])
      expect(() => networkMetaFromConfig({ ...launched, sidePages: [{ name: 'X', url }] })).toThrow('sidePages')
    expect(() =>
      networkMetaFromConfig({ ...launched, sidePages: [{ name: ' ', url: 'https://a.b/{token}' }] }),
    ).toThrow('sidePages')
  })
  it('reads the first-party wallets, crew agents and demo jobs, empty until named', () => {
    const c = currentConfig()
    expect(networkMeta('monad-mainnet').firstParty).toEqual({ addresses: [], agents: [], demoJobs: [] })
    const safe = '0x2222222222222222222222222222222222222222'
    const named = { ...c, firstParty: { addresses: [safe], agents: ['2023'], demoJobs: ['1'] } }
    expect(networkMetaFromConfig(named).firstParty).toEqual({ addresses: [safe], agents: ['2023'], demoJobs: ['1'] })
    expect(() => networkMetaFromConfig({ ...c, firstParty: { addresses: ['Safe'] } })).toThrow('firstParty.addresses')
    expect(() => networkMetaFromConfig({ ...c, firstParty: { demoJobs: ['#1'] } })).toThrow('decimal ids')
    expect(() => networkMetaFromConfig({ ...c, usdPegged: ['USDC'] })).toThrow('token addresses')
  })
})
