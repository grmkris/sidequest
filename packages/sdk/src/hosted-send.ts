import type { Network } from './deployment.ts'

export type HostedSend = 'relay' | 'userop'

/** Mainnet hosted agents always use their own user operation and USDC gas budget. */
export function hostedSendMode(network: Network, configured: string | undefined): HostedSend {
  if (network === 'monad-mainnet' && configured === 'relay') throw new Error('HOSTED_SEND=relay is refused on mainnet')
  return network === 'monad-mainnet' || configured === 'userop' ? 'userop' : 'relay'
}
