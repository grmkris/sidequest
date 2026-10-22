import * as sdk from '@sidequest/sdk'
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentFailure,
  agentFailureReply,
  errorDiagnostics,
  errorSite,
  failureFromReply,
  failureKind,
  StoredDataError,
  unwrapReply,
} from './agent-failure.ts'
import { BoardError } from './board-error.ts'

function verifyOneOffAllowance(): never {
  throw new Error('secret https://rpc.example/KEY Bearer abc')
}

describe('agentFailureReply', () => {
  it('keeps an agent failure code, reason, retry and wait', () => {
    expect(
      agentFailureReply(
        new AgentFailure(
          'conflict',
          'This operationKey already names a different action',
          'operation-key-reused',
          'new-key',
        ),
        'fallback',
      ),
    ).toEqual({
      ok: false,
      code: 'conflict',
      message: 'This operationKey already names a different action',
      reason: 'operation-key-reused',
      retry: 'new-key',
    })
    expect(
      agentFailureReply(new AgentFailure('unavailable', 'grant renews', 'grant-missing', 'same-key', 59.2), 'fallback'),
    ).toMatchObject({ retry: 'same-key', retryAfter: 60 })
  })

  it('keeps the fields a sponsor refusal attaches to a BoardError and drops malformed ones', () => {
    const floor = Object.assign(new BoardError('conflict', 'the sponsorship relay is below its balance floor'), {
      reason: 'floor',
      retry: 'same-key',
      retryAfter: 600,
    })
    expect(agentFailureReply(floor, 'fallback')).toEqual({
      ok: false,
      code: 'conflict',
      message: 'the sponsorship relay is below its balance floor',
      reason: 'floor',
      retry: 'same-key',
      retryAfter: 600,
    })
    const odd = Object.assign(new BoardError('conflict', 'x'), { reason: 7, retry: 'later', retryAfter: -1 })
    expect(agentFailureReply(odd, 'fallback')).toEqual({ ok: false, code: 'conflict', message: 'x' })
  })

  it('hides internal error text behind a logged error id', () => {
    const log = vi.fn()
    const secret = new Error('request to https://rpc.example/v2/SECRETKEY failed')
    const reply = agentFailureReply(secret, 'Hosted agent execution failed', log)
    expect(reply).toMatchObject({ ok: false, code: 'unavailable', reason: 'internal', retry: 'same-key' })
    expect(reply.errorId).toMatch(/^[0-9a-f]{12}$/)
    expect(reply.message).toBe(`Hosted agent execution failed (error ${reply.errorId}); retry the same operationKey`)
    expect(JSON.stringify(reply)).not.toContain('SECRETKEY')
    expect(log).toHaveBeenCalledWith(reply.errorId, secret)
  })

  it('retries a failed read with its arguments and preserves that guidance across the tenant boundary', () => {
    const log = vi.fn()
    const reply = agentFailureReply(new Error('SECRET_PROVIDER'), 'Read failed', log, 'error', 'read')
    expect(reply).toMatchObject({ code: 'error', reason: 'internal', retry: 'read' })
    expect(reply.message).toContain('retry this read with the same arguments')
    expect(reply.message).not.toMatch(/operationKey|SECRET_PROVIDER/)
    expect(agentFailureReply(failureFromReply(reply), 'Outer failure', log)).toEqual(reply)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('logs only static diagnostics through the default sink, never message or body text', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const long = Object.assign(
        new Error('HTTP request failed. URL: https://monad.example/v2/SECRETKEY0123456789abcdef'),
        { name: 'HttpRequestError', status: 401, code: 'bad-request' },
      )
      const reply = agentFailureReply(long, 'Hosted agent execution failed')
      // Short or segmented credentials defeat any redactor, so none of the text may reach the log at all.
      agentFailureReply(new Error('Authorization: Bearer SECRETKEY'), 'Hosted agent execution failed')
      agentFailureReply(
        Object.assign(new Error('provider refused'), {
          body: '{"apiKey":"short-secret"}',
          details: 'sk-1 x-api-key: ab12',
        }),
        'Hosted agent execution failed',
      )
      agentFailureReply('token=abc', 'Hosted agent execution failed')
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(spy).toHaveBeenCalledTimes(4)
      expect(logged).toContain(reply.errorId!)
      expect(logged).toContain('"name":"HttpRequestError"')
      expect(logged).toContain('"status":401')
      expect(logged).not.toMatch(
        /SECRETKEY|monad\.example|Bearer|short-secret|apiKey|sk-1|ab12|token=abc|refused|request failed/,
      )
    } finally {
      spy.mockRestore()
    }
    expect(errorDiagnostics(Object.assign(new Error('x'), { name: 'bad name!', code: 'NOT A CODE' }))).toEqual({
      name: 'object',
    })
    expect(errorDiagnostics(Object.assign(new Error('x'), { code: 'rate-limited', status: 429 }))).toEqual({
      name: 'Error',
      code: 'rate-limited',
      status: 429,
    })
    expect(errorDiagnostics('plain string')).toEqual({ name: 'string' })
  })

  it('logs where an internal failure was thrown as function names only', () => {
    let thrown: unknown
    try {
      verifyOneOffAllowance()
    } catch (error) {
      thrown = error
    }
    const site = errorSite(thrown)
    expect(site.at?.[0]).toBe('verifyOneOffAllowance')
    expect(JSON.stringify(site)).not.toMatch(/secret|rpc\.example|KEY|Bearer|\/|:\d/)
  })

  it('reports only a viem-decoded revert whose name our contracts declare', () => {
    const decoded = new ContractFunctionRevertedError({
      abi: sdk.stakeVaultAbi,
      functionName: 'withdraw',
      data: encodeErrorResult({ abi: sdk.stakeVaultAbi, errorName: 'StillBonded', args: [5n, 7n] }),
    })
    const wrapped = new Error('execution reverted: https://rpc.example/KEY', { cause: decoded })
    expect(agentFailureReply(wrapped, 'fallback', vi.fn())).toEqual({
      ok: false,
      code: 'chain',
      message: 'The chain refused this call: StillBonded',
      reason: 'revert',
      retry: 'none',
    })
    // A provider's JSON-RPC error body copied onto an RpcRequestError is not a decoded revert, whatever it claims.
    const raw = Object.assign(new Error('RPC Request failed.'), {
      name: 'RpcRequestError',
      data: { errorName: 'StillBonded' },
    })
    expect(agentFailureReply(raw, 'fallback', vi.fn())).toMatchObject({ reason: 'internal' })
    // A decoded name outside our contracts' errors (a foreign ABI, Error(string), Panic) is not echoed either.
    const foreignAbi = parseAbi(['error Leaked(string detail)'])
    const foreign = new ContractFunctionRevertedError({
      abi: foreignAbi,
      functionName: 'x',
      data: encodeErrorResult({ abi: foreignAbi, errorName: 'Leaked', args: ['https://rpc.example/KEY'] }),
    })
    expect(agentFailureReply(foreign, 'fallback', vi.fn())).toMatchObject({ reason: 'internal' })
  })
})

