import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { maintainOnce, type MaintainerOptions } from './maintainer.ts'
import { GitHubShip, RateLimited, trailerIds } from './maintainer-ship.ts'
import { validTriage, type TriageGap, type TriageItem } from './maintainer-triage.ts'
import type { ModerationVerdict } from './moderation.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true })
})
async function stateFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'maintainer-test-'))
  dirs.push(dir)
  return path.join(dir, 'state.json')
}

const keep: ModerationVerdict = { verdict: 'keep', category: 'ok', reason: 'ok' }
const hide: ModerationVerdict = { verdict: 'hide', category: 'prompt_injection', reason: 'x' }

/** A board that answers reads from fixtures and records every write. */
function board(reads: Record<string, (args: Record<string, unknown>) => object>) {
  const writes: { tool: string; args: Record<string, unknown> }[] = []
  return {
    writes,
    call: async <T>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
      const read = reads[tool]
      if (read !== undefined) {
        // SAFETY: each fixture returns the shape its tool's caller reads.
        return read(args) as T
      }
      writes.push({ tool, args })
      // SAFETY: writers ignore the board's answer.
      return {} as T
    },
  }
}
const thread = (args: Record<string, unknown>) => ({
  messages: [
    { id: Number(String(args.before).slice(2)) - 1, body: 'Please deliver', hidden: {}, badges: [{ kind: 'owner' }] },
  ],
})
const gap = (id: number, tool: string | null, gapType = 'incomplete_results', itemIds: number[] = []): TriageGap => ({
  id,
  gapType,
  tool,
  needed: `Need ${id}`,
  reports: 1,
  reporters: 1,
  itemIds,
})
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })
const quiet = {
  list_gaps: () => ({ gaps: [] }),
  list_roadmap: () => ({ items: [] }),
}
const noShips = { shipped: async () => [] }
const base = (b: ReturnType<typeof board>, file: string): MaintainerOptions => ({
  board: b,
  endpoint: { baseUrl: 'http://model', model: 'm', apiKey: 'k' },
  stateFile: file,
  shipSince: '2026-10-10T18:00:00Z',
  github: noShips,
  plan: async () => ({ merges: [], links: [], proposals: [] }),
})

describe('hide review', () => {
  const log = [
    {
      seq: 1,
      action: 'hide',
      role: 'maintainer',
      targetKind: 'message',
      targetId: 3,
      subject: 'lobby',
      reason: 'spam: x',
    },
    {
      seq: 2,
      action: 'hide',
      role: 'moderator',
      targetKind: 'message',
      targetId: 12,
      subject: 'job:public:t1',
      reason: 'prompt_injection: x',
    },
    {
      seq: 3,
      action: 'hide',
      role: 'moderator',
      targetKind: 'message',
      targetId: 14,
      subject: 'lobby',
      reason: 'spam: x',
    },
  ]

  it('restores one moderator false positive a pass, with a fixed reason, never reviewing a maintainer hide', async () => {
    const file = await stateFile()
    const seen: string[] = []
    const b = board({ ...quiet, list_roles: () => ({ log }), list_messages: thread })
    await maintainOnce({
      ...base(b, file),
      classify: async (text) => {
        seen.push(text)
        return { verdict: keep, failed: false }
      },
    })
    expect(b.writes).toEqual([
      {
        tool: 'unhide_content',
        args: {
          kind: 'message',
          id: 12,
          reason: 'Second review found ordinary marketplace talk, not prompt injection; restored by the maintainer.',
        },
      },
    ])
    expect(JSON.parse(seen[0]!)).toEqual({ where: "a job's thread", author: ['owner'], text: 'Please deliver' })
    // The next pass resumes after message 12 and reviews message 14.
    expect(JSON.parse(await readFile(file, 'utf8')).logCursor).toBe('c:2')
  })

  it('keeps a hide the review agrees with, and retries an entry whose review failed', async () => {
    const file = await stateFile()
    const b = board({ ...quiet, list_roles: () => ({ log: [log[1]] }), list_messages: thread })
    await maintainOnce({ ...base(b, file), classify: async () => ({ verdict: hide, failed: false }) })
    expect(b.writes).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8')).logCursor).toBe('c:2')
    const retry = await stateFile()
    await maintainOnce({ ...base(b, retry), classify: async () => ({ verdict: keep, failed: true }) })
    expect(b.writes).toEqual([])
    expect(JSON.parse(await readFile(retry, 'utf8')).logCursor).toBeUndefined()
  })
})

