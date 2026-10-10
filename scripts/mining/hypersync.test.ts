import { Schema } from 'effect'
import { afterEach, expect, mock, test } from 'bun:test'
import { hypersync, logSource } from './hypersync.ts'
import { createPublicClient } from './viem.ts'
import { pagedLogs } from './chain.ts'

const originalToken = process.env.HYPERSYNC_API_TOKEN
afterEach(() => {
  if (originalToken === undefined) delete process.env.HYPERSYNC_API_TOKEN
  else process.env.HYPERSYNC_API_TOKEN = originalToken
})
const fixtureToken = 'fixture-hypersync-credential'
const address = '0x0000000000000000000000000000000000000001'
const hash = `0x${'11'.repeat(32)}` as const
const rawLog = (block_number = 10, log_index = 0) => ({
  address,
  block_number,
  log_index,
  block_hash: hash,
  transaction_hash: hash,
  transaction_index: 3,
  topic0: hash,
  topic1: null,
  topic2: hash,
  topic3: null,
  data: '0x1234',
})
const page = (next_block: number, logs = [rawLog()]) => ({ next_block, data: [{ logs }] })
const request = (
  fetch: typeof globalThis.fetch,
  sleep = async (_ms: number) => {},
  network: 'monad-testnet' | 'monad-mainnet' = 'monad-testnet',
) => {
  process.env.HYPERSYNC_API_TOKEN = fixtureToken
  return hypersync('http://rpc.invalid', network, { fetch, sleep })({}).config.request
}
const filter = { fromBlock: '0xa', toBlock: '0x13' } as const

const string = Schema.decodeUnknownSync(Schema.String)
const urlOf = (input: string | URL | Request | undefined) =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : string(input)
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error('unexpected rejection', { cause: error })
  }
  throw new Error('expected rejection')
}

test('HyperSync pages to the exclusive end, maps filters and fields, and returns logs in chain order', async () => {
  const calls: { url: string; options: RequestInit; body: unknown }[] = []
  const fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    if (!options) throw new Error('missing query')
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      options,
      body: JSON.parse(Schema.decodeUnknownSync(Schema.String)(options.body)),
    })
    return Response.json(calls.length === 1 ? page(15, [rawLog(12, 2), rawLog(10)]) : page(20, [rawLog(19)]))
  })
  const result = await request(fetch)({
    method: 'eth_getLogs',
    params: [{ ...filter, address, topics: [hash, null, [hash]] }],
  })
  expect(calls.map(({ body }) => body)).toEqual(
    [10, 15].map((from_block) => ({
      from_block,
      to_block: 20,
      logs: [{ address: [address], topics: [[hash], [], [hash]] }],
      field_selection: {
        log: [
          'block_number',
          'block_hash',
          'transaction_index',
          'log_index',
          'transaction_hash',
          'address',
          'topic0',
          'topic1',
          'topic2',
          'topic3',
          'data',
        ],
      },
    })),
  )
  expect(calls[0]?.url).toBe('https://monad-testnet.hypersync.xyz/query')
  expect(calls[0]?.options.headers).toEqual({
    'content-type': 'application/json',
    authorization: `Bearer ${fixtureToken}`,
  })
  expect(JSON.stringify(calls.map(({ body }) => body))).not.toContain(fixtureToken)
  expect(result).toEqual(
    [10, 12, 19].map((block, i) => ({
      address,
      topics: [hash, hash],
      data: '0x1234',
      blockNumber: `0x${block.toString(16)}`,
      blockHash: hash,
      transactionHash: hash,
      transactionIndex: '0x3',
      logIndex: i === 1 ? '0x2' : '0x0',
      removed: false,
    })),
  )
})

test('mainnet selects its endpoint and address arrays remain arrays; absent filters stay absent', async () => {
  const fetch = mock(async (_input: string | URL | Request, _options?: RequestInit) => Response.json(page(20, [])))
  const send = request(fetch, undefined, 'monad-mainnet')
  await send({ method: 'eth_getLogs', params: [{ ...filter, address: [address], topics: [] }] })
  await send({ method: 'eth_getLogs', params: [filter] })
  expect(urlOf(fetch.mock.calls[0]?.[0])).toBe('https://monad.hypersync.xyz/query')
  expect(JSON.parse(string(fetch.mock.calls[0]?.[1]?.body)).logs).toEqual([{ address: [address], topics: [] }])
  expect(JSON.parse(string(fetch.mock.calls[1]?.[1]?.body)).logs).toEqual([{}])
})