describe('the tenant boundary (VV2-017)', () => {
  it('keeps an unexpected tenant error out of the MCP reply and the console across the Board.call rewrap', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tenant = new TypeError('fetch https://rpc.example/v2/SECRETKEY failed: {"apiKey":"short-secret"}')
      // Board.call serializes the tenant failure; the hosted caller rebuilds it and applies its own boundary.
      const boardReply = agentFailureReply(tenant, 'The board could not complete this call', undefined, 'error')
      const mcpReply = agentFailureReply(failureFromReply(boardReply), 'Hosted agent execution failed')
      expect(boardReply).toMatchObject({ code: 'error', reason: 'internal', retry: 'same-key' })
      expect(mcpReply).toEqual(boardReply)
      expect(spy).toHaveBeenCalledTimes(1)
      const surfaces = [
        JSON.stringify(boardReply),
        JSON.stringify(mcpReply),
        ...spy.mock.calls.map((call) => call.join(' ')),
      ].join('\n')
      expect(surfaces).toContain(boardReply.errorId!)
      expect(surfaces).not.toMatch(/SECRETKEY|rpc\.example|short-secret|apiKey|fetch/)
    } finally {
      spy.mockRestore()
    }
  })

  it('passes an explicit refusal through the rewrap unchanged', () => {
    const floor = Object.assign(new BoardError('unavailable', 'the sponsorship relay is below its balance floor'), {
      reason: 'floor',
      retry: 'same-key',
      retryAfter: 600,
    })
    const boardReply = agentFailureReply(floor, 'fallback', vi.fn(), 'error')
    expect(agentFailureReply(failureFromReply(boardReply), 'fallback', vi.fn())).toEqual(boardReply)
  })

  it('answers the signing check as a reply: a refusal thrown across Durable Object RPC loses its class', () => {
    const refusal = new BoardError('conflict', 'signing requires an open unassigned hire')
    // What Durable Object RPC rethrows: the message and its own fields, not the class.
    const rethrown = Object.assign(new Error(refusal.message), { code: refusal.code })
    expect(agentFailureReply(rethrown, 'Hosted agent execution failed', vi.fn())).toMatchObject({
      reason: 'internal',
      retry: 'same-key',
    })
    const reply = agentFailureReply(refusal, 'Signing check failed', vi.fn())
    expect(agentFailureReply(failureFromReply(reply), 'Hosted agent execution failed', vi.fn())).toEqual({
      ok: false,
      code: 'conflict',
      message: 'signing requires an open unassigned hire',
    })
  })
})

