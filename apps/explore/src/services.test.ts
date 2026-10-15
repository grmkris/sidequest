import { describe, expect, it } from 'vitest'
import { agentListings, askPrompt, isLive, priceOf, turnaround } from './services.ts'

const TOKEN = '0x6B56D64150818f91f5112B285e806ec6C78EADe8' as const
const NOW = 1_000_000

const presence = (freshness: 'fresh' | 'stale' | 'unknown', accepting: boolean) => ({
  freshness,
  state: null,
  accepting,
  lastSeenBucket: null,
})

describe('services', () => {
  it('prices a quote, an advertised zero and free testnet work without an amount, and anything else in its token', () => {
    expect(priceOf({ model: 'quote', amountBaseUnits: '5000000', token: TOKEN })).toEqual({ kind: 'quote' })
    expect(priceOf({ model: 'fixed', amountBaseUnits: '0', token: TOKEN })).toEqual({ kind: 'quote' })
    expect(priceOf({ model: 'free/testnet', amountBaseUnits: '0', token: TOKEN })).toEqual({ kind: 'free' })
    expect(priceOf({ model: 'per-unit', amountBaseUnits: '250000', token: TOKEN })).toEqual({
      kind: 'amount',
      value: '250000',
      token: TOKEN,
      perUnit: true,
    })
  })

  it('rounds turnaround the way people say it', () => {
    expect(turnaround(20)).toBe('~1 min')
    expect(turnaround(45 * 60)).toBe('~45 min')
    expect(turnaround(120 * 60)).toBe('~2 h')
    expect(turnaround(24 * 3600)).toBe('~24 h')
    expect(turnaround(72 * 3600)).toBe('~3 days')
  })

  it('counts an agent live on a fresh heartbeat that takes work, or an MCP call within the hour', () => {
    expect(isLive({ presence: presence('fresh', true), lastMcpCallAt: null }, NOW)).toBe(true)
    expect(isLive({ presence: presence('fresh', false), lastMcpCallAt: null }, NOW)).toBe(false)
    expect(isLive({ presence: presence('unknown', false), lastMcpCallAt: NOW - 3600 }, NOW)).toBe(true)
    expect(isLive({ presence: presence('stale', true), lastMcpCallAt: NOW - 3601 }, NOW)).toBe(false)
  })

  it('asks for a service with a public quote request that invites its agent', () => {
    expect(
      askPrompt('https://sidequest.exchange', { agentId: '2036', agentName: 'Grok Bot', name: 'Translation' }),
    ).toBe(
      'Read https://sidequest.exchange/start.md. Ask for quotes and invite agent 2036 (Grok Bot) to quote, for its “Translation” service: …',
    )
  })

  it('lists a directory agent’s live ads only, named after the agent', () => {
    const ad = (serviceId: string, expiresAt: number | null) => ({
      serviceId,
      name: serviceId,
      description: '',
      inputs: '',
      outputs: '',
      turnaroundSeconds: 600,
      price: { model: 'quote' as const, amountBaseUnits: '0', token: TOKEN },
      adHash: `0x${serviceId}` as const,
      expiresAt,
      category: 'writing' as const,
      tags: ['copy'],
      examples: ['A launch note'],
      samples: [{ url: '/samples/note.webp', caption: 'A launch note', kind: 'illustration' as const }],
      publishedAt: NOW - 60,
    })
    const agent: Parameters<typeof agentListings>[0] = {
      chainId: 10143,
      identityRegistry: TOKEN,
      agentId: '7',
      wallet: TOKEN,
      profile: { name: '', description: '', services: [] },
      profileSource: 'operator-supplied',
      agentURI: '',
      enrolled: true,
      ownership: 'verified',
      presence: presence('unknown', false),
      ads: [ad('live', NOW + 10), ad('durable', null), ad('gone', NOW)],
      activity: { lastMcpCallAt: NOW - 60 },
      observedAt: NOW,
      projectionAt: NOW,
      revision: 1,
    }
    const [only, ...rest] = agentListings(agent, NOW, 3)
    expect(rest.map((item) => item.serviceId)).toEqual(['durable'])
    expect(only).toMatchObject({
      serviceId: 'live',
      agentName: 'Agent #7',
      lastMcpCallAt: NOW - 60,
      delivered: 3,
      category: 'writing',
      tags: ['copy'],
      examples: ['A launch note'],
      samples: [{ url: '/samples/note.webp', caption: 'A launch note', kind: 'illustration' }],
      publishedAt: NOW - 60,
    })
    expect(agentListings(agent, NOW, 3).map((item) => item.serviceId)).toEqual(['live', 'durable'])
  })
})
