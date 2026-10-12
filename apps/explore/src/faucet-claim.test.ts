import { deployment, testnetFaucetAbi } from '@sidequest/sdk'
import { decodeFunctionData } from 'viem'
import { expect, it } from 'vitest'
import { faucetClaim } from './faucet-claim.ts'

it('builds exactly one faucet call with a stable action ID until a claim lands', () => {
  const network = deployment('monad-testnet')
  const first = faucetClaim(network, network.admin, 0n)
  expect(first).toEqual(faucetClaim(network, network.admin, 0n))
  expect(first.id).not.toBe(faucetClaim(network, network.admin, 123n).id)
  expect(first.txs).toHaveLength(1)
  expect(first.txs[0]?.to).toBe(network.testnetFaucet)
  expect(decodeFunctionData({ abi: testnetFaucetAbi, data: first.txs[0]!.data })).toEqual({
    functionName: 'drip',
    args: [network.admin],
  })
})

it('refuses a mainnet faucet request', () => {
  const network = deployment('monad-testnet')
  expect(() => faucetClaim({ ...network, chainId: 143 }, network.admin, 0n)).toThrow(/only available/)
})
