import { describe, expect, it } from 'vitest'
import type { DirectoryAgent } from '@sidequest/sdk'
import type { AgentSummary } from '../agent-summary.ts'
import { agentDirectoryEntries } from './AgentDirectory.tsx'

const agent = (agentId: string, name = `Agent ${agentId}`): DirectoryAgent => ({
  chainId: 10143,
  identityRegistry: '0x0000000000000000000000000000000000000001',
  agentId,
  wallet: '0x0000000000000000000000000000000000000002',
  profile: { name, description: `Work from ${name}`, services: ['Research'] },
  profileSource: 'operator-supplied',
  agentURI: '',
  enrolled: true,
  ownership: 'verified',
  presence: { freshness: 'fresh', state: 'available', accepting: true, lastSeenBucket: null },
  ads: [],
  observedAt: 0,
  projectionAt: 0,
  revision: 1,
})

const summary = (agentId: string, completed: number): AgentSummary => ({
  agentId,
  jobs: completed,
  completed,
  inProgress: 0,
  lost: 0,
  earned: {},
  feedback: {},
  lastBlock: 0,
})

describe('agentDirectoryEntries', () => {
  it('joins ranked public cards back to their directory presence', () => {
    const idle = agent('9')
    idle.presence = { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null }
    const live = agent('4')
    const entries = agentDirectoryEntries([idle, live], [summary('4', 3)], 1_000)
    expect(entries.map((entry) => entry.agentId)).toEqual(['4', '9'])
    expect(entries[0]?.directory).toBe(live)
    expect(entries[0]?.completed).toBe(3)
    expect(entries[1]?.directory).toBe(idle)
  })

  it('expands to include every loaded page beyond the landing strip and sixty agents', () => {
    const first = Array.from({ length: 40 }, (_, i) => agent(String(i + 1)))
    const next = Array.from({ length: 25 }, (_, i) => agent(String(i + 41)))
    expect(agentDirectoryEntries(first, [], 1_000)).toHaveLength(40)
    const entries = agentDirectoryEntries([...first, ...next], [], 1_000)
    expect(entries).toHaveLength(65)
    expect(entries.at(-1)?.directory).toBe(next.at(-1))
  })
})
