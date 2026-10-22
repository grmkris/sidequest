import { ADMISSION_OBJECT_NAME, SPONSOR_OBJECT_NAME, WRITE_LIMITS } from '@sidequest/board'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/http/HttpBody'
import * as HttpClient from 'effect/http/HttpClient'
import { expect } from 'vitest'
import AdmissionProbe from './admission-worker.ts'

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})
const Stack = Alchemy.Stack(
  'E38LocalAdmissionProbe',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* AdmissionProbe
    return { url: worker.url }
  }),
)
const stack = beforeAll(deploy(Stack))

test(
  'real local Durable Object rejects forged caller, board, network, and policy before service construction',
  Effect.gen(function* () {
    const { url } = yield* stack
    const env = {
      network: 'monad-mainnet',
      boardId: 'public',
      rpcUrl: '',
      domain: 'test.invalid',
      uri: 'https://test.invalid',
      manifestBaseUrl: '',
      screening: { baseUrl: '', apiKey: '', model: '' },
      attesterKey: '',
      relayKey: '',
      github: { appId: '', privateKeyPem: '', installationId: '' },
    }
    const attempts = [
      { tool: 'create_task', args: {}, env },
      {
        tool: 'create_task',
        args: { caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        env,
      },
      { tool: 'request_quotes', args: {}, env: { ...env, admission: { enabled: false } } },
      { tool: 'create_task', args: {}, env: { ...env, boardId: 'other' } },
      { tool: 'create_task', args: {}, env: { ...env, network: 'monad-testnet' } },
      { tool: 'upgrade_account', args: {}, env },
      { tool: 'sponsor_prepare', args: { wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, env },
    ]
    for (const [index, call] of attempts.entries()) {
      const response = yield* HttpClient.post(url as string, {
        body: HttpBody.text(JSON.stringify({ name: 'public', call }), 'application/json'),
      })
      const result = (yield* response.json) as { ok: boolean; code: string; message: string }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('forbidden')
      expect(result.message).not.toContain('no deployment')
      if (index === 0) expect(result.message).toContain('authenticated wallet')
      if (index === 1) expect(result.message).toContain('authenticated session wallet')
      if (index === 3) expect(result.message).toContain('board identity mismatch')
      if (index === 4) expect(result.message).toContain('runtime network/stage mismatch')
      if (index === 6) expect(result.message).toContain('board identity mismatch')
    }
    const response = yield* HttpClient.post(url as string, {
      body: HttpBody.text(
        JSON.stringify({
          name: SPONSOR_OBJECT_NAME,
          call: { tool: 'sponsor_submit', args: {}, caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', env },
        }),
        'application/json',
      ),
    })
    expect(yield* response.json).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'Durable Object caller is not the authenticated session wallet',
    })
  }),
)

test(
  'real workerd counters serialize concurrent REST/MCP-equivalent admissions across boards',
  Effect.gen(function* () {
    const { url } = yield* stack
    // Local workerd state survives suite reruns; each drill needs fresh wallet and IP counters.
    const wallet = `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}`
    const token = `local-test-${crypto.randomUUID()}`
    const ipPrefix = `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}`
    const admit = {
      network: 'monad-mainnet',
      boardId: 'public',
      tool: 'create_board',
      bearer: token,
      caller: wallet,
      ip: `${ipPrefix}::10`,
    }
    const post = (body: unknown) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.post(url as string, {
          body: HttpBody.text(JSON.stringify(body), 'application/json'),
        })
        return (yield* response.json) as { ok: boolean; code?: string; retryAfter?: number }
      })
    expect(yield* post({ name: ADMISSION_OBJECT_NAME, admit, seed: { token, wallet } })).toEqual({ ok: true })
    const results = yield* Effect.all(
      Array.from({ length: WRITE_LIMITS.wallet + 5 }, (_, n) =>
        post({
          name: ADMISSION_OBJECT_NAME,
          admit: {
            ...admit,
            boardId: n % 2 ? 'public' : 'other-board',
            tool: n % 2 ? 'create_task' : 'submit_quote',
            ip: `${ipPrefix}::${20 + n}`,
          },
        }),
      ),
      { concurrency: 10 },
    )
    expect(results.filter((r) => r.ok)).toHaveLength(WRITE_LIMITS.wallet - 1)
    expect(results.filter((r) => !r.ok).every((r) => r.code === 'rate-limited' && (r.retryAfter ?? 0) > 0)).toBe(true)
    const env = {
      network: 'monad-mainnet',
      boardId: 'public',
      rpcUrl: '',
      domain: 'test.invalid',
      uri: 'https://test.invalid',
      manifestBaseUrl: '',
      screening: { baseUrl: '', apiKey: '', model: '' },
      attesterKey: '',
      relayKey: '',
      github: { appId: '', privateKeyPem: '', installationId: '' },
    }
    expect(
      yield* post({
        name: 'public',
        call: {
          tool: 'create_task',
          args: { ip: '203.0.113.1', caller: 'ignored' },
          bearer: token,
          caller: wallet,
          ip: `${ipPrefix}::200`,
          env,
        },
      }),
    ).toMatchObject({ ok: false, code: 'rate-limited' })
    expect(yield* post({ name: ADMISSION_OBJECT_NAME, admit: { ...admit, tool: 'list_tasks' } })).toEqual({ ok: true })
    expect(yield* post({ name: 'wrong-object', admit })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(
      yield* post({
        name: ADMISSION_OBJECT_NAME,
        admit: { ...admit, caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })
    expect(yield* post({ name: ADMISSION_OBJECT_NAME, admit: { ...admit, ip: undefined } })).toMatchObject({
      ok: false,
      code: 'forbidden',
    })
  }),
)

test(
  "an operator continuation without a session keeps the management object's refusal across Durable Object RPC",
  Effect.gen(function* () {
    const { url } = yield* stack
    const env = {
      network: 'monad-mainnet',
      boardId: 'public',
      rpcUrl: '',
      domain: 'test.invalid',
      uri: 'https://test.invalid',
      manifestBaseUrl: '',
      screening: { baseUrl: '', apiKey: '', model: '' },
      attesterKey: '',
      relayKey: '',
      github: { appId: '', privateKeyPem: '', installationId: '' },
    }
    // SAFETY: the deployed probe Worker's url is a string.
    const response = yield* HttpClient.post(url as string, {
      body: HttpBody.text(
        JSON.stringify({
          name: 'public',
          call: {
            tool: 'submit_work',
            args: {},
            caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            env,
            agentAuth: { agentId: '1', resource: 'https://test.invalid/mcp', operator: true },
          },
        }),
        'application/json',
      ),
    })
    // Thrown across RPC, this refusal lost its class and came back as an internal fault with an error id to retry.
    expect(yield* response.json).toEqual({ ok: false, code: 'unauthenticated', message: 'Operator session required' })
  }),
)
