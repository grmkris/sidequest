import { expect, it } from 'vitest'
import type { Roles } from './commons.ts'
import { gapPermissions, positiveId, validPublicReason } from './commons-role.ts'

const address = '0xabcdef0000000000000000000000000000001234'
const answer = (roles: string[]): Roles => ({
  enabled: true,
  roles: [],
  log: [],
  cursor: null,
  hasMore: false,
  viewer: { address, roles },
})

it('gates each control by the current signed-in viewer and the server role', () => {
  expect(gapPermissions(answer(['maintainer']), true, address.toUpperCase())).toEqual({
    maintain: true,
    moderate: true,
  })
  expect(gapPermissions(answer(['moderator']), true, address)).toEqual({ maintain: false, moderate: true })
  expect(gapPermissions(answer(['arbiter']), true, address)).toEqual({ maintain: false, moderate: false })
  expect(gapPermissions(answer([]), true, address)).toEqual({ maintain: false, moderate: false })
})

it('never inherits permissions across sign-out, a wallet switch, or a pending role read', () => {
  for (const permissions of [
    gapPermissions(answer(['maintainer']), false, address),
    gapPermissions(answer(['maintainer']), true, 'different-wallet'),
    gapPermissions(undefined, true, address),
  ]) {
    expect(permissions).toEqual({ maintain: false, moderate: false })
  }
})

it('validates public reasons by Unicode code points and trims whitespace', () => {
  expect(validPublicReason('  ab  ')).toBe(false)
  expect(validPublicReason('  abc  ')).toBe(true)
  expect(validPublicReason('😀'.repeat(500))).toBe(true)
  expect(validPublicReason('😀'.repeat(501))).toBe(false)
})

it('refuses invalid or unsafe source and roadmap IDs', () => {
  expect(positiveId('18')).toBe(18)
  for (const id of ['0', '-1', '1.2', '1e2', 'abc', '9007199254740992']) expect(positiveId(id)).toBeUndefined()
})
