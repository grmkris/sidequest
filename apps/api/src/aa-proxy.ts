/** Browser AA proxy and server RPCs. Provider URLs and keys never cross the error boundary. */
import { decodeFunctionData, isAddressEqual } from 'viem'
import * as Schema from 'effect/Schema'
import {
  AaError,
  aaConfig,
  type Deployment,
  type Json,
  type JsonRpc,
  decodeExecuteCalldata,
  deployment,
  field,
  hexField,
  pimlicoUrl,
  quantity,
  testnetFaucetAbi,
} from '@sidequest/sdk'
import { testnetPaymasterRpc } from './testnet-paymaster.ts'
import { admissionIpHash } from './admission-rate.ts'

/** The raw Worker bindings used by this adapter; Alchemy's secret_text bindings are strings at runtime. */
export interface AaBindings {
  readonly NETWORK?: string | undefined
  readonly MONAD_RPC_URL?: string | undefined
  readonly PIMLICO_API_KEY?: string | undefined
  readonly TESTNET_PAYMASTER_SIGNER_KEY?: string | undefined
}

export interface AaRpc {
  readonly node: JsonRpc
  readonly bundler: JsonRpc
  readonly paymaster: JsonRpc
}

export const AA_BODY_LIMIT = 64 * 1024
const UPSTREAM_BODY_LIMIT = 512 * 1024
const METHODS = new Set([
  'eth_chainId',
  'eth_supportedEntryPoints',
  'eth_estimateUserOperationGas',
  'eth_sendUserOperation',
  'eth_getUserOperationByHash',
  'eth_getUserOperationReceipt',
  'pimlico_getUserOperationGasPrice',
  'pimlico_getTokenQuotes',
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
])
const PM_METHODS = new Set(['pimlico_getTokenQuotes', 'pm_getPaymasterStubData', 'pm_getPaymasterData'])
const isString = Schema.is(Schema.String)
const ipRates = new Map<string, { at: number; count: number }>()

class RpcFailure extends AaError {
  constructor(
    readonly rpcCode: number,
    code: 'unavailable' | 'refused',
    message: string,
  ) {
    super(code, message)
  }
}

/** Stream-count bytes, including chunked bodies: neither a declared length nor buffering alone bounds memory. */
async function boundedBody(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (stream === null) throw new RpcFailure(-32600, 'refused', 'empty JSON-RPC body')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new RpcFailure(-32600, 'refused', 'JSON-RPC body too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(joined)
}

function upstream(url: string | undefined, fetcher: typeof fetch): JsonRpc {
  return async (method, params) => {
    if (url === undefined || url === '' || url === 'unset') throw new AaError('unavailable', 'AA provider unavailable')
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
      // SAFETY: JSON.parse produces a JSON value; fields are checked below before use.
      const body = JSON.parse(await boundedBody(response.body, UPSTREAM_BODY_LIMIT)) as Json
      const error = field(body, 'error')
      if (error !== undefined) {
        const code = field(error, 'code')
        throw new RpcFailure(
          Number.isSafeInteger(code) ? Number(code) : -32500,
          'refused',
          'AA provider refused the request',
        )
      }
      if (!response.ok || field(body, 'result') === undefined)
        throw new AaError('unavailable', 'AA provider unavailable')
      return field(body, 'result') ?? null
    } catch (error) {
      if (error instanceof AaError) throw error
      throw new AaError('unavailable', 'AA provider unavailable')
    }
  }
}

type ProxyDeployment = Pick<Deployment, 'aa' | 'chainId' | 'testnetFaucet'>

function config(bindings: AaBindings): ProxyDeployment {
  if (bindings.NETWORK !== 'monad-testnet' && bindings.NETWORK !== 'monad-mainnet')
    throw new AaError('unavailable', 'AA network unavailable')
  return bindings.NETWORK === 'monad-mainnet'
    ? { ...aaConfig(bindings.NETWORK), testnetFaucet: null }
    : deployment(bindings.NETWORK)
}