describe('triage rules', () => {
  const gaps = [
    gap(5, 'get_task'),
    gap(6, 'inbox'),
    gap(7, 'inbox'),
    gap(8, 'inbox', 'missing_tool'),
    gap(9, 'whoami', 'x', [2]),
  ]
  const items: TriageItem[] = [
    { id: 2, title: 'Arbiter', status: 'open' },
    { id: 3, title: 'Shipped', status: 'shipped' },
  ]

  it('merges only within one type and tool, links only to live items, proposes only for two reporters', () => {
    const actions = validTriage(
      {
        merges: [
          { source: 7, target: 6 },
          { source: 8, target: 6 },
          { source: 5, target: 5 },
        ],
        links: [
          { itemId: 2, gapIds: [5, 9] },
          { itemId: 3, gapIds: [5] },
        ],
        proposals: [{ gapIds: [6] }, { gapIds: [8] }],
      },
      gaps,
      items,
      (ids) => (ids.includes(6) ? 2 : 1),
      10,
    )
    expect(actions.map((a) => [a.tool, a.args])).toEqual([
      [
        'merge_gaps',
        { sourceGapId: 7, targetGapId: 6, reason: 'Same tool, gap type and root cause (maintainer triage).' },
      ],
      [
        'link_gaps',
        { itemId: 2, gapIds: [5], reason: 'These gaps describe what this item fixes (maintainer triage).' },
      ],
      [
        'propose_item',
        {
          title: 'inbox: Need 6',
          problem: '2 agents reported this as incomplete_results. Need 6',
          proposal: 'Change inbox so agents can do this directly. The linked gap reports list what each agent tried.',
          gapIds: [6],
        },
      ],
    ])
    expect(
      validTriage({ merges: [{ source: 7, target: 6 }], links: [], proposals: [] }, gaps, items, () => 0, 0),
    ).toEqual([])
  })
})

describe('ship', () => {
  it('reads trailer ids', () => {
    expect(trailerIds('fix\n\nCommons-Gaps: 2, 3, 5, x\nCo-Authored-By: a', 'Commons-Gaps')).toEqual([2, 3, 5])
    expect(trailerIds('Commons-Roadmap: 4', 'Commons-Roadmap')).toEqual([4])
  })

  it('counts a trailer commit only once a push run with a green deploy-dev contains it', async () => {
    const calls: string[] = []
    const github = new GitHubShip(async (url) => {
      const route = url.replace('https://api.github.com/repos/grmkris/sidequest', '')
      calls.push(route.split('?')[0]!)
      if (route.startsWith('/commits'))
        return json([
          { sha: 'new', commit: { message: 'x\n\nCommons-Gaps: 4', committer: { date: '2026-10-10T20:00:00Z' } } },
          { sha: 'plain', commit: { message: 'no trailer', committer: { date: '2026-10-10T19:30:00Z' } } },
          { sha: 'old', commit: { message: 'y\n\nCommons-Roadmap: 4', committer: { date: '2026-10-10T19:00:00Z' } } },
        ])
      if (route.startsWith('/actions/runs?'))
        return json({
          workflow_runs: [
            { id: 1, head_sha: 'manual', event: 'workflow_dispatch' },
            { id: 2, head_sha: 'head', event: 'push' },
          ],
        })
      if (route === '/actions/runs/2/jobs') return json({ jobs: [{ name: 'deploy-dev', conclusion: 'success' }] })
      if (route === '/compare/old...head') return json({ status: 'ahead' })
      if (route === '/compare/new...head') return json({ status: 'behind' })
      return json({}, 404)
    })
    expect(await github.shipped('2026-10-10T18:00:00Z', new Set())).toEqual([
      { sha: 'old', date: '2026-10-10T19:00:00Z', gaps: [], items: [4] },
    ])
    expect(calls).not.toContain('/actions/runs/1/jobs')
    const limited = new GitHubShip(async () => json({}, 403, { 'x-ratelimit-reset': '1791660000' }))
    await expect(limited.shipped('2026-10-10T18:00:00Z', new Set())).rejects.toEqual(new RateLimited(1791660000))
  })

  it('marks named gaps fixed and items shipped with a note, once per commit, and backs off on a rate limit', async () => {
    const file = await stateFile()
    const b = board({ ...quiet, list_roles: () => ({ log: [] }) })
    const commit = { sha: 'abcdef1234567890', date: '2026-10-10T20:00:00Z', gaps: [8, 11], items: [4] }
    await maintainOnce({
      ...base(b, file),
      github: { shipped: async (_since, done) => (done.has(commit.sha) ? [] : [commit]) },
    })
    expect(b.writes.map((w) => [w.tool, w.args])).toEqual([
      ['set_gap_status', { gapId: 8, status: 'fixed', reason: 'Live on dev in abcdef12.' }],
      ['set_gap_status', { gapId: 11, status: 'fixed', reason: 'Live on dev in abcdef12.' }],
      ['set_item_status', { itemId: 4, status: 'shipped', reason: 'Live on dev in abcdef12.' }],
      [
        'post_message',
        { subject: 'roadmap:4', body: 'Shipped on dev: https://github.com/grmkris/sidequest/commit/abcdef1234567890' },
      ],
    ])
    await maintainOnce({
      ...base(b, file),
      github: { shipped: async (_since, done) => (done.has(commit.sha) ? [] : [commit]) },
    })
    expect(b.writes).toHaveLength(4)
    await maintainOnce({
      ...base(b, file),
      now: () => 100,
      github: {
        shipped: async () => {
          throw new RateLimited(500)
        },
      },
    })
    expect(JSON.parse(await readFile(file, 'utf8')).backoffUntil).toBe(500)
    let asked = false
    await maintainOnce({
      ...base(b, file),
      now: () => 200,
      github: {
        shipped: async () => {
          asked = true
          return []
        },
      },
    })
    expect(asked).toBe(false)
  })
})
