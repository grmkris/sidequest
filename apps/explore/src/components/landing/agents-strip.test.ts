import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '../../agent-summary.ts'
import type { ChainJob, TaskIndexEntry } from '../../api.ts'
import type { JobListItem } from '../../job-list.ts'
import { recentWork, stripAgents } from './agents-strip.ts'

const now = 1_000
const ad = (name: string, expiresAt: number | null) => ({
  serviceId: name,
  name,
  description: '',
  inputs: '',
  outputs: '',
  turnaroundSeconds: 3600,
  price: {
    model: 'quote' as const,
    amountBaseUnits: '0',
    token: '0x0000000000000000000000000000000000000000' as const,
  },
  adHash: '0x00' as const,
  expiresAt,
})
const agent = (
  agentId: string,
  overrides: Partial<Parameters<typeof stripAgents>[0][number]> = {},
): Parameters<typeof stripAgents>[0][number] => ({
  chainId: 10143,
  identityRegistry: '0x0000000000000000000000000000000000000001',
  agentId,
  wallet: '0x0000000000000000000000000000000000000002',
  profile: { name: `Agent ${agentId}`, description: '', services: [`Service of ${agentId}`] },
  profileSource: 'operator-supplied',
  agentURI: '',
  enrolled: true,
  ownership: 'verified',
  presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null },
  ads: [],
  observedAt: 0,
  projectionAt: 0,
  revision: 1,
  ...overrides,
})
const summary = (agentId: string, completed: number, earned: Record<string, string> = {}): AgentSummary => ({
  agentId,
  jobs: completed,
  completed,
  inProgress: 0,
  lost: 0,
  earned,
  feedback: {},
  lastBlock: 0,
})

describe('stripAgents', () => {
  it('ranks by completed jobs, then live listings, then Agent ID', () => {
    const directory = [agent('9'), agent('3', { ads: [ad('Live', now + 1)] }), agent('5'), agent('7')]
    const ranked = stripAgents(directory, [summary('7', 2, { '0xt': '9800000' })], now)
    expect(ranked.map((a) => a.agentId)).toEqual(['7', '3', '5', '9'])
    expect(ranked[0]).toMatchObject({ completed: 2, earned: { '0xt': '9800000' }, wallet: agent('7').wallet })
  })

  it('lists live listing names before profile services, drops expired ones and repeats, and keeps three', () => {
    const [only] = stripAgents(
      [
        agent('1', {
          profile: { name: 'One', description: '', services: ['Live', 'Profile A', 'Profile B'] },
          ads: [ad('Live', null), ad('Expired', now)],
        }),
      ],
      [],
      now,
    )
    expect(only?.services).toEqual(['Live', 'Profile A', 'Profile B'])
  })

  it('uses the profile description, then the crew tagline, then the first service', () => {
    const [described, crew, other] = stripAgents(
      [
        agent('1', { profile: { name: 'Described', description: ' Says so itself. ', services: [] } }),
        agent('2025'),
        agent('4242'),
      ],
      [],
      now,
    )
    expect(described?.tagline).toBe('Says so itself.')
    expect(crew?.tagline).toBe('Explainers, documentaries and podcasts.')
    expect(other?.tagline).toBe('Service of 4242')
  })

  it('leaves out unenrolled, unverified and unnamed agents, and stops at the limit', () => {
    const directory = [
      agent('1', { enrolled: false }),
      agent('2', { ownership: 'changed' }),
      agent('3', { profile: { name: ' ', description: '', services: [] } }),
      agent('4'),
      agent('5'),
      agent('6'),
    ]
    expect(stripAgents(directory, [], now, 2).map((a) => a.agentId)).toEqual(['4', '5'])
  })
})

// SAFETY: recentWork reads only a job's worker Agent ID and status, and the offer's title.
const job = (jobId: string, agentId: string, status: string): JobListItem => ({
  jobId,
  chain: { agent_id: agentId, status } as ChainJob,
  task: { title: `Job ${jobId}` } as TaskIndexEntry,
})

const presence = (freshness: 'fresh' | 'stale', accepting: boolean) =>
  agent('1', { presence: { freshness, state: null, accepting, lastSeenBucket: null } })

describe('recentWork', () => {
  it("lists an agent's paid jobs, newest first, up to the limit", () => {
    const items = [
      job('4', '7', 'completed'),
      job('9', '7', 'active'),
      job('11', '7', 'completed'),
      job('12', '8', 'completed'),
      job('6', '7', 'completed'),
    ]
    expect(recentWork(items, '7')).toEqual([
      { jobId: '11', title: 'Job 11' },
      { jobId: '6', title: 'Job 6' },
    ])
    expect(recentWork(items, '7', 5)).toHaveLength(3)
  })

  it('counts an agent live only while its heartbeat is fresh and accepting', () => {
    const [fresh, stale] = stripAgents([presence('fresh', true), { ...presence('stale', true), agentId: '2' }], [], now)
    expect([fresh?.accepting, stale?.accepting]).toEqual([true, false])
  })
})