function checkedEntry(params: readonly Json[], d: ProxyDeployment, paymasterRequest: boolean): void {
  const aa = d.aa
  if (aa === null) throw new AaError('unavailable', 'AA configuration unavailable')
  const entry = hexField(params[1], 'EntryPoint')
  if (entry.length !== 42 || !isAddressEqual(entry, aa.entryPoint)) throw new AaError('refused', 'EntryPoint mismatch')
  if (paymasterRequest && quantity(params[2], 'chain id') !== BigInt(d.chainId))
    throw new AaError('refused', 'chain mismatch')
}

function checkedFaucet(params: readonly Json[], d: ProxyDeployment): void {
  checkedEntry(params, d, true)
  if (
    params.length !== 4 ||
    field(params[0], 'factory') !== undefined ||
    field(params[0], 'factoryData') !== undefined ||
    field(params[0], 'initCode') !== undefined
  )
    throw new AaError('refused', 'faucet sponsorship only permits EOA user operations')
  const calls = decodeExecuteCalldata(hexField(field(params[0], 'callData'), 'call data'))
  const call = calls?.[0]
  if (
    d.chainId !== 10143 ||
    d.testnetFaucet === null ||
    calls?.length !== 1 ||
    call === undefined ||
    call.value !== 0n ||
    !isAddressEqual(call.to, d.testnetFaucet)
  )
    throw new AaError('refused', 'sponsorship only permits one configured faucet claim')
  try {
    const decoded = decodeFunctionData({ abi: testnetFaucetAbi, data: call.data })
    if (decoded.functionName !== 'drip') throw new Error('method mismatch')
  } catch {
    throw new AaError('refused', 'sponsorship only permits the faucet claim method')
  }
}

function sponsorship(pimlico: JsonRpc, params: readonly Json[], d: ProxyDeployment): Promise<Json> {
  checkedFaucet(params, d)
  // Pimlico's v0.7 sponsorship result also speaks the ERC-7677 split paymaster fields.
  return pimlico('pm_sponsorUserOperation', [params[0]!, params[1]!])
}

function mainnetPaymaster(pimlico: JsonRpc, d: ProxyDeployment): JsonRpc {
  return async (method, params) => {
    if (!PM_METHODS.has(method) || field(params[3], 'sponsor') !== undefined)
      throw new AaError('refused', 'mainnet sponsorship is refused')
    checkedEntry(params, d, true)
    if (params.length !== (method === 'pimlico_getTokenQuotes' ? 3 : 4))
      throw new AaError('refused', 'invalid paymaster parameters')
    if (method === 'pimlico_getTokenQuotes')
      return pimlico(method, [{ tokens: [d.aa!.gasToken] }, params[1]!, params[2]!])
    return pimlico(method, [params[0]!, params[1]!, params[2]!, { token: d.aa!.gasToken }])
  }
}

/** No shared clients/promises: each Worker request owns its provider I/O. */
export function aaRpc(bindings: AaBindings, fetcher: typeof fetch = fetch): AaRpc {
  const d = config(bindings)
  const node = upstream(bindings.MONAD_RPC_URL, fetcher)
  const key = bindings.PIMLICO_API_KEY
  const pimlico = upstream(
    key === undefined || key === '' || key === 'unset' ? undefined : pimlicoUrl(d.chainId, key),
    fetcher,
  )
  const bundler: JsonRpc = async (method, params) => {
    if (!METHODS.has(method) || PM_METHODS.has(method)) throw new AaError('refused', 'unsupported bundler method')
    if (method === 'eth_estimateUserOperationGas' || method === 'eth_sendUserOperation') checkedEntry(params, d, false)
    return pimlico(method, params)
  }
  if (d.chainId === 143) return { node, bundler, paymaster: mainnetPaymaster(pimlico, d) }
  const local = testnetPaymasterRpc({
    deployment: deployment('monad-testnet'),
    node,
    signerKey: bindings.TESTNET_PAYMASTER_SIGNER_KEY,
  })
  const paymaster: JsonRpc = async (method, params) => {
    if (!PM_METHODS.has(method)) throw new AaError('refused', 'unsupported paymaster method')
    if (field(params[3], 'sponsor') !== undefined) {
      if (field(params[3], 'sponsor') !== 'faucet') throw new AaError('refused', 'unsupported sponsorship context')
      return sponsorship(pimlico, params, d)
    }
    return local(method, params)
  }
  return { node, bundler, paymaster }
}

