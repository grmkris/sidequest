/** Validate the wire contract against the real Board/SQLite and hosted executor fixtures.
 * Goblin's client compiles at tools/list and validates non-error structuredContent at tools/call.
 */
import { DatabaseSync } from 'node:sqlite'
import { Ajv } from 'ajv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { AgentExecutor, Board, fromNodeSqlite, type AgentSigning, type SponsorDesk } from '@sidequest/board'
import { fromNodeSqlite as asyncSqlite } from '@sidequest/indexer'
import { mcpRoute } from '../src/mcp.ts'
import { tools as boardTools, toJson } from '../src/tools.ts'
import { agentTools } from '../src/tools-agents.ts'
import { directoryTools } from '../src/directory.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { feedTools, writeFeed } from '../src/feed.ts'
import { commonsTools } from '../src/commons/tools.ts'
import { runAgent } from '../src/agent-runtime.ts'
import type { OAuthGrant } from '../src/oauth.ts'
import type { BoardCall } from '../src/board.ts'

const origin = 'https://sidequest.test'
const operator = '0x1111111111111111111111111111111111111111' as const
const wallet = '0x2222222222222222222222222222222222222222' as const
const grant: OAuthGrant = {
  owner: 'operator',
  address: wallet,
  chainId: 10143,
  scopes: ['sidequest:read', 'sidequest:hire', 'sidequest:work'],
  agentIds: ['fixture-agent'],
  registryAgentId: '7',
  clientId: 'fixture-client',
  resource: `${origin}/mcp`,
}
const registry = { ...boardTools, ...agentTools, ...directoryTools, ...tenantTools, ...feedTools, ...commonsTools }
const lanes = [
  { name: 'legacy', params: {} },
  { name: '2026-07-28', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
]
const databases: DatabaseSync[] = []
const database = () => {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  return db
}
const wire = (output: unknown): unknown => JSON.parse(toJson({ ok: true, result: output }))
const fixtures: Array<{ name: string; output: unknown }> = []
afterAll(() => {
  for (const db of databases) db.close()
})

beforeAll(async () => {
  // Same hermetic RPC reads as deadline-retry.test.ts and the board's list-tasks.test.ts.
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'paused' || functionName === 'policyListed') return false
    if (functionName === 'minimumCreatorBond') return 10n ** 18n
    if (functionName === 'unfilledForfeitBps') return 2500
    if (functionName === 'CANCEL_GRACE') return 600
    if (functionName === 'treasury') return base.deployment.sidequest!.safe
    if (functionName === 'UNSTAKE_DELAY') return 259200
    if (functionName === 'decimals') return 0
    if (functionName === 'symbol') return 'mUSD'
    if (functionName === 'allowance') return 0n
    if (functionName === 'margin' || functionName === 'MIN_REVIEW_WINDOW' || functionName === 'MIN_DISPUTE_WINDOW')
      return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const context = {
    ...base,
    publicClient: {
      ...base.publicClient,
      readContract,
      getBlockNumber: async () => 100n,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    },
  } as unknown as sdk.Ctx
  const now = Math.floor(Date.now() / 1000)
  const board = new Board(fromNodeSqlite(database()), {
    network: 'monad-testnet',
    contexts: { main: context },
    domain: 'sidequest.test',
    uri: origin,
    manifestBaseUrl: `${origin}/offers`,
    now: () => now,
  })
  const run = (name: string, args: Record<string, unknown> = {}) =>
    boardTools[name]!.run(board, { address: wallet }, args, { network: 'monad-testnet', mcpSession: undefined })
  const offer = {
    title: 'Schema fixture hire',
    brief: 'Brief',
    acceptanceCriteria: ['works'],
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: now + 86_400,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  const token = context.deployment.rewardTokens[0]!
  const task = (await run('create_task', { ...offer, token, reward: '1' })) as { taskId: string }
  const request = (await run('request_quotes', { ...offer, tokens: [token], quoteDeadline: now + 3_600 })) as {
    requestId: string
  }
  for (const [name, args] of [
    ['list_tasks', { role: 'creator' }],
    ['list_tasks', { compact: true, limit: 2 }],
    ['task_index', { compact: true, limit: 2 }],
    ['get_task', { taskId: task.taskId }],
    ['list_quote_requests', {}],
    ['list_quote_requests', { recent: true }],
    ['list_quote_requests', { mine: true }],
    ['get_quote_request', { requestId: request.requestId }],
    ['list_quotes', { requestId: request.requestId }],
    ['whoami', {}],
    ['protocol_info', {}],
    ['list_applications', { taskId: task.taskId }],
  ] as const)
    fixtures.push({ name, output: wire(await run(name, args)) })

  const events = asyncSqlite(database())
  await writeFeed(
    events,
    'monad-testnet',
    [
      {
        id: 'schema-event',
        address: wallet,
        kind: 'request.opened',
        requestId: request.requestId,
        summary: 'Request opened',
        occurredAt: now,
      },
    ],
    now,
  )
  fixtures.push({
    name: 'inbox',
    output: wire(await feedTools.inbox.run({ sql: events, network: 'monad-testnet', now }, wallet, {})),
  })

  addCommonsFixtures(now)

  // Replay the real executor fixture from agent-auto-select.test.ts; no network sends or provider calls.
  const sql = fromNodeSqlite(database())
  const executor = new AgentExecutor({
    sql,
    context,
    now: () => now,
    sponsor: {
      submit: async () => ({ status: 'confirmed', txHash: `0x${'ab'.repeat(32)}` }),
      ready: async () => {},
    } as unknown as SponsorDesk,
    signing: {
      signTool: async (_agent: string, _operation: string, _data: string, verify: () => Promise<string>) => {
        await verify()
        return `0x${'cd'.repeat(65)}`
      },
    } as unknown as AgentSigning,
    prepareTool: async (input) => {
      if (input.tool === 'report_transaction') return { reported: true }
      if (input.tool === 'select_worker')
        return { nonce: '7', sign: { typedData: JSON.stringify({ message: { nonce: '7' } }) } }
      if (input.tool === 'submit_selection') return { taskId: input.args.taskId, selected: true }
      throw new Error(`unexpected executor tool: ${input.tool}`)
    },
    verifyToolSigning: async () => 'ok',
  })
  executor.agents.create({
    id: 'fixture-agent',
    operator,
    privyUserId: 'did:privy:fixture',
    name: 'Schema fixture',
    registry: context.deployment.identity,
    chainId: 10143,
  })
  executor.agents.bindWallet('fixture-agent', 'fixture-wallet', wallet)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('fixture-agent', state)
  const operation = executor.agents.begin('fixture-agent', 'hire-1', 'public', 'create_task', { title: 'hire-1' })
  executor.agents.freezeStep(operation.id, 'action', {
    taskId: task.taskId,
    applicationId: 'application-1',
    transactions: [{ to: operator, data: '0x', value: '0' }],
  })
  sql.run("UPDATE agent_operations SET stage='sending', sponsor_operation_id=? WHERE id=?", 'sponsor-1', operation.id)
  fixtures.push({
    name: 'create_task',
    output: wire(
      await executor.execute({
        agentId: 'fixture-agent',
        boardId: 'public',
        operationKey: 'hire-1',
        tool: 'create_task',
        args: { title: 'hire-1' },
      }),
    ),
  })
  const selection = await executor.execute({
    agentId: 'fixture-agent',
    boardId: 'public',
    operationKey: 'hire-1-sel',
    tool: 'select_worker',
    args: { taskId: task.taskId, applicationId: 'application-1' },
  })
  fixtures.push({ name: 'select_worker', output: wire(selection) })

  // These fixtures call the same managed runtime as production, including JSON serialization.
  const env: BoardCall['env'] = {
    network: 'monad-testnet',
    boardId: 'public',
    rpcUrl: 'http://127.0.0.1:1',
    domain: 'sidequest.test',
    uri: origin,
    manifestBaseUrl: `${origin}/offers`,
    screening: { baseUrl: '', apiKey: '', model: '' },
    attesterKey: '',
    relayKey: '',
    github: { appId: '', privateKeyPem: '', installationId: '' },
  }
  const runtime = (tool: string, args: Record<string, unknown> = {}) =>
    runAgent({
      sql,
      stateId: 'management',
      bindings: {
        NETWORK: env.network,
        Board: {
          idFromName: () => ({ toString: () => 'management' }),
          get: () => ({
            call: () => {
              throw new Error('unexpected tenant call')
            },
          }),
        },
      },
      req: { env, tool, args, agentId: 'fixture-agent', resource: grant.resource, operator },
    })
  for (const name of ['agent_status', 'list_approvals'])
    fixtures.push({ name, output: JSON.parse(await runtime(name)) })
  fixtures.push({
    name: 'check_operation',
    output: JSON.parse(await runtime('check_operation', { operationId: selection.operationId })),
  })
  const approval = executor.agents.begin('fixture-agent', 'approval-hire', 'public', 'create_task', {
    title: 'Approved hire',
  })
  executor.agents.requestApproval(approval, 'hire-over-limit', { token, amount: '1' })
  fixtures.push({
    name: 'create_task',
    output: JSON.parse(await runtime('create_task', { operationKey: 'approval-hire', title: 'Approved hire' })),
  })
})

function addCommonsFixtures(now: number) {
  const commonsFixtures: Record<string, unknown> = {
    list_messages: { subject: 'lobby', messages: [], cursor: null, hasMore: false, nextPollSeconds: 10, viewer: null },
    list_gaps: { gaps: [], cursor: null },
    list_roadmap: { block: null, weightsAvailable: false, items: [], viewer: null },
    get_roadmap_item: {
      item: {
        id: 1,
        title: 'Roadmap item',
        status: 'open',
        proposer: wallet,
        supporters: 0,
        weight: '0',
        gapIds: [],
        mergedInto: null,
        hidden: null,
        threadSubject: 'roadmap:1',
        createdAt: now,
        updatedAt: now,
        problem: 'Problem',
        proposal: 'Proposal',
        proposerStake: '0',
        proposerBlock: null,
      },
      supporters: [],
      block: null,
      gaps: [],
      log: [],
      thread: { subject: 'roadmap:1', count: 0 },
    },
    list_roles: { enabled: true, roles: [], log: [], cursor: null, hasMore: false, viewer: null },
  }
  for (const [name, output] of Object.entries(commonsFixtures)) fixtures.push({ name, output: wire(output) })
}

function result(reply: Awaited<ReturnType<typeof mcpRoute>>) {
  return (reply.body as { result: Record<string, unknown> }).result
}
async function route(method: string, params: Record<string, unknown>, output: unknown = {}) {
  return result(
    await mcpRoute({
      method: 'POST',
      pathname: '/mcp',
      origin,
      headers: {},
      grant,
      body: { jsonrpc: '2.0', id: 1, method, params },
      tools: registry,
      call: async () => output,
      // This suite checks success outputs; its fixture calls carry only an operationKey, so input checks only log.
      toolArgsMode: 'log',
    }),
  )
}

describe.each(lanes)('$name output schemas', (lane) => {
  it('compiles every advertised schema and validates real publisher success outputs', async () => {
    const listed = (await route('tools/list', lane.params)).tools as Array<{
      name: string
      outputSchema: Record<string, unknown>
    }>
    const ajv = new Ajv({ strict: false, allErrors: true })
    const validators = new Map(listed.map((tool) => [tool.name, ajv.compile(tool.outputSchema)]))
    expect(validators.size).toBeGreaterThan(30)
    for (const tool of listed) expect(tool.outputSchema.additionalProperties, tool.name).toBe(true)
    for (const fixture of fixtures) {
      const validate = validators.get(fixture.name)!
      expect(validate, fixture.name).toBeDefined()
      const reply = await route(
        'tools/call',
        { ...lane.params, name: fixture.name, arguments: { operationKey: 'fixture-operation' } },
        fixture.output,
      )
      expect(reply.isError, fixture.name).not.toBe(true)
      expect(reply, fixture.name).toHaveProperty('structuredContent')
      expect(reply.structuredContent, fixture.name).toEqual(JSON.parse((reply.content as { text: string }[])[0]!.text))
      expect(validate(reply.structuredContent), `${fixture.name}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
    // Explicit regressions for the three shapes called out by the host review.
    expect(Array.isArray((fixtures.find((f) => f.name === 'list_tasks')!.output as { result: unknown }).result)).toBe(
      true,
    )
    expect(
      (fixtures.find((f) => f.name === 'protocol_info')!.output as { result: { chainId: unknown } }).result.chainId,
    ).toEqual(expect.any(Number))
    const getTask = (fixtures.find((f) => f.name === 'get_task')!.output as { result: Record<string, unknown> }).result
    expect(validators.get('get_task')!({ ok: true, result: { ...getTask, next: [] } })).toBe(true)
    expect(validators.get('get_task')!({ ok: true, result: { ...getTask, next: 'publish' } })).toBe(false)
  })
})
