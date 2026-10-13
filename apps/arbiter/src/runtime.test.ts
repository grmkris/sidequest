import * as sdk from '@sidequest/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { arbiterAccounts, boardUrls, sendFundedCancellation } from './runtime.ts'

const oldKey = generatePrivateKey(),
  v1Key = generatePrivateKey()
const v1 = privateKeyToAccount(v1Key)
const d = sdk.deployment('monad-testnet')
const v1Only: sdk.Deployment = {
  ...d,
  network: 'monad-mainnet',
  chainId: 143,
  arbitrator: v1.address,
  stacks: { main: { ...d.stacks.main!, kind: 'sidequest-v1' } },
}
const cancellationFixture = (account: typeof v1, chainId: number, balance = 240_000n) => {
  const send = vi.fn(async () => sdk.hashText('cancellation'))
  // SAFETY: cancellation uses only this account, chain id and send method; no other wallet action is exercised.
  const wallet = Object.assign({} as sdk.Wallet, { account, chain: { id: chainId }, sendTransaction: send })
  // SAFETY: the fixture fills every public-client method the cancellation sender calls.
  const reads = Object.assign({} as PublicClient, {
    getChainId: async () => chainId,
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getBalance: vi.fn(async () => balance),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  })
  return { wallet, reads, send }
}

describe('arbiter runtime keys', () => {
  it('v1-only mainnet never reads or requires the old legacy secret', () => {
    expect(arbiterAccounts(v1Only, { SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: v1Key }).map((a) => a.address)).toEqual([
      v1.address,
    ])
    expect(
      arbiterAccounts(v1Only, {
        SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: v1Key,
        ARBITRATOR_PRIVATE_KEY: 'unset',
        V1_ARBITRATOR_PRIVATE_KEY: oldKey,
      }).map((a) => a.address),
    ).toEqual([v1.address])
    expect(() => arbiterAccounts(v1Only, { ARBITRATOR_PRIVATE_KEY: oldKey })).toThrow(
      'SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY is not set',
    )
  })
  it('invalid keys never appear in an error, and duplicate accounts sign in once', () => {
    expect(() => arbiterAccounts(v1Only, { SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: 'private-value' })).toThrow(
      'SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY is invalid',
    )
    const mixed = { ...v1Only }
    expect(
      arbiterAccounts(mixed, { ARBITRATOR_PRIVATE_KEY: v1Key, SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: v1Key }),
    ).toHaveLength(1)
  })
  it('mainnet refuses the testnet key and a key that differs from the promoted arbitrator', () => {
    expect(() => arbiterAccounts(v1Only, { V1_ARBITRATOR_PRIVATE_KEY: v1Key })).toThrow('SIDEQUEST_MAINNET')
    expect(() => arbiterAccounts(v1Only, { SIDEQUEST_MAINNET_ARBITRATOR_PRIVATE_KEY: oldKey })).toThrow(
      'address mismatch',
    )
  })
})

describe('funded cancellation sender', () => {
  const tx: sdk.TxRequest = {
    to: v1Only.stacks.main!.evaluator,
    chainId: 143,
    data: '0x1234',
    value: '0',
    description: 'Cancel',
  }
  it('checks the selected account pending balance and pins the estimated gas/fee reserve', async () => {
    const f = cancellationFixture(v1, 143)
    await sendFundedCancellation(f.wallet, f.reads, tx)
    expect(f.reads.getBalance).toHaveBeenCalledWith({ address: v1.address, blockTag: 'pending' })
    expect(f.send).toHaveBeenCalledWith({
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: 120_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })
  })
  it('unfunded and wrong-chain cancellations never broadcast', async () => {
    const f = cancellationFixture(v1, 143, 239_999n)
    await expect(sendFundedCancellation(f.wallet, f.reads, tx)).rejects.toThrow(
      'Fund the arbitrator cancellation gas reserve',
    )
    expect(f.send).not.toHaveBeenCalled()
    await expect(sendFundedCancellation(f.wallet, f.reads, { ...tx, chainId: 10143 })).rejects.toThrow(
      'chain/value refused',
    )
    expect(f.send).not.toHaveBeenCalled()
  })
})

it('BOARD_URLS accepts both stage origins while retaining the single-board fallback', () => {
  expect(
    boardUrls({ BOARD_URLS: ' https://dev.sidequest.exchange,https://sidequest.exchange,https://sidequest.exchange ' }),
  ).toEqual(['https://dev.sidequest.exchange', 'https://sidequest.exchange'])
  expect(boardUrls({ BOARD_URL: 'https://sidequest.exchange' })).toEqual(['https://sidequest.exchange'])
  expect(() => boardUrls({})).toThrow('BOARD_URL')
})