function errorBody(id: Json, error: unknown): Json {
  const code = error instanceof AaError ? error.code : 'unavailable'
  const rpcCode =
    error instanceof RpcFailure ? error.rpcCode : code === 'unavailable' || code === 'no-paymaster' ? -32001 : -32500
  // Only locally written messages survive; upstream exception text and error data never do.
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: rpcCode,
      message: error instanceof AaError ? error.message.slice(0, 160) : 'AA unavailable',
      data: { code },
    },
  }
}

async function ipRate(ip: string | null): Promise<void> {
  let hash: string
  try {
    hash = await admissionIpHash(ip ?? undefined)
  } catch {
    throw new AaError('unavailable', 'AA edge client IP unavailable')
  }
  const now = Date.now()
  for (const [key, rate] of ipRates) if (rate.at + 60_000 <= now) ipRates.delete(key)
  const rate = ipRates.get(hash) ?? { at: now, count: 0 }
  if (rate.count >= 60 || ipRates.size >= 10_000) throw new RpcFailure(-32005, 'refused', 'AA rate limit exceeded')
  rate.count++
  ipRates.set(hash, rate)
}

function requestFields(body: Json): { id: Json; method: string; params: readonly Json[] } {
  const id = field(body, 'id')
  const method = field(body, 'method')
  const params = field(body, 'params')
  const validId = id === null || Number.isSafeInteger(id) || (isString(id) && id.length <= 128)
  if (field(body, 'jsonrpc') !== '2.0' || !validId || !isString(method) || !Array.isArray(params))
    throw new RpcFailure(-32600, 'refused', 'invalid JSON-RPC 2.0 request')
  if (!METHODS.has(method)) throw new RpcFailure(-32601, 'refused', 'method not allowed')
  return { id: id ?? null, method, params }
}

const validRequestId = (id: Json | undefined): boolean =>
  id === null || Number.isSafeInteger(id) || (isString(id) && id.length <= 128)

async function parsedBody(request: Request): Promise<Json> {
  try {
    const text = await boundedBody(request.body, AA_BODY_LIMIT)
    // SAFETY: JSON.parse produces only JSON values, then requestFields validates the envelope.
    return JSON.parse(text) as Json
  } catch (error) {
    if (error instanceof AaError) throw error
    throw new RpcFailure(-32700, 'refused', 'invalid JSON')
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof RpcFailure && error.rpcCode === -32005) return 429
  return error instanceof AaError && error.code === 'unavailable' ? 503 : 200
}

/** Public endpoint: publicTenant CORS headers are supplied by the Worker; counters use canonical hashed edge IPs. */
export async function aaRpcRoute(
  request: Request,
  bindings: AaBindings,
  cors: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const headers = { ...cors, 'cache-control': 'no-store' }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST')
    return Response.json(errorBody(null, new RpcFailure(-32600, 'refused', 'POST required')), { status: 405, headers })
  let id: Json = null
  try {
    await ipRate(request.headers.get('cf-connecting-ip'))
    const body = await parsedBody(request)
    const rawId = field(body, 'id')
    id = validRequestId(rawId) ? (rawId ?? null) : null
    const fields = requestFields(body)
    const rpc = aaRpc(bindings, fetcher)
    const result = await (PM_METHODS.has(fields.method) ? rpc.paymaster : rpc.bundler)(fields.method, fields.params)
    return Response.json({ jsonrpc: '2.0', id: fields.id, result }, { headers })
  } catch (error) {
    const status = errorStatus(error)
    return Response.json(errorBody(id, error), { status, headers })
  }
}