describe('unwrapReply', () => {
  it('answers the result of a reply and rethrows its refusal with the code, retry and error id kept', () => {
    expect(unwrapReply(JSON.stringify({ ok: true, result: { address: '0xabc' } })).result).toEqual({ address: '0xabc' })
    expect(unwrapReply(JSON.stringify({ ok: true, result: null })).result).toBeNull()
    const refusal = agentFailureReply(new BoardError('unauthenticated', 'Operator session required'), 'x', vi.fn())
    const thrown = (() => {
      try {
        unwrapReply(JSON.stringify(refusal))
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(BoardError)
    expect(agentFailureReply(thrown, 'Operator agent read failed', vi.fn())).toEqual(refusal)
    const fault = agentFailureReply(new Error('boom'), 'Operator agent read failed', vi.fn())
    expect(() => unwrapReply(JSON.stringify(fault))).toThrow(fault.message)
  })

  it("passes an object's bare value through, as one still on the previous version answers", () => {
    for (const bare of [null, [], [{ agentId: '1' }], { address: '0xabc', chain_id: 143 }, { ok: 'yes' }, 'text'])
      expect(unwrapReply(JSON.stringify(bare)).result).toEqual(bare)
    expect(() => unwrapReply('not json')).toThrow(SyntaxError)
  })
})

describe('typed failure kinds', () => {
  it('says a deterministic server fault is not worth retrying and names its class, never its message', () => {
    const log = vi.fn()
    let thrown: unknown
    try {
      BigInt('10415.0')
    } catch (e) {
      thrown = e
    }
    const reply = agentFailureReply(thrown, 'The board could not complete this call', log, 'error', 'same-key')
    expect(reply).toMatchObject({
      ok: false,
      code: 'error',
      reason: 'internal',
      retry: 'none',
      errorClass: 'SyntaxError',
    })
    expect(reply.message).not.toMatch(/operationKey|10415/)
    expect(reply.errorId).toMatch(/^[0-9a-f]{12}$/)
  })

  it('reports a timeout anywhere in the cause chain as a transient outage with the caller retry', () => {
    const timeout = new Error('outer', {
      cause: Object.assign(new Error('rpc https://x/KEY'), { name: 'TimeoutError' }),
    })
    expect(agentFailureReply(timeout, 'Read failed', vi.fn(), 'error', 'read')).toMatchObject({
      code: 'unavailable',
      reason: 'transient',
      retry: 'read',
      errorClass: 'Error',
    })
    expect(failureKind(timeout)).toBe('transient')
  })

  it('keeps stored-data refusals and argument fields through the reply and its round trip', () => {
    const stored = agentFailureReply(new StoredDataError('application a has a malformed stored agent id'), 'fallback')
    expect(stored).toEqual({
      ok: false,
      code: 'conflict',
      message: 'application a has a malformed stored agent id',
      reason: 'stored-data',
      retry: 'none',
    })
    const field = Object.assign(new AgentFailure('invalid', 'agentId: bad', 'invalid-arguments', 'none'), {
      field: 'invite.agentId',
    })
    const reply = agentFailureReply(field, 'fallback')
    expect(reply).toMatchObject({ field: 'invite.agentId', retry: 'none' })
    expect(agentFailureReply(failureFromReply(reply), 'fallback')).toEqual(reply)
  })

  it('marks a server fault for the owner alert in the default sink, but not an outage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      agentFailureReply(new SyntaxError('Cannot convert 10415.0 to a BigInt'), 'fallback')
      agentFailureReply(Object.assign(new Error('slow'), { name: 'TimeoutError' }), 'fallback')
      // SAFETY: the default sink writes one JSON object per line.
      const lines = spy.mock.calls.map(([line]) => JSON.parse(String(line)) as { name: string; alert?: string })
      expect(lines).toEqual([
        expect.objectContaining({ name: 'SyntaxError', alert: 'internal_error' }),
        expect.not.objectContaining({ alert: expect.anything() }),
      ])
      expect(spy.mock.calls.join('\n')).not.toContain('10415')
    } finally {
      spy.mockRestore()
    }
  })
})
