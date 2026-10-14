import * as sdk from '@sidequest/sdk'
import { type Address, encodeAbiParameters, encodeFunctionData, erc20Abi, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { WalletStep } from './components/txOperation.ts'
import { browserAaRpc, browserPaymentMode, carriedGasToken, userOpCalls } from './aa-request.ts'

const steps: WalletStep[] = [
  {
    description: 'Publish',
    chainId: 10143,
    to: '0x1111111111111111111111111111111111111111',
    data: '0x1234',
    value: '0',
  },
]

describe('browser AA request building', () => {
  it('turns zero-value wallet steps into DeleGator calls and rejects MON value', () => {
    expect(userOpCalls(steps, 10143)).toEqual([{ to: steps[0]!.to, data: steps[0]!.data, value: 0n }])
    expect(() => userOpCalls([{ ...steps[0]!, value: '1' }], 10143)).toThrow(/no MON value/)
    expect(() => userOpCalls(steps, 143)).toThrow(/network/)
    // A batch that funds its own MON (a SIDE trade paid in USDC) keeps its calls' values.
    expect(userOpCalls([{ ...steps[0]!, value: '7' }], 10143, true)).toEqual([
      { to: steps[0]!.to, data: steps[0]!.data, value: 7n },
    ])
  })

  it('reads a USDC SIDE buy from a wallet with no MON as one USDC operation, its MON funded within the batch', async () => {
    const deployment = sdk.deployment('monad-mainnet')
    const owner: Address = '0x00000000000000000000000000000000000000AA'
    const swap = deployment.nativeSwap!
    const mon = 211_910_000_000_000_000_000n
    const buy: WalletStep[] = [
      {
        description: 'Swap',
        chainId: 143,
        to: swap.universalRouter,
        data: sdk.buyMonCalldata(swap, { monOut: mon, usdcMax: 5_349_874n, deadline: 2_000_000_000 }),
        value: '0',
      },
      {
        description: 'Buy SIDE',
        chainId: 143,
        to: deployment.launcher!.router,
        data: encodeFunctionData({
          abi: sdk.nadRouterAbi,
          functionName: 'buyWithNative',
          args: [{ amountOutMin: 1n, token: deployment.launcher!.side, to: owner, deadline: 2_000_000_000n }],
        }),
        value: mon.toString(),
      },
    ]
    const mode = async (usdc: bigint) => {
      const node: sdk.JsonRpc = async (method) => {
        if (method === 'eth_getCode') return '0x'
        if (method === 'eth_getBalance') return toHex(0n)
        return encodeAbiParameters([{ type: 'uint256' }], [usdc])
      }
      return browserPaymentMode({ node, bundler: node, paymaster: node }, deployment, owner, buy, {
        canAuthorize: true,
      })
    }
    const ceiling = deployment.aa!.maxCostPerOp
    expect(await mode(5_349_874n + 2n * ceiling)).toBe('userop')
    expect(await mode(5_349_874n + 2n * ceiling - 1n)).toBe('unfunded')
  })

  it('keeps node direct while bundler and paymaster use the same-origin proxy', async () => {
    const urls: Array<RequestInfo | URL> = []
    const fetcher: typeof fetch = async (input) => {
      urls.push(input)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
    }
    const rpc = browserAaRpc('https://testnet-rpc.monad.xyz', 'https://dev.sidequest.exchange', fetcher)
    await Promise.all([rpc.node('eth_chainId', []), rpc.bundler('eth_chainId', []), rpc.paymaster('eth_chainId', [])])
    expect(urls).toEqual([
      'https://testnet-rpc.monad.xyz',
      'https://dev.sidequest.exchange/aa/rpc',
      'https://dev.sidequest.exchange/aa/rpc',
    ])
  })

  it('reads a MON-only, not yet upgraded Privy wallet as the MON-paid lane once it holds the reserve and ceiling', async () => {
    const deployment = sdk.deployment('monad-testnet')
    const floor = sdk.nativeLaneFloor(deployment.aa!)!
    const mode = async (balance: bigint) => {
      const node: sdk.JsonRpc = async (method) => {
        if (method === 'eth_getCode') return '0x'
        if (method === 'eth_getBalance') return toHex(balance)
        return encodeAbiParameters([{ type: 'uint256' }], [0n]) // no USDC
      }
      const rpc = { node, bundler: node, paymaster: node }
      return browserPaymentMode(rpc, deployment, deployment.admin, [{ ...steps[0]!, chainId: 10143 }], {
        canAuthorize: true,
      })
    }
    expect(await mode(floor)).toBe('userop-native')
    expect(await mode(floor - 1n)).toBe('mon-sequential')
  })
})

it('counts explicit batch gas-token funding net of later outgoing transfers', () => {
  const sender = steps[0]!.to
  const source: Address = '0x2222222222222222222222222222222222222222'
  const token: Address = '0x3333333333333333333333333333333333333333'
  const incoming = {
    ...steps[0]!,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [source, sender, 50_000n] }),
  }
  const outgoing = {
    ...steps[0]!,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [source, 30_000n] }),
  }
  expect(carriedGasToken([incoming], token, sender)).toBe(50_000n)
  expect(carriedGasToken([incoming, outgoing], token, sender)).toBe(20_000n)
  expect(carriedGasToken([outgoing], token, sender)).toBe(0n)
  expect(carriedGasToken([incoming], source, sender)).toBe(0n)
})
