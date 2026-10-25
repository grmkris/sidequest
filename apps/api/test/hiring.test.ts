import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { hiringResource, hiringTools, renderHiring, safe, HIRING_URI } from '../src/mcp-hiring.ts'
import { mcpRoute } from '../src/mcp.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const check = (v: unknown) => {
  if (v && typeof v === 'object')
    for (const [key, child] of Object.entries(v)) {
      expect(key).not.toMatch(/token|secret|password|authorization|cookie|private.?key|api.?key/i)
      check(child)
    }
}
const ignoreMessage = (_event: unknown) => {}
const root = new URL('../../../', import.meta.url)
const grant: OAuthGrant = {
  owner: 'o',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  scopes: ['sidequest:read'],
  agentIds: ['a'],
  registryAgentId: '1',
  clientId: 'c',
  resource: 'http://localhost/mcp',
}
const task = {
  taskId: 't',
  title: 'A public hire',
  token: 'asset',
  reward: '10',
  creator: grant.address,
  approver: grant.address,
  chain: { status: 'submitted', paused: false },
  funding: { state: 'escrowed', source: 'chain' },
  nextAction: { actor: 'approver', action: 'approve_or_reject' },
  operationStatus: 'confirmed',
  terms: { acceptanceCriteria: ['Readable source'], token: 'asset' },
  you: ['creator', 'approver'],
  deliverables: [{ descriptor: { password: 'hidden', content: '<script>bad()</script>' } }],
  onchainSubmission: { deliverable_hash: 'hash' },
}
const call = vi.fn(async (name: string, _args: Record<string, unknown>, _agent: string) => ({
  ok: true,
  result:
    name === 'list_quote_requests'
      ? { requests: [] }
      : name === 'list_tasks'
        ? [task]
        : name === 'get_task'
          ? task
          : [],
}))
const request = (method: string, params: Record<string, unknown>, auth = true) =>
  mcpRoute({
    method: 'POST',
    pathname: '/mcp',
    origin: 'http://localhost',
    headers: {},
    body: { id: 1, method, params },
    ...(auth ? { grant } : {}),
    tools: {},
    call,
  })
const result = (reply: Awaited<ReturnType<typeof request>>) =>
  (reply.body as { result: Record<string, unknown> }).result

