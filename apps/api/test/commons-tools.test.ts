import { Match } from 'effect'
import { expect, it } from 'vitest'
import { hostedToolNames, readOnlyHostedTools } from '@sidequest/board'
import { commonsRoleTools, commonsToolNames, toolSpecs } from '@sidequest/commons'
import { commonsTools } from '../src/commons/tools.ts'
import { requiredToolScope, permittedTool, toolAnnotations } from '../src/mcp-policy.ts'
import { feedTools } from '../src/feed.ts'

it('keeps Commons names, scopes, admission and hand-reviewed effects consistent', () => {
  expect(Object.keys(commonsTools).toSorted()).toEqual([...commonsToolNames].toSorted())
  for (const [name, spec] of Object.entries(toolSpecs)) {
    expect(hostedToolNames.has(name), name).toBe(true)
    expect(readOnlyHostedTools.has(name), name).toBe(spec.scope === 'read')
    expect(requiredToolScope(name), name).toBe(
      Match.value(spec.scope).pipe(
        Match.when('read', () => 'sidequest:read'),
        Match.when('write', () => 'write'),
        Match.when('role', () => 'sidequest:maintain'),
        Match.exhaustive,
      ),
    )
    expect(toolAnnotations(name), name).toEqual({
      readOnlyHint: spec.review[0],
      destructiveHint: spec.review[1],
      idempotentHint: spec.review[2],
      openWorldHint: false,
    })
    expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:hire', 'sidequest:work'] }, name), name).toBe(
      spec.scope !== 'role',
    )
    // ADR-0028: only the operator's sidequest:maintain grant reaches a role tool, and it reaches nothing else.
    expect(
      permittedTool({ scopes: ['sidequest:read', 'sidequest:hire', 'sidequest:work', 'sidequest:maintain'] }, name),
      name,
    ).toBe(true)
    expect(permittedTool({ scopes: ['sidequest:maintain'] }, name), name).toBe(spec.scope === 'role')
    expect(commonsRoleTools.has(name), name).toBe(spec.scope === 'role')
  }
  for (const kind of [
    'message.posted',
    'message.mention',
    'message.reply',
    'roadmap.proposed',
    'roadmap.status',
    'gap.reported',
    'message.hidden',
  ])
    expect(feedTools.inbox.description).toContain(kind)
})

it('requires a Commons host for registry execution', () => {
  // SAFETY: the missing-host branch throws before reading the unused Board argument.
  expect(() =>
    commonsTools.list_messages!.run(
      {} as never,
      {},
      { subject: 'lobby' },
      { network: 'monad-testnet', mcpSession: undefined },
    ),
  ).toThrow('Commons host is unavailable')
})
