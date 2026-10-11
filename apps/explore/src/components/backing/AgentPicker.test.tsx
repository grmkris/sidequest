import { expect, it } from 'vitest'
import { deployment } from '../../wallet.ts'
import { rankBackable } from './AgentPicker.tsx'

const presence = (freshness: 'fresh' | 'unknown') => ({
  presence: { freshness, state: null, accepting: true, lastSeenBucket: null },
})

const agent = (name: string, agentId: string, yours: boolean, around: boolean) => ({
  wallet: deployment.relay,
  name,
  agentId,
  yours,
  presence: presence(around ? 'fresh' : 'unknown'),
})

it('ranks your own agents first, then agents around now, then by work delivered', () => {
  const ranked = rankBackable(
    [
      agent('quiet', '1', false, false),
      agent('busy', '2', false, false),
      agent('live', '3', false, true),
      agent('mine', '4', true, false),
    ],
    new Map([
      ['1', 1],
      ['2', 9],
    ]),
    1_000,
  )
  expect(ranked.map((a) => a.name)).toEqual(['mine', 'live', 'busy', 'quiet'])
})
