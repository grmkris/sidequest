import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Schema } from 'effect'
import { fromNodeSqlite, migrate, stmt } from '@sidequest/indexer'
import { SPONSOR_OBJECT_NAME } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { erc20Abi, encodeFunctionResult, toFunctionSelector, numberToHex, parseAbi, type Address } from 'viem'
import { afterEach, expect, it } from 'vitest'
import { agentBalances, balanceHistory, balanceUsd } from '../src/agent-balances.ts'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'
import { agentManagement } from '../src/agent-management.ts'
import { agentRoute } from '../src/routes/agents.ts'
import { mcpRoute } from '../src/mcp.ts'
import { hostedMcpTools } from '../src/mcp-registry.ts'
import { resolveOAuth } from '../src/oauth.ts'
import { requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'
import { setupFixture, operator, outsider, resource } from './setup-oauth-fixture.ts'

const open: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})
const deployment = sdk.deployment('monad-mainnet')
const token = deployment.rewardTokens[0]!.toLowerCase()
const wallet: Address = '0x3333333333333333333333333333333333333333'
const now = Math.floor(Date.now() / 1000)

async function index() {
  const db = new DatabaseSync(':memory:')
  open.push(() => db.close())
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  await sql.batch([
    stmt('INSERT INTO checkpoint(chain_id,next_block,updated_at) VALUES(?,?,?)', deployment.chainId, 101, now),
  ])
  const job = (id: string, status: string, creator: string, worker: string | null, outcome = 'None') =>
    db
      .prepare(
        "INSERT INTO jobs(chain_id,job_id,kind,stack,token,creator,worker,status,reward,net,bonus,fee_bps,outcome,settlement_outcome,updated_block) VALUES(?,?,'sidequest-v1','main',?,?,?,?, '100000000000000000000000','90000000000000000000000','0',1000,?, 'None',100)",
      )
      .run(deployment.chainId, id, token, creator, worker, status, outcome)
  const receipt = (id: string, kind: string, amount: string, block: number) =>
    db
      .prepare(
        'INSERT INTO reward_outcomes(chain_id,job_id,block,log_index,kind,recipient,amount,tx_hash) VALUES(?,?,?,0,?,?,?,?)',
      )
      .run(deployment.chainId, id, block, kind, wallet, amount, sdk.hashText(id + kind))
  return { sql, db, job, receipt }
}

it('sums 18-decimal earnings without float/SQLite overflow and separates escrow and pending rewards', async () => {
  const f = await index()
  f.job('1', 'active', outsider, wallet)
  f.job('2', 'open', wallet, null)
  f.job('3', 'completed', outsider, wallet, 'Accepted')
  f.receipt('3', 'paid', '90000000000000000000000', 91)
  f.db.prepare("UPDATE jobs SET settlement_outcome='Paid' WHERE job_id='3'").run()
  const h = await balanceHistory(f.sql, deployment.chainId, wallet)
  expect(h.escrow[token]).toBe('100000000000000000000000')
  expect(h.pending[token]).toBe('90000000000000000000000')
  expect(h.paid[token]).toBe('90000000000000000000000')
  expect(h.receipts[0]).toMatchObject({ jobId: '3', txHash: sdk.hashText('3paid'), kind: 'paid' })
})

it('excludes the core payment from unsettled rewards and remaining creator escrow', async () => {
  const f = await index()
  f.job('6', 'completed', outsider, wallet, 'Accepted')
  f.receipt('6', 'paid', '90000000000000000000000', 93)
  f.db.prepare("UPDATE jobs SET bonus='11' WHERE job_id='6'").run()
  const worker = await balanceHistory(f.sql, deployment.chainId, wallet)
  expect(worker.paid[token]).toBe('90000000000000000000000')
  // Holding rounds the bonus fee upward: ceil(11 * 10%) = 2.
  expect(worker.pending[token]).toBe('9')
  const creator = await balanceHistory(f.sql, deployment.chainId, outsider)
  expect(creator.escrow[token]).toBe('10000000000000000000011')
  expect(creator.paid).toEqual({})
})

it('keeps failed pushes out of paid earnings and counts an attributable pooled withdrawal once', async () => {
  const f = await index()
  f.job('4', 'completed', outsider, wallet, 'Accepted')
  f.db.prepare("UPDATE jobs SET settlement_outcome='Paid'").run()
  f.receipt('4', 'owed', '90', 92)
  f.db
    .prepare('INSERT INTO payout_owed VALUES(?,?,?,0,?,?,?,?)')
    .run(deployment.chainId, '4', 92, wallet, token, '90', sdk.hashText('owed'))
  let h = await balanceHistory(f.sql, deployment.chainId, wallet)
  expect(h.paid).toEqual({})
  expect(h.pending).toEqual({})
  f.db
    .prepare('INSERT INTO protocol_events VALUES(?,?,?,0,?,?,?)')
    .run(
      deployment.chainId,
      sdk.stack(deployment, 'main').holding,
      93,
      sdk.hashText('withdrawn'),
      'OwedWithdrawn',
      JSON.stringify({ to: wallet, token, amount: '90' }),
    )
  h = await balanceHistory(f.sql, deployment.chainId, wallet)
  expect(h.paid[token]).toBe('90')
  expect(h.receipts.map((r) => r.kind)).toEqual(['owed', 'withdrawn'])
  expect((await balanceHistory(f.sql, deployment.chainId, wallet)).paid[token]).toBe('90')
  // A refund in the pooled liability makes allocation ambiguous: expose unavailable, never guess an earnings total.
  f.db
    .prepare('INSERT INTO payout_owed VALUES(?,?,?,0,?,?,?,?)')
    .run(deployment.chainId, '5', 94, wallet, token, '10', sdk.hashText('refund'))
  expect((await balanceHistory(f.sql, deployment.chainId, wallet)).uncertainPaid).toEqual([token])
})

