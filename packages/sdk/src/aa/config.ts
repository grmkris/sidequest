/** AA is configured before the protocol's mainnet deployment exists, so its RPCs must not require that deployment. */
import testnet from '../../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import { type Address, size } from 'viem'
import type { AccountAbstraction, Network } from '../deployment.ts'
import { AaError, type Json, field, hexField } from './rpc.ts'

const address = (value: Json | undefined, name: string): Address => {
  const hex = hexField(value, name)
  if (size(hex) !== 20) throw new AaError('unavailable', `invalid AA ${name}`)
  return hex
}

export function aaConfig(network: Network): { readonly chainId: number; readonly aa: AccountAbstraction } {
  const config = network === 'monad-mainnet' ? mainnet : testnet
  const aa = config.accountAbstraction
  const kind = aa.paymasterKind
  if (kind !== 'sidequest-testnet' && kind !== 'pimlico-erc20')
    throw new AaError('unavailable', 'invalid AA paymaster kind')
  const paymaster = field(aa, 'paymaster')
  return {
    chainId: config.chainId,
    aa: {
      entryPoint: address(aa.entryPoint, 'EntryPoint'),
      paymaster: paymaster === undefined ? null : address(paymaster, 'paymaster'),
      gasToken: address(aa.gasToken, 'gas token'),
      paymasterKind: kind,
      standingApproval: BigInt(aa.standingApproval),
      maxCostPerOp: BigInt(aa.maxCostPerOp),
    },
  }
}