test('429 retries the identical query with bounded exponential backoff', async () => {
  let attempts = 0
  const fetch = mock(async (_input: string | URL | Request, _options?: RequestInit) =>
    ++attempts < 4 ? new Response('provider refusal', { status: 429 }) : Response.json(page(20)),
  )
  const sleep = mock(async (_ms: number) => {})
  await request(fetch, sleep)({ method: 'eth_getLogs', params: [filter] })
  expect(sleep.mock.calls).toEqual([[500], [1000], [2000]])
  expect(new Set(fetch.mock.calls.map((call) => call[1]?.body)).size).toBe(1)
})

test('429 exhaustion stops after twelve attempts and never includes provider details or the token', async () => {
  const fetch = mock(async () => new Response(fixtureToken, { status: 429 }))
  const sleep = mock(async (_ms: number) => {})
  expect((await rejectionOf(request(fetch, sleep)({ method: 'eth_getLogs', params: [filter] }))).message).toContain(
    'provider details suppressed',
  )
  expect(fetch).toHaveBeenCalledTimes(12)
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
    500, 1000, 2000, 4000, 8000, 16000, 16000, 16000, 16000, 16000, 16000,
  ])
})

test('a stalled second page refuses the entire range', async () => {
  let attempts = 0
  const fetch = mock(async () => Response.json(++attempts === 1 ? page(15) : page(15, [])))
  expect((await rejectionOf(request(fetch)({ method: 'eth_getLogs', params: [filter] }))).message).toContain('paging')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('malformed pages, invalid ranges and transport exceptions cannot expose credentials', async () => {
  for (const fetch of [
    async () => {
      throw new Error(fixtureToken)
    },
    async () => Response.json({ secret: fixtureToken, data: [], next_block: 'invalid' }),
    async () => new Response(fixtureToken, { status: 401 }),
    async () => Response.json(page(20, [rawLog(21)])),
  ]) {
    try {
      await request(fetch)({ method: 'eth_getLogs', params: [filter] })
      throw new Error('expected refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('provider details suppressed')
      expect(String(error)).not.toContain(fixtureToken)
      expect(error instanceof Error ? error.cause : undefined).toBeUndefined()
    }
  }
  const fetch = mock(async () => Response.json(page(20)))
  expect(
    await rejectionOf(request(fetch)({ method: 'eth_getLogs', params: [{ fromBlock: 'latest', toBlock: '0x13' }] })),
  ).toBeInstanceOf(Error)
  expect(fetch).not.toHaveBeenCalled()
})

test('missing token fails before fetch, and non-log methods forward to RPC without authorization', async () => {
  const fetch = mock(async (_input: string | URL | Request, _options?: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: 1, result: '0x279f' }),
  )
  const send = request(fetch)
  delete process.env.HYPERSYNC_API_TOKEN
  expect(await rejectionOf(send({ method: 'eth_getLogs', params: [filter] }))).toBeInstanceOf(Error)
  expect(fetch).not.toHaveBeenCalled()
  expect(await send({ method: 'eth_chainId' })).toBe('0x279f')
  const [url, options] = fetch.mock.calls[0] ?? []
  expect(urlOf(url)).toBe('http://rpc.invalid/')
  expect(new Headers(options?.headers).has('authorization')).toBe(false)
  expect(JSON.parse(string(options?.body)).method).toBe('eth_chainId')
})

test('viem decodes converted logs and the HyperSync pager makes one request for the full range', async () => {
  process.env.HYPERSYNC_API_TOKEN = fixtureToken
  const fetch = mock(async () => Response.json(page(20)))
  const c = createPublicClient({ transport: hypersync('http://rpc.invalid', 'monad-testnet', { fetch }) })
  const pager = { page: 1n, logs: 'hypersync' } as const
  const result = await pagedLogs(10n, 19n, pager, (fromBlock, toBlock) => c.getLogs({ fromBlock, toBlock }))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(result[0]).toMatchObject({ blockNumber: 10n, transactionIndex: 3, logIndex: 0, removed: false })
  expect(
    await pagedLogs(20n, 19n, pager, async () => {
      throw new Error('empty range fetched')
    }),
  ).toEqual([])
  expect(logSource()).toBe('rpc')
  expect(logSource('hypersync')).toBe('hypersync')
  expect(() => logSource('bad')).toThrow('--logs')
})
