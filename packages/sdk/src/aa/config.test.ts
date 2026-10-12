import { describe, expect, it } from 'vitest'
import { aaConfig } from './config.ts'
import { deployment } from '../deployment.ts'

describe('AA configuration before protocol deployment', () => {
  it('serves mainnet RPC configuration without requiring a deployed protocol', () => {
    const config = aaConfig('monad-mainnet')
    expect(config.chainId).toBe(143)
    expect(config.aa.paymasterKind).toBe('pimlico-erc20')
    expect(config.aa.paymaster).not.toBeNull()
    expect(config.aa.maxCostPerOp).toBeGreaterThan(0n)
    expect(config.aa.maxCostPerOp).toBeLessThanOrEqual(config.aa.standingApproval)
  })

  it('agrees with the deployed testnet parser and keeps network gas tokens separate', () => {
    const config = aaConfig('monad-testnet')
    expect(config.aa).toEqual(deployment('monad-testnet').aa)
    expect(config.chainId).toBe(10143)
    expect(config.aa.gasToken).not.toBe(aaConfig('monad-mainnet').aa.gasToken)
  })
})
