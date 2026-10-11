/**
 * Where logs come from. `hyperSync` is the real source (Envio HyperSync, `POST /query`); tests pass their own pages.
 * The chain RPC answers the finalized head and block hashes (the divergence guard).
 */
import type { Address, Hex } from 'viem'
import type { RawLog } from './events.ts'

export interface LogPage {
  readonly logs: readonly RawLog[]
  /** The next block to ask for; the page covered [fromBlock, nextBlock). */
  readonly nextBlock: number
  /** Unix times of the blocks the logs are in (HyperSync joins them to the selected logs). */
  readonly blockTimes?: ReadonlyArray<{ readonly block: number; readonly timestamp: number }>
}

export interface LogSource {
  logs(q: { fromBlock: number; toBlock: number; addresses: readonly string[] }): Promise<LogPage>
}

export interface ChainHead {
  finalizedBlock(): Promise<number>
  blockHash(block: number): Promise<Hex | null>
  /** A block's unix time; backfills events indexed before block times were stored. */
  blockTimestamp?(block: number): Promise<number | null>
}

const FIELDS = [
  'block_number',
  'log_index',
  'transaction_hash',
  'address',
  'topic0',
  'topic1',
  'topic2',
  'topic3',
  'data',
]
/** HyperSync answers a block's timestamp as a hex string ("0x6abb771c"); a number is accepted too. */
const toSeconds = (v: string | number) => Number(BigInt(v))

export function hyperSync(url: string, token: string): LogSource {
  return {
    async logs({ fromBlock, toBlock, addresses }) {
      const res = await fetch(`${url.replace(/\/$/, '')}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          from_block: fromBlock,
          to_block: toBlock,
          logs: [{ address: addresses }],
          field_selection: { log: FIELDS, block: ['number', 'timestamp'] },
        }),
      })
      if (!res.ok) throw new Error(`hypersync: HTTP ${res.status}`)
      const body = (await res.json()) as {
        data?: Array<{ logs?: RawLog[]; blocks?: Array<{ number: number; timestamp: string | number }> }>
        next_block: number
      }
      const data = body.data ?? []
      return {
        logs: data.flatMap((d) => d.logs ?? []),
        nextBlock: body.next_block,
        blockTimes: data
          .flatMap((d) => d.blocks ?? [])
          .map((b) => ({ block: b.number, timestamp: toSeconds(b.timestamp) })),
      }
    },
  }
}

export function rpcHead(rpcUrl: string): ChainHead {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as {
      result?: { number: Hex; hash: Hex; timestamp: Hex } | null
      error?: { message: string }
    }
    if (body.error !== undefined) throw new Error(`rpc ${method}: ${body.error.message}`)
    return body.result ?? null
  }
  return {
    async finalizedBlock() {
      const b = await call('eth_getBlockByNumber', ['finalized', false])
      if (b === null) throw new Error('rpc: no finalized block')
      return Number(BigInt(b.number))
    },
    async blockHash(block) {
      const b = await call('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
      return b?.hash ?? null
    },
    async blockTimestamp(block) {
      const b = await call('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
      return b === null ? null : toSeconds(b.timestamp)
    },
  }
}

export type { Address }
