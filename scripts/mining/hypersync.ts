import { Schema } from 'effect'
import { custom, http, type EIP1193RequestFn } from './viem.ts'

// Mirrors packages/indexer/src/source.ts, with the remaining JSON-RPC log fields.
const FIELDS = [
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
]
export type LogSource = 'rpc' | 'hypersync'
export type HyperSyncNetwork = 'monad-testnet' | 'monad-mainnet'
const urls = {
  'monad-testnet': 'https://monad-testnet.hypersync.xyz/query',
  'monad-mainnet': 'https://monad.hypersync.xyz/query',
}
const strings = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const filterOf = Schema.decodeUnknownSync(
  Schema.Struct({
    fromBlock: Schema.String,
    toBlock: Schema.String,
    address: Schema.optional(strings),
    topics: Schema.optional(Schema.Array(Schema.Union([Schema.Null, strings]))),
  }),
)
const nullableTopic = Schema.optional(Schema.NullOr(Schema.String))
const pageOf = Schema.decodeUnknownSync(
  Schema.Struct({
    next_block: Schema.Number,
    data: Schema.Array(
      Schema.Struct({
        logs: Schema.Array(
          Schema.Struct({
            block_number: Schema.Number,
            block_hash: Schema.String,
            transaction_index: Schema.Number,
            log_index: Schema.Number,
            transaction_hash: Schema.String,
            address: Schema.String,
            topic0: nullableTopic,
            topic1: nullableTopic,
            topic2: nullableTopic,
            topic3: nullableTopic,
            data: Schema.String,
          }),
        ),
      }),
    ),
  }),
)
type HyperSyncLog = ReturnType<typeof pageOf>['data'][number]['logs'][number]
const integer = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid HyperSync integer')
  return value
}
const block = (value: string) => {
  if (!/^0x[\da-f]+$/i.test(value)) throw new Error('HyperSync requires explicit block numbers')
  return integer(Number(BigInt(value)))
}
const hex = (value: number) => `0x${integer(value).toString(16)}`
const list = (value: string | readonly string[]) => (Array.isArray(value) ? value : [value])
const rpcLog = (log: HyperSyncLog) => ({
  address: log.address,
  topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(
    (topic): topic is string => topic !== null && topic !== undefined,
  ),
  data: log.data,
  blockNumber: hex(log.block_number),
  blockHash: log.block_hash,
  transactionHash: log.transaction_hash,
  transactionIndex: hex(log.transaction_index),
  logIndex: hex(log.log_index),
  removed: false,
})
interface HyperSyncIO {
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
}
async function query(url: string, body: unknown, io: HyperSyncIO) {
  const token = process.env.HYPERSYNC_API_TOKEN
  if (!token) throw new Error('set HYPERSYNC_API_TOKEN')
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await (io.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 429 && attempt < 11) {
      await (io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(500 * 2 ** Math.min(attempt, 5))
      continue
    }
    if (!response.ok) throw new Error('HyperSync query refused')
    return pageOf(await response.json())
  }
  throw new Error('HyperSync retries exhausted')
}
function pageLogs(page: ReturnType<typeof pageOf>, from: number, end: number) {
  return page.data
    .flatMap((group) => group.logs)
    .map((log) => {
      if (log.block_number < from || log.block_number >= end) throw new Error('HyperSync log outside requested range')
      return rpcLog(log)
    })
}
async function logs(params: unknown, network: HyperSyncNetwork, io: HyperSyncIO) {
  const [raw] = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(params)
  const filter = filterOf(raw),
    from = block(filter.fromBlock),
    end = integer(block(filter.toBlock) + 1)
  const selection = {
    ...(filter.address === undefined ? {} : { address: list(filter.address) }),
    ...(filter.topics === undefined
      ? {}
      : { topics: filter.topics.map((topic) => (topic === null ? [] : list(topic))) }),
  }
  const out: ReturnType<typeof rpcLog>[] = []
  for (let next = from; next < end;) {
    const page = await query(
      urls[network],
      {
        from_block: next,
        to_block: end,
        logs: [selection],
        field_selection: { log: FIELDS },
      },
      io,
    )
    const following = integer(page.next_block)
    if (following <= next) throw new Error('HyperSync paging stalled')
    out.push(...pageLogs(page, next, Math.min(following, end)))
    next = following
  }
  return out.toSorted((a, b) => {
    const left = BigInt(a.blockNumber),
      right = BigInt(b.blockNumber)
    return left === right ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : left < right ? -1 : 1
  })
}

/** Only logs leave the configured RPC. Provider bodies and credentials never become error causes. */
export function hypersync(rpc: string, network: HyperSyncNetwork = 'monad-testnet', io: HyperSyncIO = {}) {
  const forward = http(rpc, { retryCount: 0, timeout: 30_000, fetchFn: io.fetch })({}).request
  return custom(
    {
      async request(args: Parameters<EIP1193RequestFn>[0]) {
        if (args.method !== 'eth_getLogs') return forward(args)
        try {
          return await logs(args.params, network, io)
        } catch {
          throw new Error(
            'HyperSync logs unavailable: check credentials, range and paging; provider details suppressed',
          )
        }
      },
    },
    { key: 'hypersync', name: 'HyperSync logs', retryCount: 0 },
  )
}

export function logSource(value: string = 'rpc'): LogSource {
  if (value !== 'rpc' && value !== 'hypersync') throw new Error('--logs requires rpc or hypersync')
  return value
}
