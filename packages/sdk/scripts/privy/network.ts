import type { Network } from '../../src/deployment.ts'

export function explicitNetwork(value: string | undefined): Network {
  if (value === 'monad-testnet' || value === 'monad-mainnet') return value
  throw new Error('Specify monad-testnet or monad-mainnet explicitly')
}
