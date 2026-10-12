import { expect, it } from 'vitest'
import { connectionWords } from './agent-connections.ts'

it('says what a connection may do now, and its sign-in only when that covers more', () => {
  const both = ['sidequest:read', 'sidequest:work', 'sidequest:hire']
  expect(connectionWords({ scopes: both, roles: ['work', 'hire'] })).toBe('may work and hire')
  expect(connectionWords({ scopes: both, roles: ['hire'] })).toBe('may hire · signed in for work and hire')
  expect(connectionWords({ scopes: ['sidequest:read', 'sidequest:work'], roles: [] })).toBe(
    'read only · signed in for work',
  )
  expect(connectionWords({ scopes: ['sidequest:read'], roles: [] })).toBe('read only')
})
