import { type Deployment, testnetFaucetAbi } from '@sidequest/sdk'
import { type Address, encodeFunctionData } from 'viem'
import type { WalletStep } from './components/txOperation.ts'

/** The last successful claim identifies this action across reloads, including an uncertain send across midnight. */
export function faucetClaim(
  deployment: Deployment,
  address: Address,
  lastDrip: bigint,
): { id: string; txs: WalletStep[] } {
  if (deployment.chainId !== 10143 || deployment.testnetFaucet === null)
    throw new Error('The faucet is only available on Monad Testnet.')
  return {
    id: `faucet:${address.toLowerCase()}:${lastDrip}`,
    txs: [
      {
        description: 'Claim test tokens',
        chainId: deployment.chainId,
        to: deployment.testnetFaucet,
        data: encodeFunctionData({ abi: testnetFaucetAbi, functionName: 'drip', args: [address] }),
        value: '0',
        gas: '300000',
      },
    ],
  }
}
