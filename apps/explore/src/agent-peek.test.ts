import { describe, expect, it } from 'vitest'
import type { DirectoryAgent } from '@sidequest/sdk'
import type { AgentSummary } from './agent-summary.ts'
import { agentPeekFacts } from './agent-peek.ts'

const now = 1_000
const agent = (agentId: string, overrides: Partial<DirectoryAgent> = {}): DirectoryAgent => ({
  chainId: 10143,
  identityRegistry: '0x0000000000000000000000000000000000000001',
  agentId,
  wallet: '0x0000000000000000000000000000000000000002',
  profile: { name: 'Reel', description: '', services: ['Explainer videos'] },
  profileSource: 'operator-supplied',
  agentURI: '',
  enrolled: true,
  ownership: 'verified',
  presence: { freshness: 'fresh', state: null, accepting: true, lastSeenBucket: null },
  ads: [],
  observedAt: 0,
  projectionAt: 0,
  revision: 1,
  ...overrides,
})
const record: AgentSummary = {
  agentId: '2025',
  jobs: 4,
  completed: 3,
  inProgress: 1,
  lost: 0,
  earned: { '0xt': '9800000' },
  feedback: {},
  lastBlock: 0,
}

describe('agentPeekFacts', () => {
  it('reads a listed agent as the specialists strip does, crew tagline included', () => {
    expect(agentPeekFacts(agent('2025'), record, undefined, now)).toEqual({
      name: 'Reel',
      tagline: 'Explainers, documentaries and podcasts.',
      wallet: agent('2025').wallet,
      completed: 3,
      earned: { '0xt': '9800000' },
      accepting: true,
    })
  })

  it("lets the agent's own profile tagline win", () => {
    expect(agentPeekFacts(agent('2025'), record, '  Videos that explain.  ', now).tagline).toBe('Videos that explain.')
  })

  it('reads an entry whose ownership changed from the entry itself, and stale presence as not taking work', () => {
    const entry = agent('77', {
      ownership: 'changed',
      profile: { name: 'Solo', description: 'Odd jobs.', services: [] },
      presence: { freshness: 'stale', state: null, accepting: true, lastSeenBucket: null },
    })
    expect(agentPeekFacts(entry, undefined, undefined, now)).toEqual({
      name: 'Solo',
      tagline: 'Odd jobs.',
      wallet: entry.wallet,
      completed: 0,
      earned: {},
      accepting: false,
    })
  })

  it('knows only the record of an agent the directory does not list', () => {
    expect(agentPeekFacts(undefined, record, undefined, now)).toEqual({
      name: null,
      tagline: '',
      wallet: null,
      completed: 3,
      earned: { '0xt': '9800000' },
      accepting: null,
    })
  })
})
