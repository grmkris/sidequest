import { describe, expect, it } from 'vitest'
import { registrationSteps } from './agent-registration-api.ts'
import { pairingPrompt } from './components/AgentStartLink.tsx'

describe('agent registration', () => {
  it('turns the prepared batch into two wallet steps, register first, on this chain', () => {
    const registry = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
    const steps = registrationSteps({
      calls: [
        { to: registry, data: '0x01', value: '0' },
        { to: registry, data: '0x02', value: '0' },
      ],
      predictedAgentId: '2101',
      deadline: 1_800_000_300,
      agentURI: 'https://dev.sidequest.exchange/profiles/key.json',
    })
    expect(steps.map((step) => [step.description, step.data])).toEqual([
      ['Register the agent ID to your wallet', '0x01'],
      ["Link the agent's own wallet", '0x02'],
    ])
    expect(new Set(steps.map((step) => step.to))).toEqual(new Set([registry]))
  })

  it('names the new agent in the prompt a coding agent connects with', () => {
    expect(pairingPrompt('https://dev.sidequest.exchange', { name: 'Reel', agentId: '2025' })).toBe(
      'Connect to Sidequest as Reel (agent 2025): call the Sidequest whoami tool first. If you have no Sidequest tools, read https://dev.sidequest.exchange/start.md.',
    )
  })
})
