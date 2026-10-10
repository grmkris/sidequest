/**
 * `bun test crew/bin/hosted-hirer.test.ts`: a hosted hirer's writes against a fake board. Each write is saved with its
 * key before it is called, called again with the same key until it is confirmed, and moved to a fresh key only when
 * the board says the old one is spent.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hosted-hirer-'))
process.env.MONAD_RPC_URL ??= 'https://testnet-rpc.monad.xyz'
process.env.ACTIVITY_STATE = join(root, 'state')
process.env.HOSTED_ROOT = join(root, 'hosted')

const { secretFile } = await import('./hosted-mcp.ts')
const { act, HostedHirer } = await import('./hosted-hirer.ts')
const { personas } = await import('./hirer-mind.ts')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const [persona] = personas
if (persona === undefined) throw new Error('no personas')
// A token that outlives the test, so no refresh is attempted.
secretFile(join(root, 'hosted', persona.id, 'client.json'), { clientId: 'c' })
secretFile(join(root, 'hosted', persona.id, 'token.json'), {
  access_token: 't',
  refresh_token: 'r',
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  agent_id: '1',
  scope: 'sidequest:read sidequest:hire',
})

const fetchSpy = spyOn(globalThis, 'fetch')
/** The keys the board was called with, in order. */
const keys: string[] = []

/** The board answers each tools/call with the next reply (a write's state, or a refusal). */
function board(...replies: Array<{ text: string; isError?: boolean }>) {
  fetchSpy.mockImplementation(async (_url, init) => {
    // SAFETY: the client under test always sends a JSON-RPC tools/call with an arguments object.
    const body = JSON.parse(init?.body as string) as { params: { arguments: { operationKey?: string } } }
    keys.push(body.params.arguments.operationKey ?? '')
    const reply = replies.shift() ?? { text: '{"status":"pending"}' }
    // A write's state comes back as the tool result, inside the board's `{ ok, result }`; a refusal as it is.
    const text = reply.isError === true ? reply.text : JSON.stringify({ ok: true, result: JSON.parse(reply.text) })
    return new Response(JSON.stringify({ result: { content: [{ text }], isError: reply.isError } }))
  })
}

function freshJob(h: InstanceType<typeof HostedHirer>, n: number) {
  const job = {
    key: `${persona.id}-h${n}`,
    n,
    kind: 'skill' as const,
    plan: 'normal' as const,
    title: 't',
    criteria: ['c'],
    budget: '5',
    postedAt: 0,
    quoteDeadline: 0,
    step: 'working' as const,
    settles: 0,
    errors: 0,
    ops: {},
  }
  h.data.jobs.push(job)
  return job
}

beforeEach(() => {
  keys.length = 0
  fetchSpy.mockReset()
})

describe('hosted hirer writes', () => {
  it('saves the write before calling, retries a pending one with the same key, and keeps the confirmed result', async () => {
    const h = new HostedHirer(persona)
    const job = freshJob(h, 1)
    board({ text: '{"status":"pending","operationId":"0x1"}' }, { text: '{"status":"confirmed","result":{"ok":1}}' })
    expect(await act(h, job, 'approve', 'approve_work', { taskId: 'x' })).toBeNull()
    // SAFETY: the state file is the HostedData this runtime just wrote.
    const saved = JSON.parse(readFileSync(join(root, 'state', `hosted-${persona.id}.json`), 'utf8')) as {
      jobs: Array<{ ops: Record<string, { key: string; args: unknown }> }>
    }
    expect(saved.jobs.at(-1)!.ops.approve).toMatchObject({ key: `hq1-${persona.id}-1-approve`, args: { taskId: 'x' } })
    expect(await act(h, job, 'approve', 'approve_work', { taskId: 'ignored on retry' })).toEqual({ ok: 1 })
    expect(await act(h, job, 'approve', 'approve_work', { taskId: 'x' })).toEqual({ ok: 1 })
    expect(keys).toEqual([`hq1-${persona.id}-1-approve`, `hq1-${persona.id}-1-approve`])
  })

  it('moves a reverted send to a fresh key, and a spent key too', async () => {
    const h = new HostedHirer(persona)
    const job = freshJob(h, 2)
    board(
      { text: '{"status":"reverted"}' },
      { text: '{"ok":false,"code":"conflict","retry":"new-key"}', isError: true },
      { text: '{"status":"confirmed","result":{}}' },
    )
    expect(await act(h, job, 'settle-1', 'settlement_actions', { taskId: 'x' })).toBeNull()
    expect(await act(h, job, 'settle-1', 'settlement_actions', { taskId: 'x' })).toBeNull()
    expect(await act(h, job, 'settle-1', 'settlement_actions', { taskId: 'x' })).toEqual({})
    expect(keys).toEqual([
      `hq1-${persona.id}-2-settle-1`,
      `hq1-${persona.id}-2-settle-1-r1`,
      `hq1-${persona.id}-2-settle-1-r2`,
    ])
  })

  it('waits on an operator approval and throws on a refusal that gives no advice', async () => {
    const h = new HostedHirer(persona)
    const job = freshJob(h, 3)
    board(
      { text: '{"status":"approval","approveUrl":"https://x/approve"}' },
      { text: '{"ok":false,"code":"invalid","message":"no"}', isError: true },
    )
    expect(await act(h, job, 'pick', 'pick_quote', { requestId: 'r', quoteId: 'q' })).toBeNull()
    expect(job.ops).toMatchObject({ pick: { status: 'approval', approveUrl: 'https://x/approve' } })
    expect(act(h, job, 'pick', 'pick_quote', {})).rejects.toThrow('pick_quote: ')
  })

  it('uses the operationKey a continuation already carries', async () => {
    const h = new HostedHirer(persona)
    const job = freshJob(h, 4)
    board({ text: '{"status":"confirmed","result":{}}' })
    await act(h, job, 'select', 'select_worker', { taskId: 'x', operationKey: 'hq1-x-4-pick-sel' })
    expect(keys).toEqual(['hq1-x-4-pick-sel'])
  })
})
