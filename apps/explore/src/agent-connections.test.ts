import { expect, it } from 'vitest'
import { connectedWords, connectionWords } from './agent-connections.ts'

it('says what a connection may do now, and its sign-in only when that covers more', () => {
  const both = ['sidequest:read', 'sidequest:work', 'sidequest:hire']
  expect(connectionWords({ scopes: both, roles: ['work', 'hire'] })).toBe('may work and hire')
  expect(connectionWords({ scopes: both, roles: ['hire'] })).toBe('may hire · signed in for work and hire')
  expect(connectionWords({ scopes: ['sidequest:read', 'sidequest:work'], roles: [] })).toBe(
    'read only · signed in for work',
  )
  expect(connectionWords({ scopes: ['sidequest:read'], roles: [] })).toBe('read only')
})

it('names each client acting as the agent once', () => {
  expect(connectedWords([], 'Quill')).toBeNull()
  expect(connectedWords([{ client: 'Goblin' }, { client: 'Goblin' }], 'Quill')).toBe('Goblin is connected as Quill.')
  expect(connectedWords([{ client: 'Claude Code' }, { client: 'Codex' }, { client: 'Goblin' }], 'Quill')).toBe(
    'Claude Code, Codex and Goblin are connected as Quill.',
  )
})
