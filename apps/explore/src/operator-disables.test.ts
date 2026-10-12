import * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import {
  afterOperatorSend,
  operatorRequest,
  readDisableJournal,
  requirePermissionReadback,
  reviewOperatorDisables,
  writeDisableJournal,
  type DisableJournal,
} from './operator-disables.ts'

const deployment = sdk.deployment('monad-testnet')
const operator = deployment.admin
const agent = deployment.core
const grant = sdk.buildGrant(
  { deployment, stack: deployment.stacks.main! },
  {
    kind: 'allowance',
    delegator: operator,
    agent,
    token: deployment.rewardTokens[0]!,
    amount: 25_000_000n,
    salt: 1n,
    start: 1_000_000,
  },
)
const hash = sdk.delegationHash(grant)
const tx = {
  to: deployment.delegation.manager,
  data: sdk.disableCalldata(grant),
  value: '0' as const,
  chainId: deployment.chainId,
  description: 'Disable previous budget',
}
const review = (response: unknown) => reviewOperatorDisables({ deployment, operator, agent, response, hashes: [hash] })

describe('operator-paid permission disables', () => {
  it('pins manager, chain, owner, agent and the selected grant; refuses duplicates and non-disables', () => {
    expect(review({ transactions: [tx] })).toEqual([tx])
    for (const bad of [
      { ...tx, to: deployment.core },
      { ...tx, chainId: 143 },
      { ...tx, value: '1' },
      { ...tx, data: sdk.approveCall(deployment.rewardTokens[0]!, deployment.core, 1n).data },
    ])
      expect(() => review({ transactions: [bad] })).toThrow()
    expect(() => review({ transactions: [tx, tx] })).toThrow()
    expect(() =>
      reviewOperatorDisables({ deployment, operator: agent, agent, response: { transactions: [tx] } }),
    ).toThrow()
    expect(() =>
      reviewOperatorDisables({ deployment, operator, agent: deployment.factory, response: { transactions: [tx] } }),
    ).toThrow()
    expect(() =>
      reviewOperatorDisables({ deployment, operator, agent, response: { transactions: [tx] }, hashes: [] }),
    ).toThrow()
  })
  it('refuses the old relay response instead of treating it as an operator readback', () => {
    expect(() => review({ status: 'confirmed', result: [] })).toThrow()
    expect(() => review({ transactions: undefined })).toThrow()
  })
  it('keeps the exact request key and original calls across reload and switches mined sends to readback only', () => {
    let saved: string | null = null
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value
      },
      removeItem: () => {
        saved = null
      },
    }
    const journal: DisableJournal = {
      key: 'original-key',
      request: { kind: 'permission', permissionId: hash },
      phase: 'send',
      transactions: [tx],
    }
    writeDisableJournal(storage, 'one', journal)
    expect(readDisableJournal(storage, 'one')).toEqual(journal)
    const readback = afterOperatorSend(journal)
    writeDisableJournal(storage, 'one', readback)
    expect(readDisableJournal(storage, 'one')).toEqual({ ...journal, phase: 'readback' })
    expect(() => afterOperatorSend(readback)).toThrow()
    saved = '{'
    expect(() => readDisableJournal(storage, 'one')).toThrow()
    expect(() => writeDisableJournal({ ...storage, setItem: () => {} }, 'one', journal)).toThrow(/unavailable/)
  })
  it('builds the repeatable operator API request for agent, permission and reward replacement', () => {
    expect(operatorRequest({ kind: 'agent' }, 'key')).toEqual({ action: 'revoke', body: {} })
    expect(operatorRequest({ kind: 'permission', permissionId: hash }, 'original-key')).toEqual({
      action: 'execute',
      body: { tool: 'revoke_permission', args: { permissionId: hash }, operationKey: 'original-key' },
    })
    expect(
      operatorRequest(
        { kind: 'reward', token: deployment.rewardTokens[0]!, amount: '25000000', displayAmount: '25' },
        'original-key',
      ),
    ).toEqual({
      action: 'allowance-prepare',
      body: { key: 'original-key', token: deployment.rewardTokens[0]!, amount: '25000000' },
    })
  })
  it('requires the selected permission to be disabled or expired before clearing the journal', () => {
    const row = { permissionId: hash, status: 'revoked', expiresAt: 2_000_000 }
    expect(() => requirePermissionReadback({ permissions: [row] }, hash, 1_000_000)).toThrow(/unconfirmed/)
    expect(() => requirePermissionReadback({ permissions: [] }, hash, 1_000_000)).toThrow(/unconfirmed/)
    expect(() =>
      requirePermissionReadback({ permissions: [{ ...row, status: 'disabled' }] }, hash, 1_000_000),
    ).not.toThrow()
    expect(() => requirePermissionReadback({ permissions: [row] }, hash, 2_000_001)).not.toThrow()
  })
  it('permits a subset of prior disables when other allowances are already disabled or expired', () => {
    expect(review({ transactions: [] })).toEqual([])
    expect(review({ transactions: [tx] })).toEqual([tx])
  })
})
