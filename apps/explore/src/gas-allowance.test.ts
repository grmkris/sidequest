import * as sdk from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import {
  gasBudgetAmount,
  gasBudgetDisables,
  readGasBudgetIntent,
  readPreparedGasBudget,
  reviewGasBudget,
  writeGasBudgetIntent,
} from './gas-allowance.ts'

const deployment = sdk.deployment('monad-testnet')
const operator = deployment.admin
const agent = deployment.core
const now = 1_000_000
const context = { deployment, stack: deployment.stacks.main! }
const spec: sdk.GrantSpec = {
  kind: 'gas-allowance',
  delegator: operator,
  agent,
  token: deployment.aa!.gasToken,
  amount: 5_000_000n,
  periodSeconds: 604800,
  salt: 1n,
  start: now,
}
const grant = sdk.buildGrant(context, spec)
const prepared = readPreparedGasBudget({
  hash: sdk.delegationHash(grant),
  grant: JSON.parse(sdk.delegationJson(grant)),
  description: { validAfter: now },
  previous: [],
  transactions: [],
})

describe('separate USDC gas budget', () => {
  it('defaults to five USDC and refuses zero, exponent notation or excess precision', () => {
    expect(gasBudgetAmount()).toBe(5_000_000n)
    expect(gasBudgetAmount('0.000001')).toBe(1n)
    for (const amount of ['0', '-1', '1e3', '1.0000001']) expect(() => gasBudgetAmount(amount)).toThrow()
  })
  it('reviews exactly the configured token, operator, agent, amount, period and expiry', () => {
    expect(reviewGasBudget({ deployment, prepared, operator, agent, amount: 5_000_000n, now }).hash).toBe(prepared.hash)
    expect(() => reviewGasBudget({ deployment, prepared, operator, agent, amount: 6_000_000n, now })).toThrow()
    expect(() =>
      reviewGasBudget({ deployment, prepared, operator, agent: deployment.factory, amount: 5_000_000n, now }),
    ).toThrow()
    expect(() =>
      reviewGasBudget({ deployment, prepared, operator, agent, amount: 5_000_000n, now: now + sdk.ALLOWANCE_VALIDITY }),
    ).toThrow()
  })
  it('accepts only disables of the exact old operator grants and refuses missing or duplicated calls', () => {
    const tx = {
      to: deployment.delegation.manager,
      data: sdk.disableCalldata(grant),
      chainId: deployment.chainId,
      value: '0',
      description: 'Disable gas budget',
    }
    expect(gasBudgetDisables(deployment, operator, [prepared.hash], [tx])).toEqual([tx])
    expect(() => gasBudgetDisables(deployment, agent, [prepared.hash], [tx])).toThrow()
    expect(() => gasBudgetDisables(deployment, operator, [prepared.hash], [{ ...tx, to: deployment.core }])).toThrow()
    expect(() => gasBudgetDisables(deployment, operator, [prepared.hash], [])).toThrow()
    expect(() => gasBudgetDisables(deployment, operator, [prepared.hash], [tx, tx])).toThrow()
  })
  it('keeps a request key across reloads and fails closed on corrupt or unavailable storage', () => {
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
    const intent = { kind: 'grant' as const, key: 'stable-key', amount: '5' }
    writeGasBudgetIntent(storage, 'one', intent)
    expect(readGasBudgetIntent(storage, 'one')).toEqual(intent)
    saved = '{'
    expect(() => readGasBudgetIntent(storage, 'one')).toThrow()
    expect(() => writeGasBudgetIntent({ ...storage, setItem: () => {} }, 'one', intent)).toThrow(/unavailable/)
  })
})
