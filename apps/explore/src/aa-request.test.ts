import { type Address, encodeFunctionData, erc20Abi } from 'viem'
import { describe, expect, it } from 'vitest'
import type { WalletStep } from './components/txOperation.ts'
import { browserAaRpc, carriedGasToken, userOpCalls } from './aa-request.ts'

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
