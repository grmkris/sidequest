import { Schema } from 'effect'
import { expect, it } from 'vitest'
import { parseEther } from 'viem'
import { BackingRequestInput, backingUrl, requestBacking, type BackingReads } from '../src/agent-backing-request.ts'
import { agentTools } from '../src/tools-agents.ts'
import { permittedTool, requiredToolScope, toolAnnotations } from '../src/mcp-policy.ts'

const wallet = '0x722e08f76708c5ec987cd596c83522ccef86a78b'
const agent = { address: wallet, agent_id: '2194' }
const origin = 'https://dev.sidequest.exchange'
const reads = (available: string): BackingReads => ({
  minimum: async () => parseEther('10'),
  available: async () => parseEther(available),
})
const ask = (available: string, request: { amount?: string } = {}) =>
  requestBacking({ reads: reads(available), agent, origin, request })

it('gives an unbacked agent the shortfall and the link that fills it in', async () => {
  expect(await ask('0')).toMatchObject({
    state: 'needs-backing',
    available: '0',
    minimum: '10',
    short: '10',
    approveUrl: 'https://dev.sidequest.exchange/agent/2194?back=10',
  })
})

it('asks only for the difference, and for more when a larger bond is wanted', async () => {
  expect((await ask('4')).short).toBe('6')
  expect((await ask('4', { amount: '25' })).short).toBe('21')
  // Below the floor, the floor still counts.
  expect((await ask('4', { amount: '1' })).wanted).toBe('10')
})

it('says backed with no link once the floor is free', async () => {
  const answer = await ask('12.5')
  expect(answer).toMatchObject({ state: 'backed', short: '0' })
  expect(answer.approveUrl).toBeUndefined()
})

it('refuses an unregistered agent, and any amount but a decimal', async () => {
  await expect(
    requestBacking({ reads: reads('0'), agent: { address: null, agent_id: null }, origin, request: {} }),
  ).rejects.toMatchObject({ code: 'conflict' })
  const decode = Schema.decodeUnknownSync(BackingRequestInput)
  expect(decode({ amount: '7.5' })).toEqual({ amount: '7.5' })
  expect(() => decode({ amount: '1e3' })).toThrow()
  expect(() => decode({ amount: 10 })).toThrow()
  expect(() => decode({ amount: '1', role: 'hire' }, { onExcessProperty: 'error' })).toThrow()
})

it('builds the backing link Explore reads', () => {
  expect(backingUrl(origin, '2194', parseEther('7.5'))).toBe('https://dev.sidequest.exchange/agent/2194?back=7.5')
})

it('is a read any connection may call', () => {
  expect(Object.hasOwn(agentTools, 'request_backing')).toBe(true)
  expect(requiredToolScope('request_backing')).toBe('sidequest:read')
  expect(permittedTool({ scopes: ['sidequest:read'] }, 'request_backing')).toBe(true)
  expect(toolAnnotations('request_backing')).toMatchObject({ readOnlyHint: true, destructiveHint: false })
})
