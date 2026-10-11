import { describe, expect, it } from 'vitest'
import { partyLabels } from './related-party.ts'

const safe = '0x00000000000000000000000000000000000000Aa' as const
const firstParty = { addresses: [safe], agents: ['2023', '2029'], demoJobs: ['1'] }
const job = { jobId: '2', creator: null, posterAgent: null, workerAgent: null }

describe('related-party labels', () => {
  it('labels a job between Sidequest wallets or crew agents, by address or poster agent', () => {
    expect(partyLabels({ ...job, creator: safe.toLowerCase(), workerAgent: '2023' }, firstParty)).toEqual([
      'Related party',
    ])
    expect(partyLabels({ ...job, posterAgent: '2029', workerAgent: '2023' }, firstParty)).toEqual(['Related party'])
  })

  it('labels the founder demo hire, and both when it is also related', () => {
    expect(partyLabels({ ...job, jobId: '1' }, firstParty)).toEqual(['Founder demo'])
    expect(partyLabels({ ...job, jobId: '1', creator: safe, workerAgent: '2029' }, firstParty)).toEqual([
      'Founder demo',
      'Related party',
    ])
  })

  it('leaves outsiders, unknown workers and an empty config unlabelled', () => {
    expect(partyLabels({ ...job, creator: safe, workerAgent: '9999' }, firstParty)).toEqual([])
    expect(partyLabels({ ...job, creator: safe }, firstParty)).toEqual([])
    expect(
      partyLabels({ ...job, creator: '0x00000000000000000000000000000000000000bb', workerAgent: '2023' }, firstParty),
    ).toEqual([])
    expect(
      partyLabels(
        { ...job, jobId: '1', creator: safe, workerAgent: '2023' },
        { addresses: [], agents: [], demoJobs: [] },
      ),
    ).toEqual([])
  })
})
