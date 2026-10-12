import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { SponsorDesk } from './sponsor.ts'
import { BoardError } from './board-error.ts'
import { userOpFixture } from './test/userop-fixture.ts'

const fixtures: ReturnType<typeof userOpFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
  vi.restoreAllMocks()
})

function fixture() {
  const f = userOpFixture()
  fixtures.push(f)
  const sponsor = new SponsorDesk({
    sql: f.sql,
    ctx: f.context,
    now: () => f.clock.now,
    fail: (code, message) => new BoardError(code, message),
  })
  const relayReady = vi.spyOn(sponsor, 'ready').mockRejectedValue(new Error('Relay must not be consulted'))
  const relaySend = vi.spyOn(sponsor, 'submit').mockRejectedValue(new Error('Relay must not send'))
  const lifecycle = new AgentLifecycle({
    sql: f.sql,
    context: f.context,
    now: () => f.clock.now,
    sponsor,
    hostedSend: 'userop',
  })
  const prepare = (key: string) =>
    lifecycle.prepareAllowance('agent', f.operator, {
      key,
      token: f.context.deployment.rewardTokens[0]!,
      amount: 100n,
    })
  const sign = (grant: sdk.Delegation) =>
    f.operatorAccount.sign({ hash: sdk.delegationDigest(f.context.deployment, grant) })
  return { ...f, lifecycle, prepare, sign, relayReady, relaySend }
}

it('replaces reward allowances only after operator disable proof, including locally revoked authority', async () => {
  const f = fixture()
  const first = f.prepare('first')
  await f.lifecycle.confirmAllowance('agent', f.operator, 'first', first.hash, await f.sign(first.grant))
  const signedFirst = f.grants.signed(first.hash)
  f.grants.stop(first.hash)
  const next = f.prepare('next')
  expect(next.previous).toEqual([first.hash])
  expect(next.transactions).toHaveLength(1)
  expect(next.transactions[0]!.data).toBe(sdk.disableCalldata(signedFirst))
  expect(f.prepare('next')).toEqual(next)
  const signature = await f.sign(next.grant)
  await expect(f.lifecycle.confirmAllowance('agent', f.operator, 'next', next.hash, signature)).rejects.toMatchObject({
    reason: 'allowance-disable-required',
    retry: 'after-operator',
  })
  expect(f.grants.get(next.hash)?.status).toBe('prepared')
  f.state.disabled = true
  await f.lifecycle.confirmAllowance('agent', f.operator, 'next', next.hash, signature)
  expect(f.grants.get(first.hash)?.status).toBe('disabled')
  expect(f.grants.get(next.hash)?.status).toBe('live')
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
})

it('stops permission use before returning operator calls and reports disabled only after chain proof', async () => {
  const f = fixture()
  const permission = f.grants.prepare(f.operator, {
    kind: 'permission',
    delegator: f.operator,
    agent: f.account.address,
    start: f.clock.now,
    expiry: f.clock.now + 3600,
    salt: 5n,
    terms: {
      type: 'erc20-token-allowance',
      token: f.context.deployment.rewardTokens[0]!,
      recipient: f.account.address,
      amount: 100n,
    },
  })
  await f.grants.confirm(permission.hash, await f.sign(permission.grant))
  const stopped = await f.lifecycle.disablePermission('agent', f.operator, permission.hash)
  expect(stopped).toMatchObject({ permissions: [{ status: 'revoked' }] })
  expect('transactions' in stopped && stopped.transactions).toHaveLength(1)
  f.state.disabled = true
  expect(await f.lifecycle.disablePermission('agent', f.operator, permission.hash)).toMatchObject({
    permissions: [{ status: 'disabled' }],
    transactions: [],
  })
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
})

it('revokes hosted access and both allowances before returning operator calls without a relay', async () => {
  const f = fixture()
  const reward = f.prepare('reward')
  await f.lifecycle.confirmAllowance('agent', f.operator, 'reward', reward.hash, await f.sign(reward.grant))
  f.sql.run(
    'INSERT INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at) VALUES (?,?,?,?,?,?,?)',
    'family',
    'client',
    'agent',
    'public',
    '[]',
    'https://fixture.test/mcp',
    f.clock.now,
  )
  const stopped = await f.lifecycle.revoke('agent', f.operator)
  expect(stopped).toMatchObject({ agent: { state: 'revoked' }, revocation: { hostedAccessStopped: true } })
  expect('transactions' in stopped && stopped.transactions).toHaveLength(2)
  expect(stopped.revocation.onchainPermissionsDisabled).toBeUndefined()
  expect(f.grants.get(reward.hash)?.status).toBe('revoked')
  expect(f.grants.get(f.budget.hash)?.status).toBe('revoked')
  expect(f.sql.all<{ revoked_at: number }>('SELECT revoked_at FROM agent_oauth_families')[0]?.revoked_at).toBe(
    f.clock.now,
  )
  f.state.disabled = true
  expect(await f.lifecycle.revoke('agent', f.operator)).toMatchObject({ transactions: [] })
  expect(f.grants.get(reward.hash)?.status).toBe('disabled')
  expect(f.grants.get(f.budget.hash)?.status).toBe('disabled')
  expect(f.relayReady).not.toHaveBeenCalled()
  expect(f.relaySend).not.toHaveBeenCalled()
})