it('lists portable render metadata and serves a single authenticated inline App', async () => {
  const tools = result(await request('tools/list', {})).tools as Record<string, unknown>[]
  for (const name of Object.keys(hiringTools)) {
    const tool = tools.find((v) => v.name === name)!
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    })
    expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['sidequest:read'] }])
    expect(tool._meta).toMatchObject({ ui: { resourceUri: HIRING_URI }, 'openai/outputTemplate': HIRING_URI })
    expect(tool.inputSchema).not.toHaveProperty('properties.operationKey')
  }
  expect(result(await request('resources/read', { uri: HIRING_URI })).contents).toEqual([hiringResource])
  expect(hiringResource._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [] })
  for (const [method, params] of [
    ['resources/read', { uri: HIRING_URI }],
    ['tools/call', { name: 'show_task', arguments: { taskId: 't' } }],
  ] as const)
    expect((await request(method, params, false)).status).toBe(401)
})
it('uses only same-agent reads and keeps complete text without redacted App keys', async () => {
  const reply = result(await request('tools/call', { name: 'show_task', arguments: { taskId: 't' } }))
  expect(reply.structuredContent).toEqual(JSON.parse((reply.content as { text: string }[])[0]!.text))
  expect(reply.structuredContent).toMatchObject({
    ok: true,
    result: { task: { rewardAsset: 'asset', funding: { state: 'escrowed' }, operationStatus: 'confirmed' } },
  })
  check(reply.structuredContent)
  expect(JSON.stringify(reply.structuredContent)).not.toContain('hidden')
  for (const [name, _args, agent] of call.mock.calls) {
    expect(['list_quote_requests', 'get_task', 'list_applications']).toContain(name)
    expect(agent).toBe('a')
  }
  expect(safe({ token: 'asset', tokens: ['asset'], signature: 'secret', nested: { apiKey: 'hidden' } })).toEqual({
    assetAddress: 'asset',
    acceptedAssets: ['asset'],
    nested: {},
  })
})
it('groups by chain stage and keeps funding separate from confirmed operations', async () => {
  const data = (await renderHiring('show_hiring_dashboard', {}, 'a', async (name) => ({
    ok: true,
    result:
      name === 'list_quote_requests'
        ? {
            requests: [
              { requestId: 'r', taskId: null, status: 'Accepting quotes, reward not escrowed' },
              { requestId: 'closed', taskId: null, status: 'Quotes closed, reward not escrowed' },
              { requestId: 'old', taskId: null, status: 'Expired, reward not escrowed' },
            ],
          }
        : name === 'list_quotes'
          ? { quotes: [] }
          : [
              task,
              {
                ...task,
                taskId: 'open',
                chain: { status: 'open' },
                nextAction: { actor: 'creator' },
                funding: { state: 'not-escrowed' },
              },
            ],
  }))) as { result: { groups: Record<string, Record<string, unknown>[]> } }
  expect(data.result.groups.review).toHaveLength(1)
  // Closed quotes still wait for the creator's pick; expired requests are finished.
  expect(data.result.groups['accepting quotes']!.map((r) => r.requestId)).toEqual(['r'])
  expect(data.result.groups['needs your action']!.map((r) => r.requestId)).toContain('closed')
  expect(data.result.groups.finished!.map((r) => r.requestId)).toContain('old')
  expect(data.result.groups['needs your action']!.find((r) => r.taskId === 'open')).toMatchObject({
    funding: { state: 'not-escrowed' },
    operationStatus: 'confirmed',
  })
})
it('parses balanced HTML, pins inline CSP and detects a stale committed artifact', () => {
  expect(() => execFileSync('node', ['scripts/gen-hiring.mjs', '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow()
  const html = hiringResource.text
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  expect(Buffer.byteLength(html)).toBeLessThan(300 * 1024)
  expect(html).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`)
  expect(script).not.toMatch(/fetch\(|localStorage|document\.cookie|document\.domain|ui\/message/)
  const parser = `from html.parser import HTMLParser\nimport sys\nclass P(HTMLParser):\n def __init__(self): super().__init__(); self.stack=[]; self.ids=[]\n def handle_starttag(self,t,a):\n  d=dict(a); assert 'src' not in d and 'href' not in d\n  if 'id' in d: self.ids.append(d['id'])\n  if t!='meta': self.stack.append(t)\n def handle_endtag(self,t): assert self.stack.pop()==t\np=P(); p.feed(sys.stdin.read()); assert not p.stack; assert len(p.ids)==len(set(p.ids)); assert 'content' in p.ids\n`
  expect(() => execFileSync('python3', ['-c', parser], { input: html })).not.toThrow()
})
class Element {
  children: Element[] = []
  textContent = ''
  className = ''
  hidden = false
  disabled = false
  value = ''
  dataset = {}
  style = { setProperty: vi.fn() }
  scrollHeight = 900
  listeners: Record<string, () => unknown> = {}
  constructor(readonly tag: string) {}
  append(...items: Element[]) {
    this.children.push(...items)
  }
  replaceChildren(...items: Element[]) {
    this.children = items
    this.textContent = ''
  }
  setAttribute() {}
  addEventListener(name: string, handler: () => unknown) {
    this.listeners[name] = handler
  }
  click() {
    return this.listeners.click?.()
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((v) => v.all())]
  }
}
function host(width: number) {
  const ids = new Map<string, Element>()
  for (const id of ['content', 'status', 'confirmation', 'retry', 'refresh', 'dashboard', 'context', 'fullscreen'])
    ids.set(id, new Element('div'))
  const sent: Record<string, unknown>[] = []
  const parent = { postMessage: (v: Record<string, unknown>) => sent.push(v) }
  let message: (event: unknown) => void = ignoreMessage
  const window = {
    parent,
    innerWidth: width,
    addEventListener: (_: string, callback: typeof message) => {
      message = callback
    },
  }
  const document = {
    getElementById: (id: string) => ids.get(id),
    createElement: (tag: string) => new Element(tag),
    documentElement: new Element('html'),
  }
  runInNewContext(hiringResource.text.match(/<script>([\s\S]*)<\/script>/)![1]!, {
    window,
    document,
    URL,
    crypto: { randomUUID: () => 'fresh-action' },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  return { ids, sent, receive: (data: unknown, source: unknown = parent) => message({ data, source, origin: 'null' }) }
}
const tick = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}
it.each([390, 1200])(
  'initializes at %i px, renders text safely and requires confirmation with identical-key retry',
  async (width) => {
    const h = host(width)
    expect(h.sent[0]).toMatchObject({ method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } })
    h.receive({
      jsonrpc: '2.0',
      id: h.sent[0]!.id,
      result: { hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: {} },
    })
    await tick()
    expect(h.sent).toContainEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    const reply = { ok: true, result: { view: 'task', task: { ...task, rewardAsset: task.token } } }
    h.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: reply } }, {})
    expect(h.ids.get('content')!.children).toHaveLength(0)
    h.receive({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: JSON.stringify(reply) }] },
    })
    const all = h.ids.get('content')!.all()
    expect(all.map((v) => v.textContent)).toContain('Acceptance criteria')
    expect(all.map((v) => v.textContent)).toContain('Submitted delivery')
    expect(all.find((v) => v.className === 'comparison')?.children).toHaveLength(2)
    expect(all.some((v) => v.tag === 'script')).toBe(false)
    all.find((v) => v.textContent === 'Accept submitted work')!.click()
    expect(h.sent.filter((v) => v.method === 'tools/call')).toHaveLength(0)
    expect(
      h.ids
        .get('confirmation')!
        .all()
        .map((v) => v.textContent)
        .join(' '),
    ).toContain('Readable source')
    h.ids
      .get('confirmation')!
      .all()
      .find((v) => v.textContent === 'Confirm these terms')!
      .click()
    const first = h.sent.find((v) => v.method === 'tools/call')!
    expect(first.params).toEqual({ name: 'approve_work', arguments: { taskId: 't', operationKey: 'app-fresh-action' } })
    h.receive({
      jsonrpc: '2.0',
      id: first.id,
      result: {
        structuredContent: { ok: true, result: { status: 'approval', approveUrl: 'https://sidequest.test/approval' } },
      },
    })
    await tick()
    expect(
      h.ids
        .get('status')!
        .all()
        .map((v) => v.textContent),
    ).toContain('approval')
    expect(
      h.ids
        .get('status')!
        .all()
        .map((v) => v.textContent),
    ).not.toContain('confirmed')
    h.ids.get('retry')!.click()
    expect(h.sent.filter((v) => v.method === 'tools/call').at(-1)!.params).toEqual(first.params)
  },
)
