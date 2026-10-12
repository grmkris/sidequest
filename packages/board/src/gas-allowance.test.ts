import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { createPublicClient, encodeAbiParameters, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const operator = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const agent = '0x2222222222222222222222222222222222222222'
const now = 1_800_000_000
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const original = sdk.context('monad-testnet', 'main', 'http://rpc.invalid')
  let disabled = false
  const fetcher: typeof fetch = async (_url, init) => {
    // SAFETY: viem serializes its eth_call request as JSON; this fixture never reaches a network.
    const req = (await new Request(_url, init).json()) as { id: number; params: Array<{ to: string }> }
    const result =
      req.params[0]!.to.toLowerCase() === original.deployment.delegation.manager.toLowerCase()
        ? encodeAbiParameters([{ type: 'bool' }], [disabled])
        : encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }], [5_000_000n, true, 0n])
    return Response.json({ jsonrpc: '2.0', id: req.id, result })
  }
  const context: sdk.Ctx = {
    ...original,
    publicClient: createPublicClient({
      chain: original.publicClient.chain,
      transport: http('http://rpc.invalid', { fetchFn: fetcher, retryCount: 0 }),
    }),
  }
  const sponsor = new SponsorDesk({ sql, ctx: context, now: () => now, fail: (_code, message) => new Error(message) })
  const lifecycle = new AgentLifecycle({ sql, context, sponsor, now: () => now })
  lifecycle.agents.create({
    id: 'agent',
    operator: operator.address,
    privyUserId: 'user',
    name: 'Agent',
    registry: context.deployment.identity,
    chainId: context.deployment.chainId,
  })
  lifecycle.agents.bindWallet('agent', 'wallet', agent)
  sql.run("UPDATE agents SET state='active' WHERE id='agent'")
  const prepare = (key = 'gas', amount?: bigint) =>
    lifecycle.prepareGasAllowance('agent', operator.address, { key, ...(amount === undefined ? {} : { amount }) })
  const sign = (grant: sdk.Delegation) => operator.sign({ hash: sdk.delegationDigest(context.deployment, grant) })
  return {
    lifecycle,
    sql,
    context,
    prepare,
    sign,
    disable: () => {
      disabled = true
    },
  }
}

describe('separate operator gas allowance', () => {
  it('defaults to five USDC weekly, freezes its key and keeps reward allowances separate', () => {
    const f = fixture()
    const gas = f.prepare()
    expect(gas.description).toMatchObject({
      kind: 'gas-allowance',
      amount: '5000000',
      periodSeconds: 604800,
      token: f.context.deployment.aa!.gasToken,
      delegate: agent,
    })
    expect(f.prepare().hash).toBe(gas.hash)
    expect(() => f.prepare('gas', 1n)).toThrow('key changed')
    const reward = f.lifecycle.prepareAllowance('agent', operator.address, {
      key: 'gas',
      token: f.context.deployment.aa!.gasToken,
      amount: 5_000_000n,
    })
    expect(reward.hash).not.toBe(gas.hash)
    expect(() => f.lifecycle.prepareGasAllowance('agent', agent, { key: 'other' })).toThrow('another operator')
    expect(() => f.lifecycle.prepareGasAllowance('agent', operator.address, { key: 'bad', amount: 0n })).toThrow(
      'positive',
    )
  })
  it('confirms only the operator signature and reports gas separately from rewards', async () => {
    const f = fixture()
    const gas = f.prepare()
    const signature = await f.sign(gas.grant)
    expect(await f.lifecycle.confirmGasAllowance('agent', operator.address, 'gas', gas.hash, signature)).toMatchObject({
      status: 'live',
    })
    const status = await f.lifecycle.status('agent', operator.address)
    expect(status.allowances).toEqual([])
    expect(status.gasAllowances[0]).toMatchObject({ limit: '5000000', left: '5000000' })
    const wrong = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const other = f.prepare('other')
    const wrongSignature = await wrong.sign({ hash: sdk.delegationDigest(f.context.deployment, other.grant) })
    await expect(
      f.lifecycle.confirmGasAllowance('agent', operator.address, 'other', other.hash, wrongSignature),
    ).rejects.toThrow('delegator')
  })
  it('requires operator-sent disable proof before replacement without sending through the relay', async () => {
    const f = fixture()
    const first = f.prepare()
    await f.lifecycle.confirmGasAllowance('agent', operator.address, 'gas', first.hash, await f.sign(first.grant))
    const edit = f.lifecycle.editGasAllowance('agent', operator.address, { key: 'edit', amount: 2_000_000n })
    expect(edit.previous).toEqual([first.hash])
    expect(edit.transactions[0]?.to).toBe(f.context.deployment.delegation.manager)
    const signature = await f.sign(edit.grant)
    await expect(
      f.lifecycle.confirmGasAllowance('agent', operator.address, 'edit', edit.hash, signature),
    ).rejects.toThrow('Disable the previous')
    expect(f.lifecycle.grants.get(edit.hash)?.status).toBe('prepared')
    f.disable()
    expect(
      await f.lifecycle.confirmGasAllowance('agent', operator.address, 'edit', edit.hash, signature),
    ).toMatchObject({ status: 'live' })
    expect(f.lifecycle.grants.get(first.hash)?.status).toBe('disabled')
  })
  it('stops hosted use immediately and calls it disabled only after chain proof', async () => {
    const f = fixture()
    const gas = f.prepare()
    await f.lifecycle.confirmGasAllowance('agent', operator.address, 'gas', gas.hash, await f.sign(gas.grant))
    expect(await f.lifecycle.revokeGasAllowance('agent', operator.address, gas.hash)).toMatchObject({
      status: 'revoked',
    })
    expect(f.lifecycle.grants.get(gas.hash)?.status).toBe('revoked')
    f.disable()
    expect(await f.lifecycle.revokeGasAllowance('agent', operator.address, gas.hash)).toMatchObject({
      status: 'disabled',
      transactions: [],
    })
    await expect(f.lifecycle.revokeGasAllowance('agent', agent, gas.hash)).rejects.toThrow('another operator')
  })
})
