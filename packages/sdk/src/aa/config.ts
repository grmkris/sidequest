/** AA is configured before the protocol's mainnet deployment exists, so its RPCs must not require that deployment. */
import testnet from '../../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { type AccountAbstraction, type Network, aaFromConfig } from '../deployment.ts'
import { AaError } from './rpc.ts'

export function aaConfig(network: Network): { readonly chainId: number; readonly aa: AccountAbstraction } {
  const config = network === 'monad-mainnet' ? mainnet : testnet
  const aa = aaFromConfig(config)
  if (aa === null) throw new AaError('unavailable', 'no AA configuration on this network')
  return { chainId: config.chainId, aa }
}
