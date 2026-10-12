/**
 * JSON-RPC to a bundler and an ERC-7677 paymaster service over `fetch`. Errors carry what a caller must do next:
 * `unavailable` (no answer: nothing was taken, unless it was a send), `refused` (an error object: nothing was taken),
 * `uncertain` (a send got no answer: it may have gone out, so reconcile before any retry).
 */
import { type Hex, isHex } from 'viem'

/** A parsed JSON value: what every RPC answer is before its fields are read. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

export type JsonRpc = (method: string, params: readonly Json[]) => Promise<Json>

export type AaErrorCode =
  | 'unavailable'
  | 'refused'
  | 'uncertain'
  | 'ceiling'
  | 'mismatch'
  | 'bad-signature'
  | 'landed'
  | 'no-paymaster'

export class AaError extends Error {
  constructor(
    readonly code: AaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AaError'
  }
}

/** Pimlico's endpoint for one chain. The key lives only in this URL, which is never logged or sent to a browser. */
export const pimlicoUrl = (chainId: number, apiKey: string): string =>
  `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value instanceof Object && !Array.isArray(value)

/** A field of an RPC answer object, or undefined. */
export function field(value: Json | undefined, name: string): Json | undefined {
  return isObject(value) ? value[name] : undefined
}

/** A quantity from an RPC answer: a hex string, as bundlers send them, or a safe non-negative integer. */
export function quantity(value: Json | undefined, what: string): bigint {
  if (isHex(value, { strict: true }) && value.length > 2) return BigInt(value)
  if (Number.isSafeInteger(value) && Number(value) >= 0) return BigInt(Number(value))
  throw new AaError('unavailable', `the answer has no ${what}`)
}

/** A hex string from an RPC answer. */
export function hexField(value: Json | undefined, what: string): Hex {
  if (isHex(value, { strict: true })) return value
  throw new AaError('unavailable', `the answer has no ${what}`)
}

async function parse(response: Response, label: string, method: string): Promise<Json> {
  try {
    // SAFETY: `Response.json` returns what JSON.parse built, which is a JSON value by construction.
    return (await response.json()) as Json
  } catch {
    throw new AaError('unavailable', `${label} answered ${method} with HTTP ${response.status}`)
  }
}

/** A JSON-RPC caller for `url`. `label` names the service in errors instead of the URL, which may hold a key. */
export function jsonRpc(url: string, label: string, fetcher: typeof fetch = fetch): JsonRpc {
  let id = 0
  return async (method, params) => {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new AaError('unavailable', `${label} did not answer ${method}`)
    }
    const body = await parse(response, label, method)
    const error = field(body, 'error')
    if (error !== undefined) {
      const message = field(error, 'message')
      const text = message instanceof Object || message === undefined || message === null ? 'refused' : String(message)
      throw new AaError('refused', `${label} refused ${method}: ${text.slice(0, 240)}`)
    }
    if (!response.ok) throw new AaError('unavailable', `${label} answered ${method} with HTTP ${response.status}`)
    return field(body, 'result') ?? null
  }
}
