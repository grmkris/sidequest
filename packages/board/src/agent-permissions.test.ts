/** Permissions on demand end to end on real storage: request, operator review and signature, grant, standing reuse, use. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, decodeFunctionData, erc20Abi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutor, type AgentToolRequest } from './agent-executor.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { AgentPermissions } from './agent-permissions.ts'
import type { AgentSigning } from './agent-signing.ts'
import { decodeGrantBatch } from './hire-batch.ts'
import type { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const now = 1_791_000_000
const agentAddress = '0x2222222222222222222222222222222222222222' as const
const recipient = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  vi.spyOn(ctx.publicClient, 'readContract').mockImplementation(async (request) => {
    if (request.functionName === 'disabledDelegations') return false
    if (request.functionName === 'callCounts' || request.functionName === 'spentMap') return 0n
    if (request.functionName === 'getAvailableAmount') return [100n, true, 0n]
    throw new Error(`Unexpected chain read ${request.functionName}`)
  })
  const operatorAccount = privateKeyToAccount(generatePrivateKey())
  const operator = operatorAccount.address
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const sponsor = {
    ready: async () => {},
    submit: async () => {
      throw new Error('a permission request sends nothing')
    },
  } as unknown as SponsorDesk
  const clock = { now }
  const deps = { sql, context: ctx, now: () => clock.now }
  const permissions = new AgentPermissions(deps)
  const prepareTool = async (request: AgentToolRequest) => {
    if (request.tool !== 'request_permissions') throw new Error(`unexpected tool ${request.tool}`)
    return {
      request: permissions.parse(
        permissions.agents.get('agent'),
        request.args.permission as sdk.PermissionRequest,
        request.args.standing === true,
      ),
    }
  }
  const executor = new AgentExecutor({
    ...deps,
    sponsor,
    signing: {} as AgentSigning,
    prepareTool,
    verifyToolSigning: async () => 'ok',
  })
  executor.agents.create({
    id: 'agent',
    operator,
    privyUserId: 'did:privy:test',
    name: 'agent',
    registry: ctx.deployment.identity,
    chainId: ctx.deployment.chainId,
  })
  executor.agents.bindWallet('agent', 'wallet', agentAddress)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('agent', state)
  const lifecycle = new AgentLifecycle({ ...deps, sponsor })
  const token = ctx.deployment.rewardTokens[0]!
  const periodic = (amount: bigint, days = 7): sdk.PermissionRequest => ({
    chainId: ctx.deployment.chainId,
    from: operator,
    to: agentAddress,
    rules: [{ type: 'expiry', data: { timestamp: now + days * 86_400 } }],
    permission: {
      type: 'erc20-token-periodic',
      isAdjustmentAllowed: true,
      data: {
        tokenAddress: token,
        periodAmount: amount.toString(),
        periodDuration: 86_400,
        recipient,
        justification: 'Mercator top-ups',
      },
    },
  })
  const request = (key: string, permission: sdk.PermissionRequest, standing = false) =>
    executor.execute({
      agentId: 'agent',
      boardId: 'public',
      operationKey: key,
      tool: 'request_permissions',
      args: { permission, standing },
    })
  const sign = async (hash: Hex) =>
    operatorAccount.sign({
      hash: sdk.delegationDigest(ctx.deployment, sdk.parseDelegation(permissions.grants.get(hash)!.delegation_json)),
    })
  return { ctx, operator, token, permissions, lifecycle, periodic, request, sign, db, clock }
}

it('asks the operator, who may shorten or lower before signing; the retry returns the signed permission', async () => {
  const f = fixture()
  const asked = await f.request('p1', f.periodic(10n), true)
  if (asked.status !== 'approval') throw new Error('expected an approval')
  expect(asked.approval).toMatchObject({ kind: 'permission', status: 'pending' })
  expect(() => f.lifecycle.prepareApproval(asked.approval.id, f.operator, { amount: 11n })).toThrow(/only lower/)
  expect(() => f.lifecycle.prepareApproval(asked.approval.id, f.operator, { expiry: now + 8 * 86_400 })).toThrow(
    /only shorten/,
  )
  const prepared = f.lifecycle.prepareApproval(asked.approval.id, f.operator, {
    amount: 5n,
    expiry: now + 3 * 86_400,
  }) as { hash: Hex; adjusted: boolean; risks: { code: string }[] }
  expect(prepared.adjusted).toBe(true)
  expect(prepared.risks.map((risk) => risk.code)).toContain('adjusted')
  // The same choice re-prepares the same template; signing another approval's template is refused.
  expect(
    (
      f.lifecycle.prepareApproval(asked.approval.id, f.operator, { amount: 5n, expiry: now + 3 * 86_400 }) as {
        hash: Hex
      }
    ).hash,
  ).toBe(prepared.hash)
  await expect(
    f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(prepared.hash), {
      hash: `0x${'00'.repeat(32)}`,
    }),
  ).rejects.toThrow()
  const decided = await f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(prepared.hash), {
    hash: prepared.hash,
    standing: true,
  })
  expect(decided).toMatchObject({ status: 'approved' })
  const granted = await f.request('p1', f.periodic(10n), true)
  expect(granted).toMatchObject({
    status: 'confirmed',
    result: {
      permissionId: prepared.hash,
      granted: 'operator',
      delegationManager: f.ctx.deployment.delegation.manager,
      dependencies: [],
      permission: { type: 'erc20-token-periodic', amount: '5', recipient, expiresAt: now + 3 * 86_400 },
    },
  })
  expect((granted as { result: { context: Hex } }).result.context).toBe(
    sdk.permissionContext(f.permissions.grants.signed(prepared.hash)),
  )
  expect(await f.request('p1', f.periodic(10n), true)).toEqual(granted)
})

it('grants a request a standing rule covers without asking, and asks again for anything wider or after it stops', async () => {
  const f = fixture()
  const asked = await f.request('rule', f.periodic(5n), true)
  if (asked.status !== 'approval') throw new Error('expected an approval')
  const prepared = f.lifecycle.prepareApproval(asked.approval.id, f.operator) as { hash: Hex }
  await f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(prepared.hash), {
    hash: prepared.hash,
    standing: true,
  })
  const covered = await f.request('covered', f.periodic(3n, 2))
  expect(covered).toMatchObject({
    status: 'confirmed',
    result: { permissionId: prepared.hash, granted: 'standing-rule' },
  })
  expect(await f.request('wider', f.periodic(6n, 2))).toMatchObject({ status: 'approval' })
  expect(await f.request('longer', f.periodic(3n, 8))).toMatchObject({ status: 'approval' })
  const agent = f.permissions.agents.get('agent')
  expect(f.permissions.list(agent)).toMatchObject([{ permissionId: prepared.hash, status: 'live', standing: true }])
  expect(f.permissions.stop(agent, prepared.hash)).toEqual({ permissionId: prepared.hash, status: 'revoked' })
  expect(await f.request('after-stop', f.periodic(3n, 2))).toMatchObject({ status: 'approval' })
})

it('a rejection ends the request and answers every retry; a malformed request is refused before any approval', async () => {
  const f = fixture()
  const asked = await f.request('no', f.periodic(5n))
  if (asked.status !== 'approval') throw new Error('expected an approval')
  await f.lifecycle.decideApproval(asked.approval.id, f.operator, false)
  expect(await f.request('no', f.periodic(5n))).toMatchObject({ status: 'rejected' })
  // A client that retries again, unsure whether its last retry arrived, hears the same answer (ADR-0021).
  expect(await f.request('no', f.periodic(5n))).toMatchObject({ status: 'rejected', result: { status: 'rejected' } })
  await expect(f.request('bad', { ...f.periodic(5n), to: recipient })).rejects.toMatchObject({
    code: 'invalid',
    reason: 'permission-request',
    retry: 'new-key',
  })
  expect(f.db.prepare("SELECT count(*) AS n FROM approvals WHERE kind='permission'").get()).toEqual({ n: 1 })
})

it('use builds one manager redemption inside the terms, and refuses more', async () => {
  const f = fixture()
  const asked = await f.request('use', f.periodic(5n))
  if (asked.status !== 'approval') throw new Error('expected an approval')
  const prepared = f.lifecycle.prepareApproval(asked.approval.id, f.operator) as { hash: Hex }
  const signature = await f.sign(prepared.hash)
  await f.lifecycle.decideApproval(asked.approval.id, f.operator, true, signature, { hash: prepared.hash })
  const agent = f.permissions.agents.get('agent')
  const call = f.permissions.use(agent, prepared.hash, { transfer: { amount: '5' } })
  expect(call.transactions[0]!.to).toBe(f.ctx.deployment.delegation.manager)
  const [nested] = decodeGrantBatch(call.transactions[0]!.data)
  expect(nested!.grant.signature.toLowerCase()).toBe(signature.toLowerCase())
  expect(decodeFunctionData({ abi: erc20Abi, data: nested!.execution.callData }).args).toEqual([recipient, 5n])
  expect(() => f.permissions.use(agent, prepared.hash, { transfer: { amount: '6' } })).toThrow(/exceeds/)
  expect(() =>
    f.permissions.use(agent, prepared.hash, { transfer: { amount: '1', recipient: agentAddress as Address } }),
  ).toThrow(/different recipient/)
  expect(() => f.permissions.use(agent, `0x${'11'.repeat(32)}`, { transfer: { amount: '1' } })).toThrow(
    /No such permission/,
  )
})

it('replaces a stale unsigned template so the operator never signs a backdated period anchor (VV2-023)', async () => {
  const f = fixture()
  const asked = await f.request('fresh', f.periodic(10n), false)
  if (asked.status !== 'approval') throw new Error('expected an approval')
  const first = f.lifecycle.prepareApproval(asked.approval.id, f.operator) as {
    hash: Hex
    description: { validAfter: number }
  }
  f.clock.now = now + 599
  expect((f.lifecycle.prepareApproval(asked.approval.id, f.operator) as { hash: Hex }).hash).toBe(first.hash)
  f.clock.now = now + 601
  const fresh = f.lifecycle.prepareApproval(asked.approval.id, f.operator) as {
    hash: Hex
    description: { validAfter: number }
  }
  expect(fresh.hash).not.toBe(first.hash)
  expect(fresh.description.validAfter).toBe(now + 601)
  // Signing the earlier, now stale template is refused even though it was frozen for this approval (VV2-023).
  f.clock.now = now + 901
  await expect(
    f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(first.hash), { hash: first.hash }),
  ).rejects.toThrow(/out of date/)
  const decided = await f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(fresh.hash), {
    hash: fresh.hash,
  })
  expect(decided).toMatchObject({ status: 'approved' })
})

it('keeps one template for an allowance across windows, whose bytes carry no period anchor (VV2-026)', async () => {
  const f = fixture()
  const allowance: sdk.PermissionRequest = {
    chainId: f.ctx.deployment.chainId,
    from: f.operator,
    to: agentAddress,
    rules: [{ type: 'expiry', data: { timestamp: now + 3 * 86_400 } }],
    permission: {
      type: 'erc20-token-allowance',
      isAdjustmentAllowed: false,
      data: { tokenAddress: f.token, allowanceAmount: '7', recipient },
    },
  }
  const asked = await f.request('allow', allowance, false)
  if (asked.status !== 'approval') throw new Error('expected an approval')
  const first = f.lifecycle.prepareApproval(asked.approval.id, f.operator) as { hash: Hex }
  f.clock.now = now + 3_600
  expect((f.lifecycle.prepareApproval(asked.approval.id, f.operator) as { hash: Hex }).hash).toBe(first.hash)
  expect(
    await f.lifecycle.decideApproval(asked.approval.id, f.operator, true, await f.sign(first.hash), {
      hash: first.hash,
    }),
  ).toMatchObject({ status: 'approved' })
})