it('never invents USD for missing, stale or invalid prices, including zero balances', () => {
  const price = { perUnit: 2, source: 'fixture pool', observedAt: now, sourceAt: now }
  expect(balanceUsd('1500000', 6, price, now)).toBe(3)
  expect(balanceUsd('0', 6, price, now)).toBe(0)
  expect(balanceUsd('0', 6, { ...price, perUnit: null }, now)).toBeNull()
  expect(balanceUsd('1500000', 6, price, now + 121)).toBeNull()
  expect(balanceUsd('1500000', 6, { ...price, observedAt: now, sourceAt: now - 121 }, now)).toBeNull()
  expect(balanceUsd('1500000', null, price, now)).toBeNull()
  expect(balanceUsd('1500000', 6, { ...price, perUnit: Infinity }, now)).toBeNull()
})

/** A local JSON-RPC transport: real viem encoding/decoding, no hosted network or signing service. */
async function rpc(balance = 1_500_000n, owed = 90n, sourceAt = now, successfulQuotes = false) {
  const methods: string[] = []
  const priceBlocks: unknown[] = []
  const reply = (call: { id: number; method: string; params: [{ data?: string }, unknown?] }) => {
    methods.push(call.method)
    let result: unknown
    if (call.method === 'eth_getBlockByNumber')
      result = {
        number: '0x64',
        timestamp: numberToHex(sourceAt),
        hash: sdk.hashText('block'),
        parentHash: sdk.hashText('parent'),
        nonce: '0x0000000000000000',
        difficulty: '0x0',
        gasLimit: '0x100000',
        gasUsed: '0x0',
        size: '0x0',
        transactions: [],
        extraData: '0x',
        miner: wallet,
      }
    else if (call.method === 'eth_getBalance') result = numberToHex(balance)
    else if (call.method === 'eth_call') {
      const data = call.params[0].data ?? ''
      if (successfulQuotes && data.startsWith(toFunctionSelector('getSlot0(bytes32)'))) {
        priceBlocks.push(call.params[1])
        result = encodeFunctionResult({
          abi: parseAbi(['function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)']),
          functionName: 'getSlot0',
          result: [2n ** 96n, 0, 0, 0],
        })
      } else if (successfulQuotes && data.startsWith(toFunctionSelector('getAmountOut(address,uint256,bool)'))) {
        priceBlocks.push(call.params[1])
        result = encodeFunctionResult({ abi: sdk.nadRouterAbi, functionName: 'getAmountOut', result: 10n ** 18n })
      } else if (data.startsWith(toFunctionSelector('balanceOf(address)')))
        result = encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balance })
      else if (data.startsWith(toFunctionSelector('decimals()')))
        result = encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 })
      else if (data.startsWith(toFunctionSelector('symbol()')))
        result = encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'TEST' })
      else if (data.startsWith(toFunctionSelector('owed(address,address)')))
        result = encodeFunctionResult({ abi: sdk.sidequestHoldingAbi, functionName: 'owed', result: owed })
    }
    return result === undefined
      ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'unavailable quote' } }
      : { jsonrpc: '2.0', id: call.id, result }
  }
  const server = createServer((req, res) => {
    void (async () => {
      let body = ''
      for await (const chunk of req) body += chunk
      const calls = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(reply) : reply(calls)))
    })().catch(() => {
      res.statusCode = 500
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  const bound = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(address)
  return { url: `http://127.0.0.1:${bound.port}`, methods, priceBlocks }
}

it.each([0n, 1_500_000n])(
  'reads funded/zero wallets and live owed amounts without including them in spendable funds (%s)',
  async (amount) => {
    const server = await rpc(amount)
    const f = await index()
    const snapshot = await agentBalances(sdk.context('monad-mainnet', 'main', server.url), f.sql, wallet)
    expect(snapshot).toMatchObject({ wallet, chainId: 143, blockNumber: '100' })
    const row = snapshot.currencies.find((c) => c.token === token)!
    expect(row).toMatchObject({
      decimals: 6,
      amounts: { wallet: amount.toString(), owed: '90', paid: '0', pending: '0' },
    })
    expect(row.usd.wallet).toBe(Number(amount) / 1e6)
    expect(row.price).toMatchObject({ perUnit: 1, source: 'Configured USD peg (estimate)' })
    expect(snapshot.currencies.find((c) => c.token === null)?.usd.wallet).toBeNull()
    expect(server.methods.every((m) => ['eth_call', 'eth_getBlockByNumber', 'eth_getBalance'].includes(m))).toBe(true)
  },
)

it('uses real OAuth agent binding for MCP and SIWE ownership for the matching account read', async () => {
  const server = await rpc()
  const f = setupFixture()
  open.push(() => f.db.close())
  f.clock(now)
  f.active('quill')
  const consent = await f.request('sidequest:read')
  const approved = await f.route(`/oauth/requests/${consent.requestId}/approve`, { agentIds: ['quill'] })
  // SAFETY: oauthRoute's successful consent reply contains the registered redirect URL.
  const redirect = (approved!.body as { result: { redirectUrl: string } }).result.redirectUrl
  const granted = await f.route('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: consent.clientId,
    resource,
    redirect_uri: 'http://127.0.0.1:3210/callback',
    code: new URL(redirect).searchParams.get('code'),
    code_verifier: 'a'.repeat(43),
  })
  // SAFETY: this fixture exchanges a valid OAuth code through the real token route.
  const bearer = (granted!.body as { access_token: string }).access_token
  const grant = await resolveOAuth(f.sql, bearer, resource, now)
  if (grant === undefined) throw new Error('OAuth grant missing')
  const req: AgentExecuteRequest = {
    tool: 'get_balances',
    args: {},
    agentId: 'quill',
    resource,
    bearer,
    env: {
      network: 'monad-testnet',
      boardId: 'team-board',
      rpcUrl: server.url,
      domain: 'board.example',
      uri: 'https://board.example',
      manifestBaseUrl: '',
      screening: { baseUrl: '', apiKey: '', model: '' },
      attesterKey: '',
      relayKey: '',
      github: { appId: '', privateKeyPem: '', installationId: '' },
    },
  }
  const bindings = {
    NETWORK: req.env.network,
    Board: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => {
        throw new Error('read must not call tenant or signing service')
      },
    },
  }
  const run = async (_tool: string, _args: Record<string, unknown>, id: string) =>
    JSON.parse(await runAgent({ req: { ...req, agentId: id }, bindings, sql: f.sql, stateId: SPONSOR_OBJECT_NAME }))
  const response = await mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    headers: {},
    origin: 'https://board.example',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_balances', arguments: {} } },
    grant,
    tools: hostedMcpTools(req.env.network),
    call: run,
  })
  expect(JSON.stringify(response)).toContain('3333333333333333333333333333333333333333')
  expect(JSON.stringify(response)).toContain('Configured USD peg')
  await expect(run('get_balances', {}, 'not-granted')).rejects.toMatchObject({ code: 'forbidden' })
  const management = (owner: Address) =>
    agentManagement({
      request: { action: 'balances', id: 'quill', body: {} },
      sql: f.sql,
      context: sdk.context('monad-testnet', 'main', server.url),
      operator: owner,
      bindings,
      relayKey: '0x',
      rpcUrl: server.url,
      now: () => now,
      execute: async () => {
        throw new Error('read must not execute')
      },
    })
  expect(await management(operator)).toMatchObject({ wallet, chainId: 10143 })
  await expect(management(outsider)).rejects.toThrow('another operator')
  expect(agentRoute('GET', '/api/agents/quill/balances', {})).toMatchObject({ action: 'balances' })
  expect(requiredToolScope('get_balances')).toBe('sidequest:read')
  expect(toolAnnotations('get_balances')).toMatchObject({ readOnlyHint: true, destructiveHint: false })
})

