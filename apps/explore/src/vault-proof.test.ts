import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  type TransactionReceipt,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { vaultOperationGuards } from './vault-proof.ts'
import type { VaultIntent, VaultIntentCheckpoint } from './vault-lock.ts'

const owner = '0x1111111111111111111111111111111111111111'
const account = '0x2222222222222222222222222222222222222222'
const other = '0x3333333333333333333333333333333333333333'
const deployment = sdk.deployment('monad-testnet')
const vault = deployment.sidequest!.vault
const units = 100n * 10n ** 18n
const approval = {
  chainId: deployment.chainId,
  to: deployment.sidequest!.factory,
  data: encodeFunctionData({ abi: sdk.sideTokenAbi, functionName: 'approve', args: [vault, units] }),
  value: '0' as const,
  description: 'Approve',
}
const delegate = {
  ...approval,
  to: vault,
  data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'delegate', args: [account, units] }),
  description: 'Delegate',
}
const tx = { ...delegate, to: owner as Address, data: sdk.batchCalldata([approval, delegate]) }
const hash = `0x${'ab'.repeat(32)}` as const

function fixture(txs: VaultIntent['txs'] = [tx]) {
  let code = `0xef0100${deployment.delegation.delegator.slice(2)}`
  let savedId = 'intent'
  const ctx: sdk.Ctx = {
    deployment,
    stack: deployment.stacks.main!,
    publicClient: createPublicClient({
      transport: custom({
        request: async ({ method }) => {
          if (method !== 'eth_getCode') throw new Error('Unexpected RPC read')
          return code
        },
      }),
    }),
  }
  const intent: VaultIntent = { id: 'intent', kind: 'delegate', account, txs }
  const storage = { getItem: () => JSON.stringify({ ...intent, id: savedId }) }
  const checkpoint: VaultIntentCheckpoint = {
    read: async () => storage.getItem(),
    write: async () => {
      throw new Error('guard must never write')
    },
  }
  return {
    guards: vaultOperationGuards(ctx, storage, 'pointer', intent, owner, checkpoint),
    intent,
    revoke: () => {
      code = '0x'
    },
    supersede: () => {
      savedId = 'newer'
    },
  }
}

function delegated(
  changes: {
    account?: Address
    delegator?: Address
    payer?: Address
    assets?: bigint
    shares?: bigint
    address?: Address
  } = {},
): TransactionReceipt['logs'][number] {
  return {
    address: changes.address ?? vault,
    topics: encodeEventTopics({
      abi: sdk.stakeVaultAbi,
      eventName: 'Delegated',
      args: {
        account: changes.account ?? account,
        delegator: changes.delegator ?? owner,
        payer: changes.payer ?? owner,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [changes.assets ?? units, changes.shares ?? units],
    ),
    removed: false,
    blockHash: hash,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: hash,
    transactionIndex: 0,
  }
}

describe('shared vault action proofs', () => {
  it('rechecks the existing 7702 delegator code and the recovery pointer', async () => {
    const f = fixture()
    expect(await f.guards.sendGuard()).toBeNull()
    f.revoke()
    expect(await f.guards.sendGuard()).toMatch(/batch permission changed/)
    const stale = fixture()
    stale.supersede()
    expect(await stale.guards.sendGuard()).toMatch(/changed in another tab/)
  })
  it('confirms only the exact vault Delegated event and does not depend on current code after mining', async () => {
    const f = fixture()
    f.revoke()
    expect(f.guards.receiptGuard({ logs: [delegated()] }, f.intent.txs)).toBeNull()
  })
  it('refuses a stale local pointer even if the prior intent still has a valid 7702 delegate', async () => {
    const f = fixture([delegate])
    const storage = { getItem: () => JSON.stringify(f.intent) }
    const checkpoint: VaultIntentCheckpoint = {
      read: async () => JSON.stringify({ ...f.intent, id: 'newer' }),
      write: async () => {},
    }
    const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
    const guards = vaultOperationGuards(ctx, storage, 'pointer', f.intent, owner, checkpoint)
    await expect(guards.sendGuard()).rejects.toThrow(/changed in another tab/)
  })
  it('a successful no-op or an event from a different contract proves no requested delegation', () => {
    const f = fixture()
    expect(f.guards.receiptGuard({ logs: [] }, f.intent.txs)).toMatch(/Not backed/)
    expect(f.guards.receiptGuard({ logs: [delegated({ address: other })] }, f.intent.txs)).toMatch(/Not backed/)
  })
  for (const changes of [
    { account: other },
    { delegator: other },
    { payer: other },
    { assets: units - 1n },
    { shares: 0n },
  ] as const) {
    it(`conflicting delegation proof cannot confirm or authorize a resend: ${Object.keys(changes)[0]}`, () => {
      const f = fixture()
      expect(() => f.guards.receiptGuard({ logs: [delegated(changes)] }, f.intent.txs)).toThrow(
        /different backing action/,
      )
    })
  }
  it('duplicate, malformed or removed events require reconciliation rather than another send', () => {
    const f = fixture()
    expect(() => f.guards.receiptGuard({ logs: [delegated(), delegated()] }, f.intent.txs)).toThrow(
      /different backing action/,
    )
    expect(() => f.guards.receiptGuard({ logs: [{ ...delegated(), data: '0x' }] }, f.intent.txs)).toThrow()
    expect(() => f.guards.receiptGuard({ logs: [{ ...delegated(), removed: true }] }, f.intent.txs)).toThrow(/removed/)
  })
  it('direct and retained two-step delegation require the same final event, not an approval receipt', async () => {
    const f = fixture([approval, delegate])
    f.revoke()
    expect(await f.guards.sendGuard()).toBeNull()
    expect(f.guards.receiptGuard({ logs: [] }, [approval])).toBeNull()
    expect(f.guards.receiptGuard({ logs: [] }, [delegate])).toMatch(/Not backed/)
    expect(f.guards.receiptGuard({ logs: [delegated()] }, [delegate])).toBeNull()
  })
})
