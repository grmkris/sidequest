import { erc20Abi } from 'viem'
import * as sdk from '@sidequest/sdk'
import { BoardError } from './board-error.ts'

/** What the caller should do next. `same-key` is safe: the operation journal resumes or reconciles it. */
export type AgentRetry = 'same-key' | 'new-key' | 'after-operator' | 'none'

/** A refusal an agent can act on: a stable reason, a retry rule and, when known, how long to wait. */
export class AgentFailure extends BoardError {
  constructor(
    code: BoardError['code'],
    message: string,
    readonly reason: string,
    readonly retry: AgentRetry,
    readonly retryAfter?: number,
  ) {
    super(code, message)
  }
}

export interface AgentFailureReply {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly reason?: string
  readonly retry?: AgentRetry
  readonly retryAfter?: number
  readonly errorId?: string
}

const RETRIES = new Set<string>(['same-key', 'new-key', 'after-operator', 'none'])

/**
 * The reply for a failed hosted action. Board errors keep their code, message and any reason, retry and retryAfter
 * (sponsor refusals attach these to a BoardError). Anything else is internal: its text may carry RPC URLs or keys,
 * so the caller sees only an error id that the server logs beside the real error.
 */
export function agentFailureReply(
  error: unknown,
  fallback: string,
  log: (errorId: string, error: unknown) => void = defaultLog,
  fallbackCode = 'unavailable',
): AgentFailureReply {
  if (error instanceof BoardError) {
    const extra = error as unknown as { reason?: unknown; retry?: unknown; retryAfter?: unknown; errorId?: unknown }
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(typeof extra.reason === 'string' ? { reason: extra.reason } : {}),
      ...(typeof extra.retry === 'string' && RETRIES.has(extra.retry) ? { retry: extra.retry as AgentRetry } : {}),
      ...(typeof extra.retryAfter === 'number' && Number.isFinite(extra.retryAfter) && extra.retryAfter > 0
        ? { retryAfter: Math.ceil(extra.retryAfter) }
        : {}),
      ...(typeof extra.errorId === 'string' && /^[0-9a-f]{12}$/.test(extra.errorId) ? { errorId: extra.errorId } : {}),
    }
  }
  const revert = revertName(error)
  if (revert !== undefined)
    return {
      ok: false,
      code: 'chain',
      message: `The chain refused this call: ${revert}`,
      reason: 'revert',
      retry: 'none',
    }
  const errorId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  log(errorId, error)
  return {
    ok: false,
    code: fallbackCode,
    message: `${fallback} (error ${errorId}); retry the same operationKey`,
    reason: 'internal',
    retry: 'same-key',
    errorId,
  }
}

/**
 * Rebuilds a failure from a sanitized board reply (Board.call already applied agentFailureReply), keeping its code,
 * message and fields so the caller's own boundary passes them on instead of treating the reply as unexpected.
 */
export function failureFromReply(reply: {
  code: string
  message: string
  reason?: unknown
  retry?: unknown
  retryAfter?: unknown
  errorId?: unknown
}): BoardError {
  return Object.assign(new BoardError(reply.code as BoardError['code'], reply.message), {
    reason: reply.reason,
    retry: reply.retry,
    retryAfter: reply.retryAfter,
    errorId: reply.errorId,
  })
}

/** The custom errors our contracts declare: the only revert names a reply may carry. */
const KNOWN_REVERTS: ReadonlySet<string> = new Set(
  [
    sdk.coreAbi,
    erc20Abi,
    sdk.sidequestHoldingAbi,
    sdk.sidequestEvaluatorAbi,
    sdk.stakeVaultAbi,
    sdk.feeScheduleAbi,
    sdk.sideTokenAbi,
  ].flatMap((abi) =>
    (abi as readonly { type: string; name?: string }[])
      .filter((item) => item.type === 'error' && item.name !== undefined)
      .map((item) => item.name!),
  ),
)

/**
 * The error name viem decoded from a revert against our ABIs, anywhere in the cause chain. Only a
 * ContractFunctionRevertedError carries a decoded name; a provider's raw `data` (an RpcRequestError copies the
 * JSON-RPC error body) is never trusted, and a name outside our contracts' errors is never echoed.
 */
function revertName(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++, current = current.cause) {
    if (current.name !== 'ContractFunctionRevertedError') continue
    const name = (current as { data?: { errorName?: unknown } }).data?.errorName
    return typeof name === 'string' && KNOWN_REVERTS.has(name) ? name : undefined
  }
  return undefined
}

function defaultLog(errorId: string, error: unknown): void {
  console.error(JSON.stringify({ event: 'agent-failure', errorId, ...errorDiagnostics(error), ...errorSite(error) }))
}

/**
 * Static facts about an error for Worker logs: its class name, our short code and an HTTP status. Never its message,
 * cause or response body, which can carry RPC URLs, bearer tokens or provider credentials of any shape.
 */
export function errorDiagnostics(error: unknown): { name: string; code?: string; status?: number } {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    code?: unknown
    status?: unknown
  }
  return {
    name: typeof e.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : typeof error,
    ...(typeof e.code === 'string' && /^[a-z][a-z-]{0,31}$/.test(e.code) ? { code: e.code } : {}),
    ...(typeof e.status === 'number' && Number.isSafeInteger(e.status) ? { status: e.status } : {}),
  }
}

/**
 * Where an internal failure was thrown: the names of the innermost stack frames' functions only (no message, file path
 * or argument), so it can be found without logging what it said.
 */
export function errorSite(error: unknown): { at?: string[] } {
  const stack = typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined
  const at =
    typeof stack === 'string'
      ? [...stack.matchAll(/^\s*at (?:async )?([A-Za-z_$#][\w$#.<>]{0,79}) \(/gm)].map((match) => match[1]!).slice(0, 5)
      : []
  return at.length > 0 ? { at } : {}
}
