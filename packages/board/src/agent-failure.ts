import { erc20Abi } from 'viem'
import * as sdk from '@sidequest/sdk'
import { BoardError } from './board-error.ts'

/** What the caller should do next. `same-key` is safe: the operation journal resumes or reconciles it. */
export type AgentRetry = 'same-key' | 'new-key' | 'after-operator' | 'none' | 'read'

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
  /** A refused argument's JSON path, e.g. `invite.agentId`. */
  readonly field?: string
  /** The JavaScript class of an unexpected failure, e.g. `SyntaxError`: safe to show, never its message. */
  readonly errorClass?: string
}

/**
 * Stored board data that no longer parses (a row written before a canonical form existed). Retrying the same call reads
 * the same row, so it never says retry; the operator repairs the row.
 */
export class StoredDataError extends AgentFailure {
  constructor(message: string) {
    super('conflict', message, 'stored-data', 'none')
  }
}

/**
 * JavaScript errors a retry of the same call reproduces: a server fault, never worth the caller retrying. TypeError is
 * not among them: a failed fetch throws one.
 */
const DETERMINISTIC_ERRORS: ReadonlySet<string> = new Set(['SyntaxError', 'RangeError', 'ReferenceError', 'URIError'])

/** Transport failures that are worth retrying: a timeout, an abort or an RPC endpoint that did not answer. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'TimeoutError',
  'AbortError',
  'HttpRequestError',
  'WebSocketRequestError',
  'SocketClosedError',
  'ChainReadTimeoutError',
])

/** How an unexpected (non-board) error is reported: a server fault, a transient outage, or unknown. */
export function failureKind(error: unknown): 'deterministic' | 'transient' | 'internal' {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++, current = current.cause) {
    if (TRANSIENT_ERRORS.has(current.name)) return 'transient'
  }
  const { name } = errorDiagnostics(error)
  return DETERMINISTIC_ERRORS.has(name) ? 'deterministic' : 'internal'
}

const RETRIES = new Set<string>(['same-key', 'new-key', 'after-operator', 'none', 'read'])

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
  fallbackRetry: 'same-key' | 'read' = 'same-key',
): AgentFailureReply {
  if (error instanceof BoardError) return boardFailureReply(error)
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
  const kind = failureKind(error)
  const errorClass = errorDiagnostics(error).name
  if (kind === 'deterministic')
    return {
      ok: false,
      code: 'error',
      message: `${fallback} (error ${errorId}): a server fault that a retry of the same call repeats; report the error id`,
      reason: 'internal',
      retry: 'none',
      errorId,
      errorClass,
    }
  return {
    ok: false,
    code: kind === 'transient' ? 'unavailable' : fallbackCode,
    message: `${fallback} (error ${errorId}); ${fallbackRetry === 'read' ? 'retry this read with the same arguments' : 'retry the same operationKey'}`,
    reason: kind === 'transient' ? 'transient' : 'internal',
    retry: fallbackRetry,
    errorId,
    errorClass,
  }
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** A board refusal keeps its code and message, plus each attached field that is well formed. */
function boardFailureReply(error: BoardError): AgentFailureReply {
  // SAFETY: sponsor refusals and AgentFailure attach these optional fields to a BoardError; each is checked below.
  const extra = error as unknown as {
    reason?: unknown
    retry?: unknown
    retryAfter?: unknown
    errorId?: unknown
    field?: unknown
    errorClass?: unknown
  }
  const { reason, retry, retryAfter, errorId, field, errorClass } = extra
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(isText(reason) ? { reason } : {}),
    // SAFETY: RETRIES holds exactly the AgentRetry values.
    ...(isText(retry) && RETRIES.has(retry) ? { retry: retry as AgentRetry } : {}),
    ...(isPositive(retryAfter) ? { retryAfter: Math.ceil(retryAfter) } : {}),
    ...(isText(errorId) && /^[0-9a-f]{12}$/.test(errorId) ? { errorId } : {}),
    ...(isText(field) && field.length <= 200 ? { field } : {}),
    ...(isText(errorClass) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorClass) ? { errorClass } : {}),
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
  field?: unknown
  errorClass?: unknown
}): BoardError {
  return Object.assign(new BoardError(reply.code as BoardError['code'], reply.message), {
    reason: reply.reason,
    retry: reply.retry,
    retryAfter: reply.retryAfter,
    errorId: reply.errorId,
    field: reply.field,
    errorClass: reply.errorClass,
  })
}

/**
 * A Board Durable Object's answer, read by its caller: the result of an `{ok: true, result}` reply, or the refusal of
 * an `{ok: false, code, message}` reply rebuilt and thrown (failureFromReply), so the caller's own boundary keeps its
 * code. An error thrown across Durable Object RPC loses its class, which turned refusals into "internal, retry" faults;
 * the objects answer replies instead. For a few minutes after a deploy an object can still run the previous version and
 * answer its bare value (a row, a grant, `null`, an array): that is the result as it is. No bare value has a boolean
 * `ok`. The caller names the result's type, as it does for BoardReply.
 */
export function unwrapReply(text: string): { readonly result: unknown } {
  const value: unknown = JSON.parse(text)
  if (!(value instanceof Object) || Array.isArray(value)) return { result: value }
  const reply: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const { ok, code, message } = reply
  if (ok === false && isText(code) && isText(message)) throw failureFromReply({ ...reply, code, message })
  return { result: ok === true && Object.hasOwn(reply, 'result') ? reply.result : value }
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
  // `alert` pages the owner (a Workers Logs alert on alert=internal_error) for a server fault or an unknown failure;
  // a transient outage does not page.
  console.error(
    JSON.stringify({
      event: 'agent-failure',
      errorId,
      ...errorDiagnostics(error),
      ...errorSite(error),
      ...(failureKind(error) === 'transient' ? {} : { alert: 'internal_error' }),
    }),
  )
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