it.each([0, 121])(
  'pins successful market quotes to their source block and rejects stale USD on repeated reads (age %s)',
  async (age) => {
    const server = await rpc(1_500_000n, 90n, now - age, true)
    const context = sdk.context('monad-mainnet', 'main', server.url)
    for (let poll = 0; poll < 2; poll += 1) {
      const snapshot = await agentBalances(context, undefined, wallet)
      expect(snapshot.observedAt).toBeGreaterThanOrEqual(now)
      expect(snapshot.blockTimestamp).toBe(now - age)
      const native = snapshot.currencies.find((c) => c.token === null)!
      const side = snapshot.currencies.find((c) => c.token === deployment.factory.toLowerCase())!
      expect(native.price.perUnit).toBeGreaterThan(0)
      expect(side.price.perUnit).toBeGreaterThan(0)
      for (const currency of snapshot.currencies) {
        expect(currency.amounts.wallet).toBe('1500000')
        expect(currency.price.sourceAt).toBe(now - age)
        if (age > 120) expect(currency.usd.wallet).toBeNull()
        else expect(currency.usd.wallet).toBeGreaterThan(0)
      }
    }
    expect(server.priceBlocks.length).toBeGreaterThanOrEqual(4)
    expect(server.priceBlocks.every((block) => block === '0x64')).toBe(true)
  },
)
