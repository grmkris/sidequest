import { expect, it } from 'vitest'
import {
  OPERATOR_CONTINUATIONS,
  effectiveRoles,
  listedTool,
  permittedTool,
  toolDecision,
  toolRefusal,
  toolAnnotations,
} from '../src/mcp-policy.ts'

const both = ['sidequest:read', 'sidequest:hire', 'sidequest:work']

it('discovers direct quote-request reads under read scope with read-only annotations', () => {
  expect(toolDecision({ scopes: ['sidequest:read'], roles: [] }, 'get_quote_request')).toBe('allow')
  expect(listedTool({ scopes: ['sidequest:read'], roles: [], listening: true }, 'get_quote_request')).toBe(true)
  expect(toolAnnotations('get_quote_request')).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
})

// ADR-0021: a connection does what its scope and its agent's roles both allow.
it('decides by scope first, then by the agent’s roles for tools that start new work', () => {
  const worker = { scopes: both, roles: ['work'] as const }
  expect(toolDecision(worker, 'apply')).toBe('allow')
  expect(toolDecision(worker, 'create_task')).toBe('role')
  expect(toolDecision(worker, 'request_quotes')).toBe('role')
  // Finishing what it posted, settling and reading never need the role.
  for (const name of ['approve_work', 'cancel_task', 'settlement_actions', 'get_task', 'request_role'])
    expect(toolDecision(worker, name)).toBe('allow')
  expect(toolDecision({ scopes: ['sidequest:read'], roles: ['work', 'hire'] }, 'apply')).toBe('scope')
  expect(toolDecision({ scopes: both, roles: [] }, 'submit_quote')).toBe('role')
  expect(toolDecision({ scopes: both, roles: [] }, 'submit_selection', true)).toBe('allow')
  expect(toolDecision({ scopes: both }, 'create_task')).toBe('allow')
  expect(toolDecision({ scopes: ['sidequest:setup'], setup: true, roles: [] }, 'apply')).toBe('wait')
  expect(toolDecision({ scopes: ['sidequest:setup'], setup: true, roles: [] }, 'create_agent')).toBe('allow')
})

it('says what a connection may do now: its scope and its agent’s roles together', () => {
  expect(effectiveRoles({ scopes: both, roles: ['hire'] })).toEqual(['hire'])
  expect(effectiveRoles({ scopes: ['sidequest:read', 'sidequest:work'], roles: ['work', 'hire'] })).toEqual(['work'])
  expect(effectiveRoles({ scopes: both })).toEqual(['work', 'hire'])
  expect(effectiveRoles({ scopes: ['sidequest:setup'], setup: true, roles: [] })).toEqual([])
})

it('lists exactly what a listening connection may call, and everything its scope covers otherwise', () => {
  const hirer = { scopes: both, roles: ['hire'] as const }
  expect(listedTool(hirer, 'apply')).toBe(true)
  expect(listedTool({ ...hirer, listening: true }, 'apply')).toBe(false)
  expect(listedTool({ ...hirer, listening: true }, 'create_task')).toBe(true)
  expect(listedTool({ ...hirer, listening: true }, 'submit_work')).toBe(true)
  const setup = { scopes: ['sidequest:setup'], setup: true, roles: [] }
  expect(listedTool(setup, 'apply')).toBe(true)
  expect(listedTool({ ...setup, listening: true }, 'apply')).toBe(false)
  expect(listedTool({ ...setup, listening: true }, 'create_agent')).toBe(true)
})

// A role granted after a narrower sign-in must still reach the connection: its tools are listed and step up on call.
it('lists the tools of a role the agent holds beyond the sign-in, so a call steps up', () => {
  const narrow = { scopes: ['sidequest:read', 'sidequest:hire'], roles: ['hire', 'work'] as const }
  for (const listening of [false, true]) {
    expect(listedTool({ ...narrow, listening }, 'apply')).toBe(true)
    expect(listedTool({ ...narrow, listening }, 'submit_work')).toBe(true)
    expect(toolRefusal({ ...narrow, listening }, 'apply')).toEqual({
      stepUp: 'sidequest:read sidequest:hire sidequest:work',
    })
  }
  expect(listedTool({ scopes: ['sidequest:read', 'sidequest:hire'], roles: ['hire'] }, 'apply')).toBe(false)
  expect(listedTool({ scopes: ['sidequest:read'], roles: ['work'] }, 'settlement_actions')).toBe(true)
  expect(listedTool({ scopes: ['sidequest:read'], roles: [] }, 'settlement_actions')).toBe(false)
  expect(listedTool({ scopes: ['sidequest:setup'], setup: true, roles: [] }, 'create_task')).toBe(true)
})

it('refuses a missing role with a plain tool error that names request_role', () => {
  expect(toolRefusal({ scopes: both, roles: ['work'] }, 'create_task')).toEqual({
    result: {
      content: [
        {
          type: 'text',
          text: 'role-required: your operator has not allowed this agent to hire other agents. Call request_role with {"role":"hire"} to ask; work it already started can still finish.',
        },
      ],
      structuredContent: {
        ok: false,
        code: 'role-required',
        role: 'hire',
        next: { tool: 'request_role', args: { role: 'hire' } },
      },
      isError: true,
    },
  })
  expect(toolRefusal({ scopes: both, roles: ['work'] }, 'apply')).toBeUndefined()
})

// Reopening a declined pick is the hosted executor's job, never a client's.
it('never lists or offers release_pick to a client, and lets only the executor run it', () => {
  for (const listening of [false, true]) {
    expect(listedTool({ scopes: both, roles: ['work', 'hire'], listening }, 'release_pick')).toBe(false)
    expect(toolDecision({ scopes: both, roles: ['work', 'hire'], listening }, 'release_pick')).toBe('scope')
  }
  expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:hire'] }, 'release_pick', true)).toBe(true)
  expect(OPERATOR_CONTINUATIONS.has('release_pick')).toBe(true)
})
